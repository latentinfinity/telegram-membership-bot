// app/api/fd/run/route.ts
// The single entry point for the football-data.org automation.
// /api/fd/run?secret=<DISPATCH_SECRET>&step=stats[&comp=PL,CL][&force=1]
// One competition per request; the reply says how many are `remaining`.
// Only one run at a time (database lock).

import { NextResponse } from 'next/server';
import { FREE_TIER, LOCK_NAME, LOCK_SECONDS } from '../../../../lib/fd/config';
import { tryLock, unlock } from '../../../../lib/fd/lock';
import { runStatsStep } from '../../../../lib/fd/steps/stats';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const VERSION = 'fd-run-1';

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!process.env.DISPATCH_SECRET || url.searchParams.get('secret') !== process.env.DISPATCH_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const step = (url.searchParams.get('step') || 'stats').toLowerCase();
  const compParam = url.searchParams.get('comp');
  const comps = compParam
    ? compParam.split(',').map((c) => c.trim().toUpperCase()).filter((c) => FREE_TIER.indexOf(c) !== -1)
    : FREE_TIER;
  const force = url.searchParams.get('force') === '1';
  const t0 = Date.now();
  const out: Record<string, unknown> = { route_version: VERSION, step, comps };

  if (comps.length === 0) {
    out.error = 'no valid competition code (allowed: ' + FREE_TIER.join(',') + ')';
    return NextResponse.json(out, { status: 400 });
  }
  if (step !== 'stats') {
    out.error = 'step not built yet (available: stats)';
    return NextResponse.json(out, { status: 400 });
  }

  const lock = await tryLock(LOCK_NAME, LOCK_SECONDS);
  if (!lock.ok) {
    out.busy = lock.reason === 'busy';
    out.error = lock.reason === 'busy' ? 'another run is in progress' : lock.error;
    return NextResponse.json(out, { status: lock.reason === 'busy' ? 409 : 500 });
  }

  try {
    out.result = await runStatsStep({ comps, force });
    out.seconds = Math.round((Date.now() - t0) / 100) / 10;
    return NextResponse.json(out);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return NextResponse.json(out, { status: 500 });
  } finally {
    await unlock(LOCK_NAME);
  }
}
