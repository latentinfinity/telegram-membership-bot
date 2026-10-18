// Sends the scheduled posts. Never sends the same post twice (claim row in fd_post_log).
// Switched off by default: fd_post_settings.enabled must be true.
import { createAdminClient } from '../../supabase/admin';
import { buildLists } from '../lists';
import type { FixtureIn } from '../lists';
import { formatPost } from '../format';
import { formatFixtures, nigeriaParts, dayWindow, weekWindow } from '../fixturesPost';
import type { FxRow } from '../fixturesPost';

export type Settings = {
  enabled: boolean; sendChannel: boolean; sendGroup: boolean;
  weekDay: number; weekTime: string; todayTime: string; predTime: string; footer: string;
};
export type FixtureRow = FixtureIn;
export type Claim = 'claimed' | 'done' | 'busy' | 'gaveup';
export type SendResult = { ok: true; messageId: number } | { ok: false; error: string };
export type Sender = (chatId: string, text: string) => Promise<SendResult>;

export interface PostStore {
  settings(): Promise<Settings | null>;
  channelId(): Promise<string | null>;
  groupId(): string | null;
  fixtures(startIso: string, endIso: string, predictedOnly: boolean): Promise<FixtureRow[]>;
  claim(key: string, kind: string, dest: string): Promise<Claim>;
  finish(key: string, status: 'sent' | 'failed', ids: number[], error: string | null): Promise<void>;
  markPosted(ids: number[]): Promise<void>;
  // optional: which of these keys are already sent (lets the step skip heavy queries)
  doneKeys?(keys: string[]): Promise<Set<string>>;
}

export type PostResult = {
  ok: boolean; enabled: boolean; sent: string[]; failed: string[]; skipped: string[]; note?: string;
};

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function minutesOf(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

export async function runPost(
  store: PostStore, send: Sender, nowMs: number, deadlineMs: number, pauseMs = 300,
): Promise<PostResult> {
  const res: PostResult = { ok: true, enabled: false, sent: [], failed: [], skipped: [] };
  const st = await store.settings();
  if (!st || !st.enabled) { res.note = 'posting is switched off'; return res; }
  res.enabled = true;
  const nowIso = new Date(nowMs).toISOString();
  const nig = nigeriaParts(nowIso);
  const channel = st.sendChannel ? await store.channelId() : null;
  const group = st.sendGroup ? store.groupId() : null;

  // one post: claim, send every message in order, record the result
  const deliver = async (key: string, kind: string, chatId: string, messages: string[]): Promise<boolean> => {
    if (Date.now() >= deadlineMs) { res.skipped.push(`${key}: out of time, next run`); return false; }
    const c = await store.claim(key, kind, chatId);
    if (c !== 'claimed') { if (c !== 'done') res.skipped.push(`${key}: ${c}`); return false; }
    const ids: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const r = await send(chatId, messages[i]);
      if (!r.ok) {
        await store.finish(key, 'failed', ids, r.error);
        res.failed.push(`${key}: ${r.error}${ids.length ? ` (after ${ids.length} of ${messages.length} messages, not retried)` : ''}`);
        return false;
      }
      ids.push(r.messageId);
      if (i < messages.length - 1) await sleep(pauseMs);
    }
    await store.finish(key, 'sent', ids, null);
    res.sent.push(key);
    return true;
  };

  const future = (r: { matchDate: string }) => Date.parse(r.matchDate) > nowMs;
  const toFx = (r: FixtureRow): FxRow => ({ id: r.id, comp: r.comp, compName: r.compName, matchDate: r.matchDate, home: r.home, away: r.away });

  // 1. fixtures for the week (one post per league, once per week)
  if (channel) {
    const w = weekWindow(nig.date);
    const due = nowMs >= Date.parse(w.startIso) + (st.weekDay - 1) * 86400000 + minutesOf(st.weekTime) * 60000;
    if (due) {
      const all = await store.fixtures(w.startIso, w.endIso, false);
      const rows = all.some(future) ? all : [];
      const monday = nigeriaParts(w.startIso).date;
      for (const p of formatFixtures(rows.map(toFx), 'week', nig.date))
        await deliver(`fxweek:${p.comp}:${monday}`, 'fixtures_week', channel, p.messages);
    }
  }

  // 2. fixtures for today (one post per league, once per day)
  if (channel && nig.hhmm >= st.todayTime) {
    const w = dayWindow(nig.date);
    const rows = await store.fixtures(w.startIso, w.endIso, false);
    const byComp: Record<string, FixtureRow[]> = {};
    for (const r of rows) (byComp[r.comp] = byComp[r.comp] || []).push(r);
    const live = rows.filter((r) => byComp[r.comp].some(future));
    for (const p of formatFixtures(live.map(toFx), 'today', nig.date))
      await deliver(`fxday:${p.comp}:${nig.date}`, 'fixtures_today', channel, p.messages);
  }

  // 3. predictions (normal to the channel, premium to the paid group), once per day
  if ((channel || group) && nig.hhmm >= st.predTime) {
    const w = dayWindow(nig.date);
    const need: string[] = [];
    if (channel) need.push(`pred:normal:${nig.date}`);
    if (group) need.push(`pred:premium:${nig.date}`);
    const done = store.doneKeys ? await store.doneKeys(need) : new Set<string>();
    const rows = need.every((k) => done.has(k))
      ? []
      : (await store.fixtures(w.startIso, w.endIso, true)).filter(future);
    if (rows.length > 0) {
      const { lists } = buildLists(rows);
      const withFooter = (m: string[]): string[] => {
        if (!st.footer || m.length === 0) return m;
        const last = m[m.length - 1] + '\n\n' + st.footer;
        return last.length <= 4000 ? [...m.slice(0, -1), last] : [...m, st.footer];
      };
      let any = false;
      const normal = formatPost(lists, false);
      if (channel && normal.length > 0) any = (await deliver(`pred:normal:${nig.date}`, 'predictions', channel, withFooter(normal))) || any;
      const prem = formatPost(lists, true);
      if (group && prem.length > 0) any = (await deliver(`pred:premium:${nig.date}`, 'predictions_premium', group, withFooter(prem))) || any;
      if (any) await store.markPosted(rows.map((r) => r.id));
    }
  }
  res.ok = res.failed.length === 0;
  return res;
}

// ---------- real implementations ----------

export const telegramSender: Sender = async (chatId, text) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN missing' };
  let last = 'unknown error';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      const j = (await r.json()) as { ok: boolean; result?: { message_id: number }; description?: string; parameters?: { retry_after?: number } };
      if (j.ok && j.result) return { ok: true, messageId: j.result.message_id };
      last = j.description || `HTTP ${r.status}`;
      if (r.status === 429) { await sleep(Math.min(10, j.parameters?.retry_after || 3) * 1000); continue; }
      if (r.status >= 500) { await sleep(1000); continue; }
      return { ok: false, error: last };
    } catch (e) {
      last = e instanceof Error ? e.message : 'network error';
      await sleep(1000);
    }
  }
  return { ok: false, error: last };
};

type Res = { data: unknown; error: { message: string } | null };
// Awaits any Supabase query and hands back a plainly typed result (no library type parsing).
async function exec(q: unknown): Promise<Res> {
  return (await (q as PromiseLike<unknown>)) as Res;
}

export function supabasePostStore(): PostStore {
  const db = createAdminClient();
  const names = async (codes: string[]): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    if (codes.length === 0) return out;
    const c = await exec(db.from('fd_competitions').select('code, name').in('code', codes));
    for (const r of ((c.data || []) as { code: string; name: string }[])) out[r.code] = r.name;
    return out;
  };
  return {
    async settings() {
      const r = await exec(db.from('fd_post_settings').select('*').eq('id', 1).maybeSingle());
      const d = r.data as Record<string, unknown> | null;
      if (r.error || !d) return null;
      return {
        enabled: d.enabled === true, sendChannel: d.send_channel === true, sendGroup: d.send_group === true,
        weekDay: Number(d.week_day) || 1, weekTime: String(d.week_time), todayTime: String(d.today_time),
        predTime: String(d.pred_time), footer: String(d.footer || ''),
      };
    },
    async channelId() {
      const r = await exec(db.from('channel_config').select('channel_id').limit(1).maybeSingle());
      const v = (r.data as { channel_id?: unknown } | null)?.channel_id;
      return v === null || v === undefined ? null : String(v);
    },
    groupId() { return process.env.TELEGRAM_GROUP_ID || null; },
    async fixtures(startIso, endIso, predictedOnly) {
      const cols = predictedOnly
        ? 'fd_match_id, comp_code, stage, match_date, home_name, away_name, hs, hc, asc_, ac, f1_home, f1_away, f2_home, f2_away'
        : 'fd_match_id, comp_code, stage, match_date, home_name, away_name';
      const base = db.from('fd_fixtures').select(cols)
        .gte('match_date', startIso).lt('match_date', endIso)
        .order('match_date', { ascending: true }).limit(1000);
      const r = await exec(
        predictedOnly
          ? base.eq('status', 'pending').not('predicted_at', 'is', null)
          : base.in('status', ['pending', 'graded']),
      );
      if (r.error) throw new Error(r.error.message);
      const rows = (r.data || []) as unknown as Record<string, unknown>[];
      const nm = await names(Array.from(new Set(rows.map((x) => String(x.comp_code)))));
      return rows.map((x) => ({
        id: Number(x.fd_match_id), comp: String(x.comp_code), compName: nm[String(x.comp_code)] || String(x.comp_code),
        stage: String(x.stage || ''), matchDate: String(x.match_date), home: String(x.home_name), away: String(x.away_name),
        hs: (x.hs ?? null) as number | string | null, hc: (x.hc ?? null) as number | string | null,
        asc: (x.asc_ ?? null) as number | string | null, ac: (x.ac ?? null) as number | string | null,
        f1h: (x.f1_home ?? null) as number | null, f1a: (x.f1_away ?? null) as number | null,
        f2h: (x.f2_home ?? null) as number | null, f2a: (x.f2_away ?? null) as number | null,
      }));
    },
    async claim(key, kind, dest) {
      const ins = await exec(db.from('fd_post_log').insert({ post_key: key, kind, destination: dest, status: 'sending', attempts: 1 }));
      if (!ins.error) return 'claimed';
      const cur = await exec(db.from('fd_post_log').select('status, attempts, updated_at').eq('post_key', key).maybeSingle());
      const row = cur.data as { status: string; attempts: number; updated_at: string } | null;
      if (!row) return 'busy';
      if (row.status === 'sent') return 'done';
      if (row.status === 'sending') {
        if (Date.now() - Date.parse(row.updated_at) > 600000)
          await exec(db.from('fd_post_log').update({ status: 'failed', attempts: 99, error: 'stuck while sending, not retried to avoid a duplicate', updated_at: new Date().toISOString() }).eq('post_key', key).eq('status', 'sending'));
        return 'busy';
      }
      if (row.attempts >= MAX_ATTEMPTS) return 'gaveup';
      const up = await exec(db.from('fd_post_log')
        .update({ status: 'sending', attempts: row.attempts + 1, updated_at: new Date().toISOString() })
        .eq('post_key', key).eq('status', 'failed').eq('attempts', row.attempts).select('post_key'));
      return up.data && (up.data as unknown[]).length > 0 ? 'claimed' : 'busy';
    },
    async finish(key, status, ids, error) {
      const patch: Record<string, unknown> = { status, message_ids: ids, error, updated_at: new Date().toISOString() };
      if (status === 'sent') patch.sent_at = new Date().toISOString();
      if (status === 'failed' && ids.length > 0) patch.attempts = 99; // partly sent: never auto-retry
      await exec(db.from('fd_post_log').update(patch).eq('post_key', key));
    },
    async doneKeys(keys) {
      if (keys.length === 0) return new Set<string>();
      const r = await exec(db.from('fd_post_log').select('post_key').in('post_key', keys).eq('status', 'sent'));
      return new Set(((r.data || []) as { post_key: string }[]).map((x) => x.post_key));
    },
    async markPosted(ids) {
      if (ids.length === 0) return;
      await exec(db.from('fd_fixtures').update({ posted_at: new Date().toISOString() }).in('fd_match_id', ids).is('posted_at', null));
    },
  };
}

// Entry point used by tick. Never throws: a posting problem must not break the data pipeline.
export async function runPostStep(opts: { deadline: number }): Promise<Record<string, unknown>> {
  try {
    const r = await runPost(supabasePostStore(), telegramSender, Date.now(), opts.deadline);
    return { ...r };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'post step failed' };
  }
}
