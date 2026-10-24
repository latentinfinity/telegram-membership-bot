// lib/fb/watch.ts  (NEW) - checks the Page's recent posts and comments on new ones.
// Called by the per-minute dispatch route. Never throws.
// Rules: new post by the Page, created after the check was first run,
// not older than 30 minutes, not already in fb_comment_log. Max 3 per run.
import { createAdminClient } from '@/lib/supabase/admin';

const GRAPH = 'https://graph.facebook.com/v26.0';
const MAX_AGE_MS = 30 * 60 * 1000;
const MAX_PER_RUN = 3;

const DEFAULT_COMMENTS: string[] = [
  'Posting games here is making facebook to restrict and suspend my recommendation but get all my games code on my Telegram channel or on Twitter. Check Pinned post for the link.',
  'Get all my predictions code here 👇\nhttps://t.me/aibetprofit',
  'Join me on X and get booking codes:\nhttps://www.x.com/ChimaAnalyst',
];

export type WatchResult = { ran: boolean; commented: number; note: string };

type FbPost = { id?: string; created_time?: string };

function parseFbTime(text: string): number {
  // Meta writes +0000; make it +00:00 so every engine reads it.
  const fixed = text.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  return Date.parse(fixed);
}

async function saveNote(note: string): Promise<void> {
  try {
    const supabase = createAdminClient();
    await supabase
      .from('fb_settings')
      .update({ last_event: ('watch: ' + note).slice(0, 300), last_event_at: new Date().toISOString() })
      .eq('id', 1);
  } catch (e) {
    console.error('fb watch note save failed');
  }
}

async function pickComment(): Promise<string | null> {
  const supabase = createAdminClient();
  let { data } = await supabase.from('fb_comments').select('body');
  if (!data || data.length === 0) {
    await supabase.from('fb_comments').insert(DEFAULT_COMMENTS.map((body) => ({ body })));
    const again = await supabase.from('fb_comments').select('body');
    data = again.data;
  }
  if (!data || data.length === 0) return null;
  const list = data as { body: string }[];
  return list[Math.floor(Math.random() * list.length)].body;
}

async function postComment(
  postId: string,
  message: string,
  pageToken: string
): Promise<{ ok: boolean; commentId?: string; error?: string }> {
  try {
    const res = await fetch(GRAPH + '/' + encodeURIComponent(postId) + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ message, access_token: pageToken }).toString(),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
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
    console.error('fb watch comment request failed');
    return { ok: false, error: 'Could not reach Meta' };
  }
}

export async function runFbWatch(): Promise<WatchResult> {
  try {
    const pageId = process.env.FB_PAGE_ID;
    if (!pageId) return { ran: false, commented: 0, note: 'FB_PAGE_ID is not set' };

    const supabase = createAdminClient();
    const { data: settings } = await supabase
      .from('fb_settings')
      .select('enabled, page_token, watch_started_at')
      .eq('id', 1)
      .maybeSingle();
    if (!settings) return { ran: false, commented: 0, note: 'fb_settings row not found' };
    if (settings.enabled !== true) return { ran: false, commented: 0, note: 'switch is OFF' };
    const pageToken = typeof settings.page_token === 'string' ? settings.page_token : '';
    if (!pageToken) return { ran: false, commented: 0, note: 'no Page token saved' };

    // First run: remember the moment. Older posts are never commented.
    if (!settings.watch_started_at) {
      const nowIso = new Date().toISOString();
      await supabase.from('fb_settings').update({ watch_started_at: nowIso }).eq('id', 1);
      await saveNote('started at ' + nowIso + ', older posts are ignored');
      return { ran: true, commented: 0, note: 'watch started, older posts ignored' };
    }
    const startedMs = Date.parse(String(settings.watch_started_at));

    // Read the Page's recent published posts (id and time only).
    let posts: FbPost[] = [];
    try {
      const url =
        GRAPH + '/' + encodeURIComponent(pageId) + '/published_posts?' +
        new URLSearchParams({ fields: 'id,created_time', limit: '10', access_token: pageToken }).toString();
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const json = (await res.json()) as { data?: FbPost[]; error?: { message?: string; code?: number } };
      if (!res.ok || json.error) {
        const msg = 'Meta error ' + (json.error?.code ?? res.status) + ': ' + (json.error?.message ?? 'unknown');
        await saveNote('could not read posts. ' + msg);
        return { ran: true, commented: 0, note: 'could not read posts: ' + msg };
      }
      posts = Array.isArray(json.data) ? json.data : [];
    } catch (e) {
      console.error('fb watch read failed');
      await saveNote('could not reach Meta to read posts');
      return { ran: true, commented: 0, note: 'could not reach Meta' };
    }

    const nowMs = Date.now();
    const fresh = posts
      .filter((p): p is { id: string; created_time: string } => !!p.id && !!p.created_time)
      .map((p) => ({ id: p.id, ms: parseFbTime(p.created_time) }))
      .filter((p) => !isNaN(p.ms) && p.ms > startedMs && nowMs - p.ms <= MAX_AGE_MS)
      .sort((a, b) => a.ms - b.ms);
    if (fresh.length === 0) return { ran: true, commented: 0, note: 'no new posts' };

    const { data: known } = await supabase
      .from('fb_comment_log')
      .select('post_id')
      .in('post_id', fresh.map((p) => p.id));
    const knownIds = new Set((known ?? []).map((r: { post_id: string }) => r.post_id));
    const todo = fresh.filter((p) => !knownIds.has(p.id)).slice(0, MAX_PER_RUN);
    if (todo.length === 0) return { ran: true, commented: 0, note: 'no new posts' };

    let commented = 0;
    let lastNote = '';
    for (const post of todo) {
      // Claim first, so the same post can never be commented twice.
      const claim = await supabase.from('fb_comment_log').insert({ post_id: post.id, status: 'claiming' });
      if (claim.error) {
        lastNote = claim.error.code === '23505' ? 'already handled ' + post.id : 'could not write the log';
        continue;
      }
      const message = await pickComment();
      if (!message) {
        await supabase
          .from('fb_comment_log')
          .update({ status: 'failed', error: 'no comments in the list', updated_at: new Date().toISOString() })
          .eq('post_id', post.id);
        lastNote = 'no comments in the list';
        continue;
      }
      const result = await postComment(post.id, message, pageToken);
      if (result.ok) {
        await supabase
          .from('fb_comment_log')
          .update({ status: 'posted', comment_id: result.commentId ?? null, updated_at: new Date().toISOString() })
          .eq('post_id', post.id);
        commented++;
        lastNote = 'commented on ' + post.id;
      } else {
        await supabase
          .from('fb_comment_log')
          .update({ status: 'failed', error: (result.error ?? '').slice(0, 300), updated_at: new Date().toISOString() })
          .eq('post_id', post.id);
        lastNote = 'failed on ' + post.id + ': ' + (result.error ?? 'unknown');
      }
    }
    await saveNote(lastNote || 'checked');
    return { ran: true, commented, note: lastNote || 'checked' };
  } catch (e) {
    console.error('fb watch error', e);
    return { ran: false, commented: 0, note: 'error' };
  }
}
