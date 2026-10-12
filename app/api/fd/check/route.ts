// app/api/fd/check/route.ts
// STAGE 0 data proof. Read-only: stores nothing, returns a small summary.
// Open: /api/fd/check?secret=<DISPATCH_SECRET>&comp=PL   (add &prev=1 to also test last season)

import { NextResponse } from 'next/server';
import {
  getCompetition,
  getFinishedSeason,
  getScheduled,
  getStandings,
  getTeamFinished,
  toISODate,
} from '../../../../lib/fd/client';
import { averagesByTeam, isWithinSeason, totalsByTeam } from '../../../../lib/fd/stats';
import type { FdMatch } from '../../../../lib/fd/stats';
import { calibratedScores, goalsLabel } from '../../../../lib/correctScore';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const VERSION = 'fd-check-1';
const BUDGET_MS = 45000; // stop starting new calls after this

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!process.env.DISPATCH_SECRET || url.searchParams.get('secret') !== process.env.DISPATCH_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const code = (url.searchParams.get('comp') || 'PL').toUpperCase();
  const testPrev = url.searchParams.get('prev') === '1';
  const t0 = Date.now();
  const out: Record<string, unknown> = { route_version: VERSION, comp: code };
  const checks: Record<string, boolean> = {};
  const stop = () => Date.now() - t0 > BUDGET_MS;

  try {
    // 1) competition + seasons
    const comp = (await getCompetition(code)).data;
    const cur = comp.currentSeason;
    if (!cur) {
      out.error = 'no currentSeason returned';
      return NextResponse.json(out);
    }
    const seasons = (comp.seasons || []).slice().sort((a, b) => b.startDate.localeCompare(a.startDate));
    const year = cur.startDate.slice(0, 4);
    out.seasons_listed = seasons.map((s) => s.startDate.slice(0, 4));
    out.current_season = { start: cur.startDate, end: cur.endDate };

    // 2) one call: whole season of finished matches
    const fin = await getFinishedSeason(code, year);
    const matches: FdMatch[] = fin.data.matches || [];
    const avgs = averagesByTeam(matches);
    out.season_call = {
      matches_returned: matches.length,
      result_set: fin.data.resultSet || null,
      approx_kb: Math.round(JSON.stringify(fin.data).length / 1024),
      teams: avgs.size,
      api_calls_left_this_minute: fin.requestsAvailable,
    };
    checks.season_returned_matches = matches.length > 0;
    checks.count_matches_result_set =
      fin.data.resultSet?.count === undefined || fin.data.resultSet.count === matches.length;

    // 3) our totals vs the standings table (TOTAL)
    if (!stop()) {
      const st = (await getStandings(code, year)).data;
      const table = (st.standings || []).find((s) => s.type === 'TOTAL')?.table || [];
      const totals = totalsByTeam(matches);
      const bad: string[] = [];
      for (const row of table) {
        const t = totals.get(row.team.id);
        if (!t || t.played !== row.playedGames || t.scored !== row.goalsFor || t.conceded !== row.goalsAgainst) {
          bad.push(
            (row.team.name || row.team.id) +
              ' table ' + row.playedGames + '/' + row.goalsFor + '/' + row.goalsAgainst +
              ' ours ' + (t ? t.played + '/' + t.scored + '/' + t.conceded : 'missing')
          );
        }
      }
      out.standings_check = { teams_in_table: table.length, mismatches: bad.length, first_mismatches: bad.slice(0, 5) };
      checks.standings_match = table.length > 0 && bad.length === 0;
    }

    // 4) next 7 days through correctScore
    let sampleTeamId: number | null = null;
    if (!stop()) {
      const from = new Date();
      const to = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const sch = (await getScheduled(code, toISODate(from), toISODate(to))).data;
      const fx = sch.matches || [];
      out.upcoming_fixtures_in_7_days = fx.length;
      const sample = fx.slice(0, 3).map((m) => {
        const h = avgs.get(m.homeTeam.id);
        const a = avgs.get(m.awayTeam.id);
        const base = { match: (m.homeTeam.name || '?') + ' - ' + (m.awayTeam.name || '?'), date: m.utcDate };
        if (!h || !a || h.avgScored === null || h.avgConceded === null || a.avgScored === null || a.avgConceded === null) {
          return { ...base, note: 'team has no finished matches this season (fallback tiers needed, Stage 1)' };
        }
        const nums = [h.avgScored.toFixed(2), h.avgConceded.toFixed(2), a.avgScored.toFixed(2), a.avgConceded.toFixed(2)];
        const cs = calibratedScores(nums[0], nums[1], nums[2], nums[3]);
        return {
          ...base,
          four_numbers: nums.join(','),
          games_played: h.played + ' / ' + a.played,
          formula1: cs ? goalsLabel(cs.prod.home) + '-' + goalsLabel(cs.prod.away) : null,
          formula2: cs ? goalsLabel(cs.exp.home) + '-' + goalsLabel(cs.exp.away) : null,
        };
      });
      out.correctScore_sample = sample;
      checks.correctScore_ran = sample.length > 0 && sample.every((s) => 'formula1' in s && s.formula1 !== null);
      if (fx[0]) sampleTeamId = fx[0].homeTeam.id;
    }
    if (sampleTeamId === null) {
      const first = Array.from(avgs.keys())[0];
      sampleTeamId = first === undefined ? null : first;
    }

    // 5) our one-call average vs the proven per-team method
    if (!stop() && sampleTeamId !== null) {
      const prevStart = seasons[1]?.startDate || cur.startDate;
      const pool = (await getTeamFinished(sampleTeamId, prevStart, toISODate(new Date()))).data.matches || [];
      const inSeason = pool.filter(
        (m) => m.competition?.code === code && isWithinSeason(m.utcDate, cur.startDate, cur.endDate)
      );
      const his = averagesByTeam(inSeason).get(sampleTeamId);
      const ours = avgs.get(sampleTeamId);
      out.per_team_cross_check = {
        team: ours?.name,
        one_call: ours ? ours.avgScored + ' / ' + ours.avgConceded + ' (' + ours.played + ' games)' : null,
        per_team_call: his ? his.avgScored + ' / ' + his.avgConceded + ' (' + his.played + ' games)' : null,
      };
      checks.per_team_matches =
        !!ours && !!his && ours.avgScored === his.avgScored && ours.avgConceded === his.avgConceded && ours.played === his.played;
    }

    // 6) optional: does the free tier return last season?
    if (testPrev && !stop() && seasons[1]) {
      const py = seasons[1].startDate.slice(0, 4);
      const prev = await getFinishedSeason(code, py);
      out.previous_season_call = {
        season: py,
        matches_returned: prev.data.matches?.length || 0,
        result_set: prev.data.resultSet || null,
      };
      checks.previous_season_available = (prev.data.matches?.length || 0) > 0;
    }

    out.stopped_early = stop();
    out.checks = checks;
    out.all_passed = Object.values(checks).length > 0 && Object.values(checks).every(Boolean);
    out.seconds = Math.round((Date.now() - t0) / 100) / 10;
    return NextResponse.json(out);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    out.checks = checks;
    return NextResponse.json(out, { status: 500 });
  }
}
