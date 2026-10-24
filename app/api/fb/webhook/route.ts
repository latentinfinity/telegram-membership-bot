// app/api/fb/webhook/route.ts  (NEW) - Meta webhook for the Page.
// GET  = Meta's verification handshake (uses FB_VERIFY_TOKEN).
// POST = a Page event. When the Page itself publishes a new post, the bot
//        comments under it with a random predefined comment. Always answers 200.
import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const GRAPH = 'https://graph.facebook.com/v26.0';

const DEFAULT_COMMENTS: string[] = [
  'Posting games here is making facebook to restrict and suspend my recommendation but get all my games code on my Telegram channel or on Twitter. Check Pinned post for the link.',
  'Get all my predictions code here 👇\nhttps://t.me/aibetprofit',
  'Join me on X and get booking codes:\nhttps://www.x.com/ChimaAnalyst',
];

type FeedValue = {
  item?: string;
  verb?: string;
  post_id?: string;
  comment_id?: string;
  from?: { id?: string; name?: string };
};
type FeedChange = { field?: string; value?: FeedValue };
type FeedEntry = { id?: string; changes?: FeedChange[] };

// Meta signs every event with the app secret; reject anything else.
function validSignature(raw: string, header: string | null, secret: string): boolean {
  if (!header || header.indexOf('sha256=') !== 0) return false;
  const expected = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  const got = header.slice('sha256='.length);
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const expected = process.env.FB_VERIFY_TOKEN;
  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}

async function pickComment(): Promise<string | null> {
  const supabase = createAdminClient();
  let { data } = await supabase.from('fb_comments').select('body');
  if (!data || data.length === 0) {
    // First use: put your three starting comments in the list.
    await supabase.from('fb_comments').insert(DEFAULT_COMMENTS.map((body) => ({ body })));
    const again = await supabase.from('fb_comments').select('body');
    data = again.data;
  }
  if (!data || data.length === 0) return null;
  const list = data as { body: string }[];
  return list[Math.floor(Math.random() * list.length)].body;
}

async function postComment(postId: string, message: string, pageToken: string) {
  try {
    const res = await fetch(GRAPH + '/' + encodeURIComponent(postId) + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ message, access_token: pageToken }).toString(),
      cache: 'no-store',
    });
    const json = (await res.json()) as { id?: string; error?: { message?: string; code?: number } };
    if (!res.ok || json.error || !json.id) {
      return {
        ok: false,
        error: 'Meta error ' + (json.error?.code ?? res.status) + ': ' + (json.error?.message ?? 'unknown'),
      };
    }
    return { ok: true, commentId: json.id };
  } catch (e) {
    console.error('fb comment request failed');
    return { ok: false, error: 'Could not reach Meta' };
  }
}

async function saveNote(note: string) {
  try {
    const supabase = createAdminClient();
    await supabase
      .from('fb_settings')
      .update({ last_event: note.slice(0, 300), last_event_at: new Date().toISOString() })
      .eq('id', 1);
  } catch (e) {
    console.error('fb note save failed');
  }
}

// Handles one feed change and returns a short note about what happened.
async function handleChange(
  change: FeedChange,
  pageId: string,
  enabled: boolean,
  pageToken: string | null
): Promise<string> {
  const v = change.value ?? {};
  const base = 'feed/' + (v.item ?? '?') + '/' + (v.verb ?? '?');

  if (change.field !== 'feed') return 'ignored: field ' + (change.field ?? '?');
  if (v.verb !== 'add') return base + ' ignored: not a new item';
  if (v.item === 'comment' || v.item === 'reaction' || v.item === 'like' || v.comment_id) {
    return base + ' ignored: comment or reaction';
  }
  if (!v.post_id) return base + ' ignored: no post id';
  if (!v.from || v.from.id !== pageId) {
    return base + ' ignored: not from the Page (from ' + (v.from?.id ?? 'missing') + ')';
  }
  if (!enabled) return base + ' skipped: switch is OFF';
  if (!pageToken) return base + ' skipped: no Page token saved';

  const supabase = createAdminClient();

  // Claim the post first, so a repeated notification can never comment twice.
  const claim = await supabase.from('fb_comment_log').insert({ post_id: v.post_id, status: 'claiming' });
  if (claim.error) {
    if (claim.error.code === '23505') return base + ' skipped: already handled ' + v.post_id;
    console.error('fb log insert failed', claim.error.code);
    return base + ' skipped: could not write the log';
  }

  const message = await pickComment();
  if (!message) {
    await supabase
      .from('fb_comment_log')
      .update({ status: 'failed', error: 'no comments in the list', updated_at: new Date().toISOString() })
      .eq('post_id', v.post_id);
    return base + ' failed: no comments in the list';
  }

  const result = await postComment(v.post_id, message, pageToken);
  if (result.ok) {
    await supabase
      .from('fb_comment_log')
      .update({ status: 'posted', comment_id: result.commentId ?? null, updated_at: new Date().toISOString() })
      .eq('post_id', v.post_id);
    return base + ' commented on ' + v.post_id;
  }
  await supabase
    .from('fb_comment_log')
    .update({ status: 'failed', error: (result.error ?? '').slice(0, 300), updated_at: new Date().toISOString() })
    .eq('post_id', v.post_id);
  return base + ' failed: ' + (result.error ?? 'unknown');
}

export async function POST(req: Request) {
  const raw = await req.text();
  const appSecret = process.env.FB_APP_SECRET;
  const pageId = process.env.FB_PAGE_ID;
  if (!appSecret || !pageId) {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  if (!validSignature(raw, req.headers.get('x-hub-signature-256'), appSecret)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const body = JSON.parse(raw) as { object?: string; entry?: FeedEntry[] };
    if (body.object !== 'page' || !Array.isArray(body.entry)) {
      await saveNote('ignored: object ' + (body.object ?? '?'));
      return NextResponse.json({ ok: true });
    }

    const supabase = createAdminClient();
    const { data: settings } = await supabase
      .from('fb_settings')
      .select('enabled, page_token')
      .eq('id', 1)
      .maybeSingle();
    const enabled = settings ? settings.enabled === true : false;
    const pageToken = settings && typeof settings.page_token === 'string' ? settings.page_token : null;

    let note = 'ignored: no changes';
    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        note = await handleChange(change, pageId, enabled, pageToken);
      }
    }
    await saveNote(note);
  } catch (e) {
    console.error('fb webhook error', e);
    await saveNote('error: could not process the event');
  }

  return NextResponse.json({ ok: true });
}
