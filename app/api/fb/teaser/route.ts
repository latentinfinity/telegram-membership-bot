// app/api/fb/teaser/route.ts  (NEW) - test route for teaser matching.
// Default is a DRY RUN: it only shows which rule matches. Add post=1 to publish
// a real teaser on the Page (the on/off switch is ignored for this test).
import { NextResponse } from 'next/server';
import { processTeaser } from '@/lib/fb/teaser';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!secret || secret !== process.env.DISPATCH_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const text = (url.searchParams.get('text') ?? '').trim();
  if (!text) {
    return NextResponse.json({ ok: false, error: 'Add &text=... to the link' }, { status: 400 });
  }
  const publish = url.searchParams.get('post') === '1';
  const result = await processTeaser({
    text,
    messageId: -Date.now(),
    dryRun: !publish,
    force: true,
  });
  return NextResponse.json({ version: 'fb-teaser-1', publish, ...result });
}
