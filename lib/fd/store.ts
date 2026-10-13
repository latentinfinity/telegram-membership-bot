// lib/fd/store.ts
// The ONLY file that reads or writes the fd_* tables. Never throws:
// every function returns { ok: true, data } or { ok: false, error }.
// Narrow selects only. Predictions are frozen: once predicted_at is set,
// nothing here overwrites the averages or the formula scores.

import { createAdminClient } from '../supabase/admin';

async function db() {
  return await createAdminClient();
}

export type R<T> = { ok: true; data: T } | { ok: false; error: string };

function fail<T>(e: unknown): R<T> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}
function dbFail<T>(message: string): R<T> {
  return { ok: false, error: message };
}

// ── Competitions ──────────────────────────────────────────────────────────
export type CompetitionRow = {
  code: string;
  name: string;
  comp_type: string | null;
  season_year: string;
  season_start: string;
  season_end: string;
  in_season: boolean;
  stats_synced_at: string | null;
  updated_at: string;
};

const COMP_COLS = 'code,name,comp_type,season_year,season_start,season_end,in_season,stats_synced_at,updated_at';

export async function upsertCompetition(
  row: Omit<CompetitionRow, 'stats_synced_at' | 'updated_at'> & { stats_synced_at?: string | null }
): Promise<R<true>> {
  try {
    const d = await db();
    const { error } = await d
      .from('fd_competitions')
      .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'code' });
    if (error) return dbFail(error.message);
    return { ok: true, data: true };
  } catch (e) {
    return fail(e);
  }
}

export async function listCompetitions(): Promise<R<CompetitionRow[]>> {
  try {
    const d = await db();
    const { data, error } = await d.from('fd_competitions').select(COMP_COLS).order('code');
    if (error) return dbFail(error.message);
    return { ok: true, data: (data || []) as CompetitionRow[] };
  } catch (e) {
    return fail(e);
  }
}

export async function getCompetitionRow(code: string): Promise<R<CompetitionRow | null>> {
  try {
    const d = await db();
    const { data, error } = await d.from('fd_competitions').select(COMP_COLS).eq('code', code).maybeSingle();
    if (error) return dbFail(error.message);
    return { ok: true, data: (data as CompetitionRow | null) || null };
  } catch (e) {
    return fail(e);
  }
}

export async function markStatsSynced(code: string): Promise<R<true>> {
  try {
    const d = await db();
    const now = new Date().toISOString();
    const { error } = await d
      .from('fd_competitions')
      .update({ stats_synced_at: now, updated_at: now })
      .eq('code', code);
    if (error) return dbFail(error.message);
    return { ok: true, data: true };
  } catch (e) {
    return fail(e);
  }
}

// ── Team stats (totals only; averages are computed from these) ────────────
export type TeamStatRow = {
  comp_code: string;
  season_year: string;
  team_id: number;
  team_name: string;
  played: number;
  scored: number;
  conceded: number;
};

const STAT_COLS = 'comp_code,season_year,team_id,team_name,played,scored,conceded';

export async function saveTeamStats(rows: TeamStatRow[]): Promise<R<number>> {
  try {
    const d = await db();
    const now = new Date().toISOString();
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200).map((r) => ({ ...r, updated_at: now }));
      const { error } = await d
        .from('fd_team_stats')
        .upsert(chunk, { onConflict: 'comp_code,season_year,team_id' });
      if (error) return dbFail(error.message);
    }
    return { ok: true, data: rows.length };
  } catch (e) {
    return fail(e);
  }
}

export async function getTeamStats(comp: string, season: string): Promise<R<TeamStatRow[]>> {
  try {
    const d = await db();
    const { data, error } = await d
      .from('fd_team_stats')
      .select(STAT_COLS)
      .eq('comp_code', comp)
      .eq('season_year', season);
    if (error) return dbFail(error.message);
    return { ok: true, data: (data || []) as TeamStatRow[] };
  } catch (e) {
    return fail(e);
  }
}

// Every stored row for these teams (all competitions and seasons).
// Used for the fallback tiers; the caller picks the right season.
export async function getTeamStatsForTeams(teamIds: number[]): Promise<R<TeamStatRow[]>> {
  try {
    if (teamIds.length === 0) return { ok: true, data: [] };
    const d = await db();
    const { data, error } = await d.from('fd_team_stats').select(STAT_COLS).in('team_id', teamIds);
    if (error) return dbFail(error.message);
    return { ok: true, data: (data || []) as TeamStatRow[] };
  } catch (e) {
    return fail(e);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────
export type NewFixture = {
  fd_match_id: number;
  comp_code: string;
  season_year: string;
  stage: string;
  matchday: number;
  match_date: string;
  home_id: number;
  home_name: string;
  away_id: number;
  away_name: string;
};

export type FixtureRow = NewFixture & {
  status: 'pending' | 'graded' | 'void' | 'skipped';
  skip_reason: string | null;
  hs: number | null;
  hc: number | null;
  asc_: number | null;
  ac: number | null;
  home_tier: string | null;
  away_tier: string | null;
  f1_home: number | null;
  f1_away: number | null;
  f2_home: number | null;
  f2_away: number | null;
  predicted_at: string | null;
  real_home: number | null;
  real_away: number | null;
  graded_at: string | null;
};

const FIX_COLS =
  'fd_match_id,comp_code,season_year,stage,matchday,match_date,home_id,home_name,away_id,away_name,' +
  'status,skip_reason,hs,hc,asc_,ac,home_tier,away_tier,f1_home,f1_away,f2_home,f2_away,' +
  'predicted_at,real_home,real_away,graded_at';

// Inserts new fixtures. An existing fixture is never touched, so a
// frozen prediction can never be overwritten by a re-sync.
export async function insertFixtures(rows: NewFixture[]): Promise<R<number>> {
  try {
    if (rows.length === 0) return { ok: true, data: 0 };
    const d = await db();
    const { data, error } = await d
      .from('fd_fixtures')
      .upsert(rows, { onConflict: 'fd_match_id', ignoreDuplicates: true })
      .select('fd_match_id');
    if (error) return dbFail(error.message);
    return { ok: true, data: (data || []).length };
  } catch (e) {
    return fail(e);
  }
}

export async function getFixtures(
  comp: string,
  season: string,
  stage: string,
  matchday: number
): Promise<R<FixtureRow[]>> {
  try {
    const d = await db();
    const { data, error } = await d
      .from('fd_fixtures')
      .select(FIX_COLS)
      .eq('comp_code', comp)
      .eq('season_year', season)
      .eq('stage', stage)
      .eq('matchday', matchday)
      .order('match_date');
    if (error) return dbFail(error.message);
    return { ok: true, data: (data || []) as unknown as FixtureRow[] };
  } catch (e) {
    return fail(e);
  }
}

export type PredictionInput = {
  hs: number;
  hc: number;
  asc_: number;
  ac: number;
  home_tier: string;
  away_tier: string;
  f1_home: number;
  f1_away: number;
  f2_home: number;
  f2_away: number;
};

// Freezes a prediction. Only updates a fixture that has none yet.
// Returns true when this call saved it, false when it was already frozen.
export async function savePrediction(fdMatchId: number, p: PredictionInput): Promise<R<boolean>> {
  try {
    const d = await db();
    const { data, error } = await d
      .from('fd_fixtures')
      .update({ ...p, predicted_at: new Date().toISOString() })
      .eq('fd_match_id', fdMatchId)
      .eq('status', 'pending')
      .is('predicted_at', null)
      .select('fd_match_id');
    if (error) return dbFail(error.message);
    return { ok: true, data: (data || []).length > 0 };
  } catch (e) {
    return fail(e);
  }
}

// Marks a fixture as skipped with a reason (never silently dropped).
export async function markSkipped(fdMatchId: number, reason: string): Promise<R<boolean>> {
  try {
    const d = await db();
    const { data, error } = await d
      .from('fd_fixtures')
      .update({ status: 'skipped', skip_reason: reason.slice(0, 200) })
      .eq('fd_match_id', fdMatchId)
      .eq('status', 'pending')
      .is('predicted_at', null)
      .select('fd_match_id');
    if (error) return dbFail(error.message);
    return { ok: true, data: (data || []).length > 0 };
  } catch (e) {
    return fail(e);
  }
}

// Predicted, still ungraded fixtures that kicked off before `cutoffIso`.
export async function listDueForGrading(
  cutoffIso: string,
  comp: string | null,
  limit: number
): Promise<R<{ fd_match_id: number; comp_code: string }[]>> {
  try {
    const d = await db();
    let q = d
      .from('fd_fixtures')
      .select('fd_match_id,comp_code')
      .eq('status', 'pending')
      .not('predicted_at', 'is', null)
      .lt('match_date', cutoffIso)
      .order('match_date')
      .limit(limit);
    if (comp) q = q.eq('comp_code', comp);
    const { data, error } = await q;
    if (error) return dbFail(error.message);
    return { ok: true, data: (data || []) as { fd_match_id: number; comp_code: string }[] };
  } catch (e) {
    return fail(e);
  }
}

// Saves the real score. Only acts on a still-pending fixture, so a
// double run cannot grade twice.
export async function saveGrade(fdMatchId: number, home: number, away: number): Promise<R<boolean>> {
  try {
    const d = await db();
    const { data, error } = await d
      .from('fd_fixtures')
      .update({ status: 'graded', real_home: home, real_away: away, graded_at: new Date().toISOString() })
      .eq('fd_match_id', fdMatchId)
      .eq('status', 'pending')
      .select('fd_match_id');
    if (error) return dbFail(error.message);
    return { ok: true, data: (data || []).length > 0 };
  } catch (e) {
    return fail(e);
  }
}

// POSTPONED / CANCELLED matches that will never be graded.
export async function markVoid(fdMatchId: number, reason: string): Promise<R<boolean>> {
  try {
    const d = await db();
    const { data, error } = await d
      .from('fd_fixtures')
      .update({ status: 'void', skip_reason: reason.slice(0, 200) })
      .eq('fd_match_id', fdMatchId)
      .eq('status', 'pending')
      .select('fd_match_id');
    if (error) return dbFail(error.message);
    return { ok: true, data: (data || []).length > 0 };
  } catch (e) {
    return fail(e);
  }
}

// Which of these matches are already stored, with their date and status.
export async function getFixtureDates(
  ids: number[]
): Promise<R<Map<number, { match_date: string; status: string }>>> {
  try {
    const map = new Map<number, { match_date: string; status: string }>();
    if (ids.length === 0) return { ok: true, data: map };
    const d = await db();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await d
        .from('fd_fixtures')
        .select('fd_match_id,match_date,status')
        .in('fd_match_id', ids.slice(i, i + 200));
      if (error) return dbFail(error.message);
      for (const r of (data || []) as { fd_match_id: number; match_date: string; status: string }[]) {
        map.set(r.fd_match_id, { match_date: r.match_date, status: r.status });
      }
    }
    return { ok: true, data: map };
  } catch (e) {
    return fail(e);
  }
}

// A rescheduled match keeps its row (and any prediction); only the date moves.
export async function updateFixtureDate(fdMatchId: number, matchDateIso: string): Promise<R<boolean>> {
  try {
    const d = await db();
    const { data, error } = await d
      .from('fd_fixtures')
      .update({ match_date: matchDateIso })
      .eq('fd_match_id', fdMatchId)
      .eq('status', 'pending')
      .select('fd_match_id');
    if (error) return dbFail(error.message);
    return { ok: true, data: (data || []).length > 0 };
  } catch (e) {
    return fail(e);
  }
}

// ── Run log (read by the future admin monitor) ────────────────────────────
export async function logRun(
  step: string,
  comp: string | null,
  ok: boolean,
  seconds: number,
  detail: unknown
): Promise<void> {
  try {
    const d = await db();
    await d.from('fd_run_log').insert({ step, comp_code: comp, ok, seconds, detail });
  } catch {
    // logging must never break a run
  }
}
