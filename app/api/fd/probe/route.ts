// app/api/fd/probe/route.ts
// READ-ONLY look at a matchday. Stores nothing.
// /api/fd/probe?secret=...&comp=PL                      current matchday and the one before
// /api/fd/probe?secret=...&comp=PL&md=8                 one specific matchday
// /api/fd/probe?secret=...&comp=CL&season=2025&stage=LAST_16   a knockout stage

import { NextResponse } from 'next/server';
import { fdGet, getCompetition } from '../../../../lib/fd/client';
import type { FdMatchList } from '../../../../lib/fd/client';
import { FREE_TIER, LOCK_NAME } from '../../../../lib/fd/config';
import { tryLock, unlock } from '../../../../lib/fd/lock';
import { summariseMatchday } from '../../../../lib/fd/matchday';
import type { MdMatch } from '../../../../lib/fd/matchday';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const VERSION = 'fd-probe-1';

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!process.env.DISPATCH_SECRET || url.searchParams.get('secret') !== process.env.DISPATCH_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const code = (url.searchParams.get('comp') || 'PL').toUpperCase();
  if (FREE_TIER.indexOf(code) === -1) return NextResponse.json({ error: 'unknown competition' }, { status: 400 });
  const seasonParam = url.searchParams.get('season');
  const mdParam = url.searchParams.get('md');
  const stage = (url.searchParams.get('stage') || '').toUpperCase().replace(/[^A-Z_0-9]/g, '');
  const out: Record<string, unknown> = { route_version: VERSION, comp: code };

  const lock = await tryLock(LOCK_NAME, 60);
  if (!lock.ok) {
    out.error = lock.reason === 'busy' ? 'another run is in progress, try again in a minute' : lock.error;
    return NextResponse.json(out, { status: 409 });
  }

  try {
    const now = Date.now();
    if (stage) {
      if (!seasonParam) {
        out.error = 'stage needs &season=YYYY';
        return NextResponse.json(out, { status: 400 });
      }
      const r = await fdGet<FdMatchList>(
        '/competitions/' + code + '/matches?season=' + seasonParam + '&stage=' + stage
      );
      out.stage_query = { season: seasonParam, stage, summary: summariseMatchday((r.data.matches || []) as MdMatch[], now) };
      return NextResponse.json(out);
    }

    const info = (await getCompetition(code)).data;
    const cur = info.currentSeason;
    if (!cur) {
      out.error = 'no current season';
      return NextResponse.json(out);
    }
    const year = seasonParam || cur.startDate.slice(0, 4);
    const apiMd = cur.currentMatchday ?? null;
    out.api_current_matchday = apiMd;
    out.season = year;
    const md = mdParam ? Number(mdParam) : apiMd;
    if (md === null || !Number.isFinite(md)) {
      out.error = 'no matchday number available (use &md=N)';
      return NextResponse.json(out);
    }
    const a = await fdGet<FdMatchList>('/competitions/' + code + '/matches?season=' + year + '&matchday=' + md);
    out['matchday_' + md] = summariseMatchday((a.data.matches || []) as MdMatch[], now);
    out.result_set = a.data.resultSet || null;
    if (!mdParam && md > 1) {
      const b = await fdGet<FdMatchList>('/competitions/' + code + '/matches?season=' + year + '&matchday=' + (md - 1));
      out['matchday_' + (md - 1)] = summariseMatchday((b.data.matches || []) as MdMatch[], now);
    }
    return NextResponse.json(out);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return NextResponse.json(out, { status: 500 });
  } finally {
    await unlock(LOCK_NAME);
  }
}
