// lib/fd/steps/tick.ts
// One call that does everything in a safe order, inside Vercel's 60 s:
//   1. predict (database only)
//   2. grade   (results, at most ~20 s)
//   3. stats   (one competition, only if time is left and work exists)
//   4. sync    (fixtures, only if time is left)
// Run it from ONE cron job every 2 minutes. The lock keeps it to one run.

import { runGradeStep } from './grade';
import { runPredictStep } from './predict';
import { runStatsStep } from './stats';
import { runSyncStep } from './sync';

export type TickOptions = { comps: string[]; force: boolean };

function busy(r: Record<string, unknown>): boolean {
  const s = JSON.stringify(r);
  return (
    /"(predicted|refreshed|graded|voided|rescheduled|teams_saved|new_rows_written)":[1-9]/.test(s) ||
    s.indexOf('"synced"') !== -1 ||
    s.indexOf('"ok":false') !== -1 ||
    s.indexOf('"blocked":true') !== -1
  );
}

export async function runTick(opts: TickOptions): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const out: Record<string, unknown> = {};

  out.predict = await runPredictStep({ comps: opts.comps });
  out.grade = await runGradeStep({ comps: opts.comps, deadline: t0 + 20000 });

  if (Date.now() - t0 < 22000) {
    out.stats = await runStatsStep({ comps: opts.comps, force: opts.force });
  } else {
    out.stats = { skipped: 'no time left this run' };
  }
  if (Date.now() - t0 < 30000) {
    out.sync = await runSyncStep({ comps: opts.comps, rotate: true, deadline: t0 + 32000 });
  } else {
    out.sync = { skipped: 'no time left this run' };
  }

  out.activity = busy(out);
  out.ok = !JSON.stringify(out).includes('"ok":false');
  return out;
}
