// lib/fb/teaser.ts  (NEW) - Facebook teaser posts for Telegram channel posts.
// Matching is not case sensitive and ignores spaces ("Roll Over" = "rollover").
// 1) trigger rules (all words must be present, first match wins)
// 2) generic rule: a number directly before the word "odds" (10 odds, 200+ odds)
// 3) anything else: skipped.
// Every Facebook post gets a drawn image card. The comment under the new post
// is added by the existing watch (lib/fb/watch.ts), which comments on every new
// Page post. Never throws.
import { createAdminClient } from '@/lib/supabase/admin';

const GRAPH = 'https://graph.facebook.com/v26.0';
const SITE = 'https://telegram-membership-bot-five.vercel.app';

type Trigger = {
  id: number;
  name: string;
  words: string[];
  teaser: string;
  image_title: string;
  sort_order: number;
  active: boolean;
};

export type Matched = {
  kind: 'trigger' | 'generic';
  name: string;
  teaser: string;
  title: string;
  sub: string;
};

const DEFAULT_TRIGGERS = [
  {
    name: 'Sportybet Roll Over',
    words: ['sportybet', 'rollover'],
    teaser: "Today's Sportybet Roll Over has been posted. Head over to Telegram to see it.",
    image_title: 'Sportybet Roll Over',
    sort_order: 1,
  },
  {
    name: '1win Roll Over',
    words: ['1win', 'rollover'],
    teaser: "Today's 1win Roll Over has been posted. Head over to Telegram to see it.",
    image_title: '1win Roll Over',
    sort_order: 2,
  },
];

const DEFAULT_GENERIC = '{n} odds have been posted on our Telegram channel. Head over to see them.';

// A number (optionally with a plus) directly before the word odds.
const GENERIC_RE = /(\d+(?:[.,]\d+)?)\s*(\+?)\s*odds\b/i;

function squash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

export function matchText(text: string, triggers: Trigger[], genericText: string): Matched | null {
  const s = squash(text);
  const ordered = triggers
    .filter((t) => t.active && t.words.length > 0)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  for (const t of ordered) {
    if (t.words.every((w) => s.indexOf(squash(w)) !== -1)) {
      return {
        kind: 'trigger',
        name: t.name,
        teaser: t.teaser,
        title: t.image_title,
        sub: 'Posted on Telegram today',
      };
    }
  }
  const m = GENERIC_RE.exec(text);
  if (m) {
    const n = m[1] + m[2];
    return {
      kind: 'generic',
      name: 'generic odds',
      teaser: genericText.split('{n}').join(n),
      title: n + ' odds',
      sub: 'Posted on Telegram',
    };
  }
  return null;
}

async function loadTriggers(): Promise<Trigger[]> {
  const supabase = createAdminClient();
  let { data } = await supabase.from('fb_triggers').select('*');
  if (!data || data.length === 0) {
    // First use: put the two starting triggers in the list.
    await supabase.from('fb_triggers').insert(DEFAULT_TRIGGERS);
    const again = await supabase.from('fb_triggers').select('*');
    data = again.data;
  }
  return (data ?? []) as Trigger[];
}

async function fetchCard(title: string, sub: string): Promise<Blob | null> {
  try {
    const url =
      SITE + '/api/fb/card?' +
      new URLSearchParams({ secret: process.env.DISPATCH_SECRET ?? '', title, sub }).toString();
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return await res.blob();
  } catch (e) {
    console.error('fb card fetch failed');
    return null;
  }
}

async function postPhoto(
  pageId: string,
  pageToken: string,
  message: string,
  card: Blob
): Promise<{ ok: boolean; postId?: string; error?: string }> {
  try {
    const form = new FormData();
    form.append('source', card, 'card.png');
    form.append('message', message);
    form.append('access_token', pageToken);
    const res = await fetch(GRAPH + '/' + encodeURIComponent(pageId) + '/photos', {
      method: 'POST',
      body: form,
      cache: 'no-store',
      signal: AbortSignal.timeout(25000),
    });
    const json = (await res.json()) as {
      id?: string;
      post_id?: string;
      error?: { message?: string; code?: number };
    };
    if (!res.ok || json.error || !(json.post_id || json.id)) {
      return {
        ok: false,
        error: 'Meta error ' + (json.error?.code ?? res.status) + ': ' + (json.error?.message ?? 'unknown'),
      };
    }
    return { ok: true, postId: json.post_id ?? json.id };
  } catch (e) {
    console.error('fb photo post failed');
    return { ok: false, error: 'Could not reach Meta' };
  }
}

export type TeaserResult = { ok: boolean; note: string; matched?: string };

// Matches the text and, unless dryRun, posts the teaser with its image card.
// force = true ignores the teasers on/off switch (used only by the test route).
export async function processTeaser(opts: {
  text: string;
  messageId: number;
  dryRun: boolean;
  force: boolean;
}): Promise<TeaserResult> {
  try {
    const pageId = process.env.FB_PAGE_ID;
    if (!pageId) return { ok: false, note: 'FB_PAGE_ID is not set' };

    const supabase = createAdminClient();
    const { data: settings } = await supabase
      .from('fb_settings')
      .select('page_token, teasers_enabled, generic_teaser')
      .eq('id', 1)
      .maybeSingle();
    if (!settings) return { ok: false, note: 'fb_settings row not found' };
    if (!opts.force && settings.teasers_enabled !== true) {
      return { ok: false, note: 'teaser switch is OFF' };
    }

    const triggers = await loadTriggers();
    const generic =
      typeof settings.generic_teaser === 'string' && settings.generic_teaser.trim()
        ? settings.generic_teaser
        : DEFAULT_GENERIC;
    const matched = matchText(opts.text, triggers, generic);
    if (!matched) return { ok: true, note: 'no rule matched, nothing posted' };

    if (opts.dryRun) {
      return {
        ok: true,
        matched: matched.name,
        note: 'dry run. Would post: "' + matched.teaser + '" with a card titled "' + matched.title + '"',
      };
    }

    const pageToken = typeof settings.page_token === 'string' ? settings.page_token : '';
    if (!pageToken) return { ok: false, note: 'no Page token saved' };

    // Claim the channel post first: one Facebook post per channel post.
    const claim = await supabase
      .from('fb_teaser_log')
      .insert({ channel_message_id: opts.messageId, rule_name: matched.name, status: 'claiming' });
    if (claim.error) {
      if (claim.error.code === '23505') return { ok: true, note: 'already handled', matched: matched.name };
      console.error('fb teaser log insert failed', claim.error.code);
      return { ok: false, note: 'could not write the log' };
    }

    const fail = async (error: string): Promise<TeaserResult> => {
      await supabase
        .from('fb_teaser_log')
        .update({ status: 'failed', error: error.slice(0, 300), updated_at: new Date().toISOString() })
        .eq('channel_message_id', opts.messageId);
      return { ok: false, note: error, matched: matched.name };
    };

    const card = await fetchCard(matched.title, matched.sub);
    if (!card) return await fail('could not draw the image card');

    const posted = await postPhoto(pageId, pageToken, matched.teaser, card);
    if (!posted.ok || !posted.postId) return await fail(posted.error ?? 'post failed');

    await supabase
      .from('fb_teaser_log')
      .update({ status: 'posted', fb_post_id: posted.postId, updated_at: new Date().toISOString() })
      .eq('channel_message_id', opts.messageId);
    return { ok: true, note: 'posted ' + posted.postId, matched: matched.name };
  } catch (e) {
    console.error('fb teaser error', e);
    return { ok: false, note: 'error' };
  }
}

function norm(text: string | null | undefined): string {
  return text ? squash(text) : '';
}

// Called by the Telegram webhook for every new channel post. Never throws.
export async function handleChannelPost(post: {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
}): Promise<void> {
  try {
    const supabase = createAdminClient();
    const { data: ch } = await supabase
      .from('channel_config')
      .select('channel_id, ad_caption')
      .limit(1)
      .maybeSingle();
    if (!ch || !ch.channel_id || Number(ch.channel_id) !== post.chat.id) return;

    const text = (post.text ?? post.caption ?? '').trim();
    if (!text) return;

    // Never make teasers from the bot's own daily ads.
    const { data: ad2 } = await supabase.from('ad2_config').select('ad_caption').eq('id', 1).maybeSingle();
    const t = norm(text);
    for (const ad of [norm(ch.ad_caption), norm(ad2?.ad_caption)]) {
      if (ad.length >= 30 && t.indexOf(ad.slice(0, 60)) !== -1) return;
    }

    await processTeaser({ text, messageId: post.message_id, dryRun: false, force: false });
  } catch (e) {
    console.error('fb channel post error', e);
  }
}
