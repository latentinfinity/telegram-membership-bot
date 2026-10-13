// lib/fd/steps/predict.ts
// STEP "predict": database only, no football-data.org calls.
// For every stored fixture that has not started and is not posted:
//  - never predicted -> predict (only once the competition's stats were
//    refreshed AFTER the fixtures were stored, i.e. after the previous
//    matchday resolved; otherwise report "waiting_for_stats"),
//  - predicted on stale stats -> recompute and replace if anything changed.
// A match with no data anywhere is never guessed: it keeps a reason.

import { OVERDUE_HOURS } from '../matchday';
import { chooseAverages, predictFromAverages, staleNote } from '../predictCalc';
import type { MatchPrediction, TotalsLite } from '../predictCalc';
import {
  getTeamStats,
  getTeamStatsForTeams,
  listCompetitions,
  listOverdueUngraded,
  listPredictable,
  refreshPrediction,
  savePrediction,
  setSkipReason,
} from '../store';
import type { CompetitionRow, PredictableRow, TeamStatRow } from '../store';

export type PredictOptions = { comps: string[] };

function same(a: number | null, b: number): boolean {
  return a !== null && Number(a) === b;
}

function unchanged(row: PredictableRow, p: MatchPrediction, note: string | null): boolean {
  return (
    same(row.hs, p.hs) && same(row.hc, p.hc) && same(row.asc_, p.asc_) && same(row.ac, p.ac) &&
    row.f1_home === p.f1_home && row.f1_away === p.f1_away &&
    row.f2_home === p.f2_home && row.f2_away === p.f2_away &&
    (row.stale_note || null) === note
  );
}

function toMap(rows: TeamStatRow[]): Map<number, TotalsLite> {
  const m = new Map<number, TotalsLite>();
  for (const r of rows) m.set(r.team_id, { played: r.played, scored: r.scored, conceded: r.conceded });
  return m;
}

async function predictComp(
  code: string,
  rows: PredictableRow[],
  crow: CompetitionRow,
  comps: Map<string, CompetitionRow>
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { comp: code };
  const todo = rows.filter((r) => r.predicted_at === null);
  const stale = rows.filter((r) => r.predicted_at !== null);

  let ready = true;
  if (todo.length > 0) {
    let oldest = Infinity;
    for (const r of todo) oldest = Math.min(oldest, Date.parse(r.created_at));
    const synced = crow.stats_synced_at ? Date.parse(crow.stats_synced_at) : 0;
    if (synced < oldest) {
      ready = false;
      out.waiting_for_stats = todo.length; // the stats step refreshes this competition by itself
    }
  }
  const work = ready ? rows : stale;
  if (work.length === 0) return out;

  const cur = await getTeamStats(code, crow.season_year);
  const prev = await getTeamStats(code, String(Number(crow.season_year) - 1));
  if (!cur.ok) return { ...out, ok: false, error: cur.error };
  if (!prev.ok) return { ...out, ok: false, error: prev.error };
  const curMap = toMap(cur.data);
  const prevMap = toMap(prev.data);

  // Teams with no data in this competition at all need the tier-3 rows.
  const ids = new Set<number>();
  for (const r of work) {
    for (const id of [r.home_id, r.away_id]) {
      const c = curMap.get(id);
      const p = prevMap.get(id);
      if ((!c || c.played <= 0) && (!p || p.played <= 0)) ids.add(id);
    }
  }
  const others = new Map<number, TotalsLite[]>();
  if (ids.size > 0) {
    const o = await getTeamStatsForTeams(Array.from(ids));
    if (!o.ok) return { ...out, ok: false, error: o.error };
    for (const r of o.data) {
      const oc = comps.get(r.comp_code);
      if (r.comp_code === code || !oc || oc.comp_type !== 'LEAGUE') continue;
      if (r.season_year !== String(Number(oc.season_year) - 1)) continue;
      const list = others.get(r.team_id) || [];
      list.push({ played: r.played, scored: r.scored, conceded: r.conceded });
      others.set(r.team_id, list);
    }
  }

  const cutoff = new Date(Date.now() - OVERDUE_HOURS * 3600000).toISOString();
  const od = await listOverdueUngraded(code, cutoff);
  if (!od.ok) return { ...out, ok: false, error: od.error };

  let predicted = 0, refreshed = 0, same_ = 0, staleCount = 0;
  const cannot: { match: string; reason: string }[] = [];
  const tiers: Record<string, number> = {};

  for (const r of work) {
    const label = r.home_name + ' - ' + r.away_name;
    const home = chooseAverages(curMap.get(r.home_id), prevMap.get(r.home_id), others.get(r.home_id) || []);
    const away = chooseAverages(curMap.get(r.away_id), prevMap.get(r.away_id), others.get(r.away_id) || []);
    if (!home || !away) {
      const who = !home ? r.home_name : r.away_name;
      const reason = 'no data for ' + who + ' in this competition or any league';
      if (r.predicted_at === null) await setSkipReason(r.fd_match_id, reason);
      cannot.push({ match: label, reason });
      continue;
    }
    const pred = predictFromAverages(home, away);
    if (!pred) {
      cannot.push({ match: label, reason: 'correctScore could not read the numbers' });
      continue;
    }
    const note = staleNote(r.home_id, r.away_id, od.data);
    if (note) staleCount++;
    tiers[home.tier] = (tiers[home.tier] || 0) + 1;
    tiers[away.tier] = (tiers[away.tier] || 0) + 1;
    const input = { ...pred, stale_note: note };

    if (r.predicted_at === null) {
      const s = await savePrediction(r.fd_match_id, input);
      if (s.ok && s.data) predicted++;
    } else if (unchanged(r, pred, note)) {
      same_++;
    } else {
      const s = await refreshPrediction(r.fd_match_id, input);
      if (s.ok && s.data) refreshed++;
    }
  }

  out.ok = true;
  out.predicted = predicted;
  out.refreshed = refreshed;
  out.unchanged = same_;
  out.with_stale_note = staleCount;
  out.tiers_used = tiers;
  if (cannot.length) out.cannot_predict = cannot;
  return out;
}

export async function runPredictStep(opts: PredictOptions): Promise<Record<string, unknown>> {
  const list = await listPredictable(300);
  if (!list.ok) return { ok: false, error: list.error };
  const rows = list.data.filter((r) => opts.comps.indexOf(r.comp_code) !== -1);
  if (rows.length === 0) return { ok: true, done: true, note: 'nothing to predict' };

  const compList = await listCompetitions();
  if (!compList.ok) return { ok: false, error: compList.error };
  const comps = new Map<string, CompetitionRow>();
  for (const c of compList.data) comps.set(c.code, c);

  const byComp = new Map<string, PredictableRow[]>();
  for (const r of rows) {
    const l = byComp.get(r.comp_code);
    if (l) l.push(r);
    else byComp.set(r.comp_code, [r]);
  }

  const results: Record<string, unknown>[] = [];
  for (const entry of Array.from(byComp.entries())) {
    const crow = comps.get(entry[0]);
    if (!crow) {
      results.push({ comp: entry[0], ok: false, error: 'competition row missing, run stats first' });
      continue;
    }
    results.push(await predictComp(entry[0], entry[1], crow, comps));
  }
  return { ok: results.every((r) => r.ok !== false), results };
}
