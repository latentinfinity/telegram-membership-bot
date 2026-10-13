// lib/fd/steps/stats.ts
// STEP "stats": season totals per team for one competition per request.
//  - phase "current": info + season matches + standings (3 calls). Totals are
//    saved ONLY if they match the official table for every team.
//  - phase "prev": last season's totals + standings (2 calls), fetched once,
//    needed for the fallback of teams with no games yet / promoted teams.
// Out-of-season competitions cost one call and are marked in_season = false.

import { getCompetition, getFinishedSeason, getStandings, toISODate } from '../client';
import { COOLDOWN_MINUTES, DEFAULT_MAX_AGE_HOURS, NO_PREV, STALE_REFRESH_HOURS } from '../config';
import { totalsByTeam } from '../stats';
import type { FdMatch, TeamTotals } from '../stats';
import {
  getTeamStats,
  listCompetitions,
  listPredictable,
  markStatsSynced,
  saveTeamStats,
  upsertCompetition,
} from '../store';
import type { CompetitionRow, TeamStatRow } from '../store';

export type StatsOptions = { comps: string[]; force: boolean; maxAgeHours?: number };

type WithStage = FdMatch & { stage?: string };
export type TableRow = {
  team: { id: number; name?: string };
  playedGames: number;
  goalsFor: number;
  goalsAgainst: number;
};

// ── Pure helpers (tested in the sandbox) ──────────────────────────────────
// Compares our totals with the official table. Teams missing from our
// matches count as 0/0/0. Returns a list of differences (empty = match).
export function verifyTotals(matches: FdMatch[], table: TableRow[]): string[] {
  const ours = totalsByTeam(matches);
  const bad: string[] = [];
  const inTable = new Set<number>();
  for (const row of table) {
    inTable.add(row.team.id);
    const t = ours.get(row.team.id);
    const p = t ? t.played : 0;
    const f = t ? t.scored : 0;
    const a = t ? t.conceded : 0;
    if (p !== row.playedGames || f !== row.goalsFor || a !== row.goalsAgainst) {
      bad.push(
        (row.team.name || row.team.id) +
          ' table ' + row.playedGames + '/' + row.goalsFor + '/' + row.goalsAgainst +
          ' ours ' + p + '/' + f + '/' + a
      );
    }
  }
  ours.forEach(function (t, id) {
    if (!inTable.has(id) && t.played > 0) bad.push((t.name || id) + ' is not in the table');
  });
  return bad;
}

// One row per team in the table (0 games included) plus any team that
// appears in the matches but not in the table.
export function buildStatRows(
  comp: string,
  season: string,
  totals: Map<number, TeamTotals>,
  table: TableRow[]
): TeamStatRow[] {
  const rows: TeamStatRow[] = [];
  const seen = new Set<number>();
  for (const r of table) {
    seen.add(r.team.id);
    const t = totals.get(r.team.id);
    rows.push({
      comp_code: comp,
      season_year: season,
      team_id: r.team.id,
      team_name: r.team.name || String(r.team.id),
      played: t ? t.played : 0,
      scored: t ? t.scored : 0,
      conceded: t ? t.conceded : 0,
    });
  }
  totals.forEach(function (t, id) {
    if (seen.has(id)) return;
    rows.push({
      comp_code: comp,
      season_year: season,
      team_id: id,
      team_name: t.name,
      played: t.played,
      scored: t.scored,
      conceded: t.conceded,
    });
  });
  return rows;
}

// The TOTAL standings entries of the first stage (a league table, the CL
// league phase, or all groups of a tournament), joined into one table.
export function pickTotalTable(
  standings: { type: string; stage?: string; table?: TableRow[] }[]
): { stage: string | undefined; table: TableRow[] } {
  const totals = standings.filter((s) => s.type === 'TOTAL');
  if (totals.length === 0) return { stage: undefined, table: [] };
  const stage = totals[0].stage;
  const table: TableRow[] = [];
  for (const s of totals) if (s.stage === stage) table.push(...(s.table || []));
  return { stage, table };
}

// Matches that belong to the stage the table describes. Used ONLY for the
// check; the saved totals use every finished match of the season.
export function matchesForTable(matches: WithStage[], stage: string | undefined): FdMatch[] {
  const hasStage = matches.some((m) => m.stage !== undefined);
  if (!stage || !hasStage) return matches;
  return matches.filter((m) => m.stage === stage);
}

// ── Choosing the work ─────────────────────────────────────────────────────
type Work = { code: string; phase: 'current' | 'prev'; row: CompetitionRow | null };

function failedRecently(row: CompetitionRow | null, now: number): boolean {
  if (!row) return false;
  const upd = Date.parse(row.updated_at);
  const syn = row.stats_synced_at ? Date.parse(row.stats_synced_at) : 0;
  return (!row.stats_synced_at || upd - syn > 60000) && now - upd < COOLDOWN_MINUTES * 60000;
}

async function findWork(opts: StatsOptions): Promise<{ work: Work[]; error?: string }> {
  const list = await listCompetitions();
  if (!list.ok) return { work: [], error: list.error };
  const byCode = new Map<string, CompetitionRow>();
  for (const r of list.data) byCode.set(r.code, r);
  const maxAge = (opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS) * 3600000;
  const now = Date.now();
  const work: Work[] = [];

  // Stats must be refreshed AFTER new fixtures were stored (so the previous
  // matchday is in the totals), and every few hours while a prediction
  // still carries a stale note.
  const mustBeNewerThan = new Map<string, number>();
  const waiting = await listPredictable(300);
  if (waiting.ok) {
    for (const f of waiting.data) {
      const need =
        f.predicted_at === null ? Date.parse(f.created_at) : now - STALE_REFRESH_HOURS * 3600000;
      const have = mustBeNewerThan.get(f.comp_code);
      if (have === undefined || need > have) mustBeNewerThan.set(f.comp_code, need);
    }
  }

  for (const code of opts.comps) {
    const row = byCode.get(code) || null;
    const newer = mustBeNewerThan.get(code);
    const ageStale =
      !row ||
      !row.stats_synced_at ||
      now - Date.parse(row.stats_synced_at) > maxAge ||
      (newer !== undefined && Date.parse(row.stats_synced_at) < newer);
    if (!opts.force && failedRecently(row, now)) continue;
    if (opts.force || ageStale) {
      work.push({ code, phase: 'current', row });
      continue;
    }
    if (row && row.in_season && NO_PREV.indexOf(code) === -1) {
      const prevYear = String(Number(row.season_year) - 1);
      const have = await getTeamStats(code, prevYear);
      if (have.ok && have.data.length === 0) work.push({ code, phase: 'prev', row });
    }
  }
  return { work };
}

// ── The step ──────────────────────────────────────────────────────────────
export type StatsResult = Record<string, unknown>;

function baseOf(row: CompetitionRow) {
  return {
    code: row.code,
    name: row.name,
    comp_type: row.comp_type,
    season_year: row.season_year,
    season_start: row.season_start,
    season_end: row.season_end,
    in_season: row.in_season,
  };
}

export async function runStatsStep(opts: StatsOptions): Promise<StatsResult> {
  const found = await findWork(opts);
  if (found.error) return { ok: false, error: found.error };
  if (found.work.length === 0) return { ok: true, done: true, remaining: 0, note: 'nothing to refresh' };

  const w = found.work[0];
  const remaining = found.work.length - 1;
  const out: StatsResult = { comp: w.code, phase: w.phase, remaining };

  if (w.phase === 'prev' && w.row) {
    const row = w.row;
    const prevYear = String(Number(row.season_year) - 1);
    const fin = await getFinishedSeason(w.code, prevYear);
    const matches = fin.data.matches || [];
    out.season = prevYear;
    out.matches = matches.length;
    if (matches.length === 0) {
      out.ok = true;
      out.note = 'no previous season data returned';
      await upsertCompetition(baseOf(row));
      return out;
    }
    const st = await getStandings(w.code, prevYear);
    const picked = pickTotalTable(st.data.standings || []);
    const bad = verifyTotals(matchesForTable(matches, picked.stage), picked.table);
    if (picked.table.length === 0 || bad.length > 0) {
      await upsertCompetition(baseOf(row));
      out.ok = false;
      out.blocked = true;
      out.reason = picked.table.length === 0 ? 'no standings table to verify against' : 'totals differ from the table';
      out.first_differences = bad.slice(0, 5);
      return out;
    }
    const saved = await saveTeamStats(buildStatRows(w.code, prevYear, totalsByTeam(matches), picked.table));
    out.ok = saved.ok;
    out.teams_saved = saved.ok ? saved.data : 0;
    if (!saved.ok) out.error = saved.error;
    return out;
  }

  // phase "current"
  const info = (await getCompetition(w.code)).data;
  const cur = info.currentSeason;
  const nowIso = new Date().toISOString();
  const today = toISODate(new Date());
  if (!cur) {
    await upsertCompetition({
      code: w.code, name: info.name, comp_type: info.type, season_year: '0000',
      season_start: today, season_end: today, in_season: false, stats_synced_at: nowIso,
    });
    out.ok = true;
    out.note = 'no current season returned';
    return out;
  }
  const year = cur.startDate.slice(0, 4);
  const inSeason = today >= cur.startDate && today <= cur.endDate;
  const base = {
    code: w.code, name: info.name, comp_type: info.type, season_year: year,
    season_start: cur.startDate, season_end: cur.endDate, in_season: inSeason,
  };
  out.season = year;
  out.in_season = inSeason;
  if (!inSeason) {
    await upsertCompetition({ ...base, stats_synced_at: nowIso });
    out.ok = true;
    out.note = 'out of season, no stats fetched';
    return out;
  }

  const fin = await getFinishedSeason(w.code, year);
  const matches = (fin.data.matches || []) as WithStage[];
  out.matches = matches.length;
  out.approx_kb = Math.round(JSON.stringify(fin.data).length / 1024);
  const nonRegular = matches.filter(
    (m) => (m as unknown as { score?: { duration?: string } }).score?.duration !== undefined &&
      (m as unknown as { score?: { duration?: string } }).score?.duration !== 'REGULAR'
  ).length;
  out.extra_time_or_penalty_matches = nonRegular;

  const st = await getStandings(w.code, year);
  const picked = pickTotalTable(st.data.standings || []);
  const bad = verifyTotals(matchesForTable(matches, picked.stage), picked.table);
  if (picked.table.length === 0 || bad.length > 0) {
    await upsertCompetition(base);
    out.ok = false;
    out.blocked = true;
    out.reason = picked.table.length === 0 ? 'no standings table to verify against' : 'totals differ from the table';
    out.first_differences = bad.slice(0, 5);
    return out;
  }
  const saved = await saveTeamStats(buildStatRows(w.code, year, totalsByTeam(matches), picked.table));
  if (!saved.ok) {
    await upsertCompetition(base);
    out.ok = false;
    out.error = saved.error;
    return out;
  }
  await upsertCompetition({ ...base, stats_synced_at: nowIso });
  await markStatsSynced(w.code);
  out.ok = true;
  out.teams_saved = saved.data;
  out.verified_against_table = true;
  return out;
}
