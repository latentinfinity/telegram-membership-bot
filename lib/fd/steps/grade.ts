// lib/fd/steps/grade.ts
// STEP "grade": saves the real score of predicted matches.
// A match is looked at 6+ hours after kickoff. Per competition ONE call
// returns every finished match in the date range, so a delayed result is
// picked up by the next check (every 30 minutes at most) with no extra
// calls per match. A score is saved only when the API says FINISHED and
// both full-time scores exist. Nothing is ever guessed.

import { fdGet, getMatchById, toISODate } from '../client';
import type { FdMatchList } from '../client';
import { GIVE_UP_DAYS, GRADE_AFTER_HOURS, LOOKBACK_DAYS, OLD_LOOKUP_LIMIT, RECHECK_MINUTES } from '../config';
import { listDueForResults, markVoid, saveGrade, touchResultChecked, updateFixtureDate } from '../store';
import type { DueRow } from '../store';

export type GradeOptions = { comps: string[]; deadline: number };

const DAY = 86400000;
const HOUR = 3600000;

type HasScore = { status: string; score?: { fullTime?: { home: number | null; away: number | null } } };

export function finalScore(m: HasScore): { h: number; a: number } | null {
  if (m.status !== 'FINISHED') return null;
  const h = m.score?.fullTime?.home;
  const a = m.score?.fullTime?.away;
  if (h === null || h === undefined || a === null || a === undefined) return null;
  return { h, a };
}

async function gradeComp(code: string, due: DueRow[], now: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { comp: code, due: due.length };
  const recheck = RECHECK_MINUTES * 60000;
  const eligible = due.filter((r) => !r.result_checked_at || now - Date.parse(r.result_checked_at) > recheck);
  if (eligible.length === 0) {
    out.note = 'all recently checked';
    return out;
  }

  let voided = 0;
  let graded = 0;
  let calls = 0;
  const done = new Set<number>();

  // Give up on matches that never got a result.
  for (const r of eligible) {
    if (now - Date.parse(r.match_date) > GIVE_UP_DAYS * DAY) {
      const v = await markVoid(r.fd_match_id, 'no result after ' + GIVE_UP_DAYS + ' days');
      if (v.ok && v.data) voided++;
      done.add(r.fd_match_id);
    }
  }
  const live = eligible.filter((r) => !done.has(r.fd_match_id));

  if (live.length > 0) {
    const times = live.map((r) => Date.parse(r.match_date));
    const maxMs = Math.max(...times);
    const fromMs = Math.max(Math.min(...times), maxMs - 9 * DAY); // the API allows 10 days
    const list = ((await fdGet<FdMatchList>(
      '/competitions/' + code + '/matches?status=FINISHED&dateFrom=' + toISODate(new Date(fromMs)) +
        '&dateTo=' + toISODate(new Date(maxMs + DAY))
    )).data.matches || []);
    calls++;
    const byId = new Map<number, HasScore>();
    for (const m of list) byId.set(m.id, m);

    for (const r of due) {
      if (done.has(r.fd_match_id)) continue;
      const m = byId.get(r.fd_match_id);
      const sc = m ? finalScore(m) : null;
      if (sc) {
        const g = await saveGrade(r.fd_match_id, sc.h, sc.a);
        if (g.ok && g.data) graded++;
        done.add(r.fd_match_id);
      }
    }

    // Still unresolved after the sync step's look-back window: single
    // lookups, a few per run (this also catches a rescheduled match).
    const oldCut = now - LOOKBACK_DAYS * DAY;
    const old = live
      .filter((r) => !done.has(r.fd_match_id) && Date.parse(r.match_date) < oldCut)
      .slice(0, OLD_LOOKUP_LIMIT);
    for (const r of old) {
      const m = (await getMatchById(r.fd_match_id)).data;
      calls++;
      const sc = finalScore(m);
      if (sc) {
        const g = await saveGrade(r.fd_match_id, sc.h, sc.a);
        if (g.ok && g.data) graded++;
        done.add(r.fd_match_id);
      } else if (m.status === 'CANCELLED') {
        const v = await markVoid(r.fd_match_id, 'cancelled');
        if (v.ok && v.data) voided++;
        done.add(r.fd_match_id);
      } else if (m.status === 'POSTPONED' || m.status === 'TIMED' || m.status === 'SCHEDULED') {
        const md = (m as unknown as { utcDate?: string }).utcDate;
        if (md && Date.parse(md) > now) await updateFixtureDate(r.fd_match_id, md); // rescheduled
      }
    }
  }

  await touchResultChecked(eligible.filter((r) => !done.has(r.fd_match_id)).map((r) => r.fd_match_id));
  out.ok = true;
  out.graded = graded;
  out.still_waiting = eligible.length - done.size;
  if (voided) out.voided = voided;
  out.api_calls = calls;
  return out;
}

export async function runGradeStep(opts: GradeOptions): Promise<Record<string, unknown>> {
  const now = Date.now();
  const cutoff = new Date(now - GRADE_AFTER_HOURS * HOUR).toISOString();
  const list = await listDueForResults(cutoff, 400);
  if (!list.ok) return { ok: false, error: list.error };
  const rows = list.data.filter((r) => opts.comps.indexOf(r.comp_code) !== -1);
  if (rows.length === 0) return { ok: true, done: true, note: 'nothing to grade' };

  const byComp = new Map<string, DueRow[]>();
  for (const r of rows) {
    const l = byComp.get(r.comp_code);
    if (l) l.push(r);
    else byComp.set(r.comp_code, [r]);
  }
  const results: Record<string, unknown>[] = [];
  for (const entry of Array.from(byComp.entries())) {
    if (Date.now() > opts.deadline) break;
    results.push(await gradeComp(entry[0], entry[1], now));
  }
  return { ok: results.every((r) => r.ok !== false), results };
}
