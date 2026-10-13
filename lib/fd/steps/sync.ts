// lib/fd/steps/sync.ts
// STEP "sync": stores the fixtures of the next matchday (game week).
// Per competition: 1 call for a 9-day window, plus 1 call for the whole
// group when one is ready. Competitions out of season cost nothing.
// Nothing here makes a prediction.

import { fdGet, toISODate } from '../client';
import type { FdMatchList } from '../client';
import { LOOKAHEAD_DAYS, LOOKBACK_DAYS, SYNC_BUDGET_MS } from '../config';
import { classifyGroup, expectedSize, matchdayOf, planGroups, stageOf } from '../plan';
import type { MdMatch } from '../matchday';
import {
  getFixtureDates,
  getTeamStats,
  insertFixtures,
  listCompetitions,
  markSyncChecked,
  markVoid,
  updateFixtureDate,
} from '../store';
import type { CompetitionRow, NewFixture } from '../store';

export type SyncOptions = { comps: string[]; rotate: boolean; deadline?: number };

const DAY = 86400000;

async function syncOne(row: CompetitionRow): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { comp: row.code };
  const now = Date.now();
  const from = toISODate(new Date(now - LOOKBACK_DAYS * DAY));
  const to = toISODate(new Date(now + LOOKAHEAD_DAYS * DAY));

  const win = ((await fdGet<FdMatchList>('/competitions/' + row.code + '/matches?dateFrom=' + from + '&dateTo=' + to))
    .data.matches || []) as MdMatch[];
  out.window_matches = win.length;
  if (win.length === 0) {
    out.note = 'no matches in the window';
    return out;
  }

  const known = await getFixtureDates(win.map((m) => m.id));
  if (!known.ok) return { ...out, ok: false, error: known.error };
  const stored = new Set<number>(Array.from(known.data.keys()));

  // Reschedules and cancellations of matches we already hold.
  let moved = 0;
  let voided = 0;
  for (const m of win) {
    const s = known.data.get(m.id);
    if (!s || s.status !== 'pending') continue;
    if (m.status === 'CANCELLED') {
      const r = await markVoid(m.id, 'cancelled');
      if (r.ok && r.data) voided++;
    } else if (Date.parse(s.match_date) !== Date.parse(m.utcDate)) {
      const r = await updateFixtureDate(m.id, m.utcDate);
      if (r.ok && r.data) moved++;
    }
  }
  if (moved) out.rescheduled = moved;
  if (voided) out.cancelled_voided = voided;

  const plans = planGroups(win, stored, now);
  const ready = plans.filter((p) => p.eligible);
  const waiting = plans.filter((p) => !p.eligible);
  if (waiting.length) {
    out.waiting = waiting.map((p) => ({
      group: p.stage + ' md' + p.matchday,
      first_kickoff: p.firstKickoff,
      blocked_by: p.blockedBy,
      opens_after: p.opensAfter,
    }));
  }
  if (ready.length === 0) {
    if (waiting.length === 0) {
      const groupsInWindow = new Set(win.map((m) => stageOf(m) + '|' + matchdayOf(m))).size;
      out.note =
        'nothing new to store: ' + groupsInWindow + ' group(s) in the window, all already stored or already played';
    }
    return out;
  }

  const g = ready[0];
  out.groups_ready = ready.length;

  // The whole group in one call, so no match of the matchday can be missed
  // (a Monday game can fall outside the window).
  const full = ((await fdGet<FdMatchList>(
    '/competitions/' + row.code + '/matches?season=' + row.season_year +
      '&stage=' + encodeURIComponent(g.stage) + '&matchday=' + g.matchday
  )).data.matches || []) as MdMatch[];

  const fullKnown = await getFixtureDates(full.map((m) => m.id));
  if (!fullKnown.ok) return { ...out, ok: false, error: fullKnown.error };
  const { toInsert, counts } = classifyGroup(full, new Set<number>(Array.from(fullKnown.data.keys())), now);

  const rows: NewFixture[] = toInsert.map((m) => ({
    fd_match_id: m.id,
    comp_code: row.code,
    season_year: row.season_year,
    stage: stageOf(m),
    matchday: matchdayOf(m),
    match_date: m.utcDate,
    home_id: m.homeTeam.id,
    home_name: m.homeTeam.name || String(m.homeTeam.id),
    away_id: m.awayTeam.id,
    away_name: m.awayTeam.name || String(m.awayTeam.id),
  }));
  const ins = await insertFixtures(rows);
  if (!ins.ok) return { ...out, ok: false, error: ins.error };

  const teams = await getTeamStats(row.code, row.season_year);
  const expected = expectedSize(g.stage, teams.ok ? teams.data.length : 0);
  const sum =
    counts.inserted + counts.already_stored + counts.past_ignored + counts.postponed + counts.cancelled + counts.other;
  out.synced = {
    group: g.stage + ' md' + g.matchday,
    counts,
    new_rows_written: ins.data,
    expected_size: expected,
    incomplete: expected !== null && counts.fetched < expected,
    partial_group: counts.past_ignored > 0,
    accounting_ok: sum === counts.fetched && ins.data === counts.inserted,
  };
  out.ok = true;
  return out;
}

export async function runSyncStep(opts: SyncOptions): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const list = await listCompetitions();
  if (!list.ok) return { ok: false, error: list.error };

  let active = list.data.filter((r) => opts.comps.indexOf(r.code) !== -1 && r.in_season);
  const skipped = opts.comps.filter((c) => !active.some((r) => r.code === c));
  if (opts.rotate) {
    // Longest-unchecked first (never checked = first), so every competition
    // is reached no matter when or how often this is called.
    active = active.slice().sort((a, b) => {
      const x = a.sync_checked_at ? Date.parse(a.sync_checked_at) : 0;
      const y = b.sync_checked_at ? Date.parse(b.sync_checked_at) : 0;
      return x - y;
    });
  }

  const results: Record<string, unknown>[] = [];
  for (const row of active) {
    if (Date.now() > (opts.deadline ?? t0 + SYNC_BUDGET_MS)) break;
    const res = await syncOne(row);
    results.push(res);
    if (res.ok !== false) await markSyncChecked(row.code);
  }
  return {
    ok: true,
    checked: results.length,
    not_checked_this_run: active.length - results.length,
    not_in_season_or_unknown: skipped,
    results,
  };
}
