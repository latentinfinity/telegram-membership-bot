import { NextResponse } from 'next/server';
import { runCleanup } from '@/lib/cleanup';
import { copyTracked } from '@/lib/fd/track';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  
  if (!secret || secret !== process.env.DISPATCH_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  try {
    const track = await copyTracked();
    const cleanup = await runCleanup();
    return NextResponse.json({ ok: true, track, cleanup });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
