// READ-ONLY preview of the posts built from stored predictions.
// Sends nothing, calls no football API, writes nothing.
// Version: fd-preview-2
import { createAdminClient } from '../../../../lib/supabase/admin';
import { buildLists } from '../../../../lib/fd/lists';
import type { FixtureIn } from '../../../../lib/fd/lists';
import { formatPost } from '../../../../lib/fd/format';
import { dayWindow, weekWindow, formatFixtures } from '../../../../lib/fd/fixturesPost';
import type { FxRow } from '../../../../lib/fd/fixturesPost';

export const dynamic = 'force-dynamic';
const VERSION = 'fd-preview-2';

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

// Nigerian calendar day (UTC+1) as YYYY-MM-DD
function nigeriaToday(): string {
  return new Date(Date.now() + 3600000).toISOString().slice(0, 10);
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const secret = process.env.DISPATCH_SECRET;
  if (!secret || url.searchParams.get('secret') !== secret) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  const mode = url.searchParams.get('mode') === 'all' ? 'all' : 'day';
  const premium = url.searchParams.get('premium') === '1';
  const comps = (url.searchParams.get('comp') || '')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const date = url.searchParams.get('date') || nigeriaToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return text('date must look like 2026-10-17', 400);

  const db = createAdminClient();

  // Fixtures posts (no predictions needed): type=fixtures&scope=week|today
  if (url.searchParams.get('type') === 'fixtures') {
    const scope = url.searchParams.get('scope') === 'today' ? 'today' : 'week';
    const w = scope === 'today' ? dayWindow(date) : weekWindow(date);
    let fq = db
      .from('fd_fixtures')
      .select('fd_match_id, comp_code, match_date, home_name, away_name')
      .in('status', ['pending', 'graded'])
      .gte('match_date', w.startIso)
      .lt('match_date', w.endIso)
      .order('match_date', { ascending: true })
      .limit(1000);
    if (comps.length > 0) fq = fq.in('comp_code', comps);
    const fr = await fq;
    if (fr.error) return text(`database error: ${fr.error.message}`, 500);
    const frows = (fr.data || []) as Record<string, unknown>[];
    const fcodes = Array.from(new Set(frows.map((r) => String(r.comp_code))));
    const fnames: Record<string, string> = {};
    if (fcodes.length > 0) {
      const c = await db.from('fd_competitions').select('code, name').in('code', fcodes);
      if (c.error) return text(`database error: ${c.error.message}`, 500);
      for (const r of (c.data || []) as { code: string; name: string }[]) fnames[r.code] = r.name;
    }
    const fx: FxRow[] = frows.map((r) => ({
      id: Number(r.fd_match_id), comp: String(r.comp_code),
      compName: fnames[String(r.comp_code)] || String(r.comp_code),
      matchDate: String(r.match_date), home: String(r.home_name), away: String(r.away_name),
    }));
    const posts = formatFixtures(fx, scope, date);
    const fhead = `PREVIEW (nothing sent) | ${VERSION}\nFixtures post: ${scope} | Nigerian time | ${w.startIso} to ${w.endIso}` +
      (comps.length ? ` | comp: ${comps.join(',')}` : '') + `\nMatches: ${fx.length} | posts: ${posts.length}`;
    if (posts.length === 0) return text(`${fhead}\n\nNo stored fixtures in this window.`);
    const parts: string[] = [];
    for (const p of posts) p.messages.forEach((m, i) => parts.push(`----- ${p.comp} message ${i + 1} of ${p.messages.length} -----\n${m}`));
    return text(`${fhead}\n\n${parts.join('\n\n')}`);
  }
  let q = db
    .from('fd_fixtures')
    .select('fd_match_id, comp_code, stage, match_date, home_name, away_name, hs, hc, asc_, ac, f1_home, f1_away, f2_home, f2_away')
    .eq('status', 'pending')
    .not('predicted_at', 'is', null)
    .order('match_date', { ascending: true })
    .limit(1000);

  let window = '';
  if (mode === 'day') {
    const start = new Date(`${date}T00:00:00+01:00`);
    const end = new Date(start.getTime() + 86400000);
    q = q.gte('match_date', start.toISOString()).lt('match_date', end.toISOString());
    window = `Nigerian day ${date}`;
  } else {
    q = q.gte('match_date', new Date().toISOString());
    window = 'all upcoming predicted matches';
  }
  if (comps.length > 0) q = q.in('comp_code', comps);

  const { data, error } = await q;
  if (error) return text(`database error: ${error.message}`, 500);
  const rows = (data || []) as Record<string, unknown>[];

  const codes = Array.from(new Set(rows.map((r) => String(r.comp_code))));
  const names: Record<string, string> = {};
  if (codes.length > 0) {
    const c = await db.from('fd_competitions').select('code, name').in('code', codes);
    if (c.error) return text(`database error: ${c.error.message}`, 500);
    for (const r of (c.data || []) as { code: string; name: string }[]) names[r.code] = r.name;
  }

  const fixtures: FixtureIn[] = rows.map((r) => ({
    id: Number(r.fd_match_id),
    comp: String(r.comp_code),
    compName: names[String(r.comp_code)] || String(r.comp_code),
    stage: String(r.stage || ''),
    matchDate: String(r.match_date),
    home: String(r.home_name),
    away: String(r.away_name),
    hs: r.hs as number | string | null,
    hc: r.hc as number | string | null,
    asc: r.asc_ as number | string | null,
    ac: r.ac as number | string | null,
    f1h: r.f1_home as number | null,
    f1a: r.f1_away as number | null,
    f2h: r.f2_home as number | null,
    f2a: r.f2_away as number | null,
  }));

  const { lists, skipped } = buildLists(fixtures);
  const messages = formatPost(lists, premium);

  const head =
    `PREVIEW (nothing sent) | ${VERSION}\n` +
    `Post: ${premium ? 'PREMIUM' : 'normal'} | window: ${window}` +
    (comps.length ? ` | comp: ${comps.join(',')}` : '') + '\n' +
    `Predicted matches in window: ${fixtures.length} | skipped: ${skipped.length}` +
    (skipped.length ? ` (${skipped.map((s) => `${s.id}: ${s.reason}`).join('; ')})` : '') + '\n' +
    `Messages: ${messages.length}`;
  if (messages.length === 0) return text(`${head}\n\nNothing qualifies in this window.`);
  return text(`${head}\n\n${messages.map((m, i) => `----- message ${i + 1} of ${messages.length} -----\n${m}`).join('\n\n')}`);
}
