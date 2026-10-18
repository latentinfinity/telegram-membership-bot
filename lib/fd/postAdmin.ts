// Admin Panel -> Tickets -> Auto Posting: switches and the latest posts.
// Replaces the SQL switch. Times and the footer line stay in fd_post_settings.
import { createAdminClient } from '../supabase/admin';
import { sendMessage } from '../telegram';
import type { InlineKeyboard } from '../telegram';
import { nigeriaParts } from './fixturesPost';

type S = {
  enabled: boolean; send_channel: boolean; send_group: boolean;
  week_day: number; week_time: string; today_time: string; pred_time: string; footer: string;
};
type LogRow = { post_key: string; status: string; error: string | null; updated_at: string };

const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const onoff = (b: boolean) => (b ? 'ON' : 'OFF');

async function load(): Promise<{ s: S | null; logs: LogRow[]; error?: string }> {
  const db = createAdminClient();
  const r = await db.from('fd_post_settings').select('*').eq('id', 1).maybeSingle();
  if (r.error || !r.data) return { s: null, logs: [], error: r.error ? r.error.message : 'settings row missing' };
  const l = await db.from('fd_post_log').select('post_key, status, error, updated_at')
    .order('created_at', { ascending: false }).limit(8);
  return { s: r.data as S, logs: (l.data || []) as LogRow[] };
}

function text(s: S, logs: LogRow[]): string {
  const lines = [
    '📡 Auto Posting',
    '',
    'Master switch: ' + onoff(s.enabled),
    'Public channel (normal predictions + fixtures): ' + onoff(s.send_channel),
    'Paid group (premium predictions): ' + onoff(s.send_group),
    '',
    'Times (Nigeria): week fixtures ' + (DAY[s.week_day] || 'Mon') + ' ' + s.week_time +
      ' · today fixtures ' + s.today_time + ' · predictions ' + s.pred_time,
    s.footer ? 'Footer line: set' : 'Footer line: none',
    '',
  ];
  if (logs.length === 0) lines.push('No posts sent yet.');
  else {
    lines.push('Latest posts:');
    for (const x of logs) {
      const t = nigeriaParts(x.updated_at);
      const mark = x.status === 'sent' ? '✅' : x.status === 'failed' ? '❌' : '⏳';
      lines.push(mark + ' ' + x.post_key + ' (' + t.label + ' ' + t.hhmm + ')' +
        (x.status === 'failed' && x.error ? ' ' + x.error.slice(0, 60) : ''));
    }
  }
  return lines.join('\n');
}

function keyboard(s: S): InlineKeyboard {
  return [
    [{ text: (s.enabled ? '🔴 Switch OFF master' : '🟢 Switch ON master'), callback_data: 'a_tk_ap_master' }],
    [{ text: (s.send_channel ? 'Channel: ON (tap to turn off)' : 'Channel: OFF (tap to turn on)'), callback_data: 'a_tk_ap_channel' }],
    [{ text: (s.send_group ? 'Paid group: ON (tap to turn off)' : 'Paid group: OFF (tap to turn on)'), callback_data: 'a_tk_ap_group' }],
    [{ text: '🔄 Refresh', callback_data: 'a_tk_ap' }],
    [{ text: '⬅️ Tickets Menu', callback_data: 'a_tk_menu' }],
  ];
}

async function showMenu(chatId: number): Promise<void> {
  const d = await load();
  if (!d.s) {
    await sendMessage(chatId, '❌ Could not read the posting settings: ' + d.error + '\nCheck that the SQL tables were created.',
      [[{ text: '⬅️ Tickets Menu', callback_data: 'a_tk_menu' }]]);
    return;
  }
  await sendMessage(chatId, text(d.s, d.logs), keyboard(d.s));
}

async function setField(field: 'enabled' | 'send_channel' | 'send_group', value: boolean): Promise<string | null> {
  const db = createAdminClient();
  const r = await db.from('fd_post_settings').update({ [field]: value }).eq('id', 1);
  return r.error ? r.error.message : null;
}

export async function handlePostAdmin(data: string, chatId: number): Promise<void> {
  try {
    if (data === 'a_tk_ap') { await showMenu(chatId); return; }
    const d = await load();
    if (!d.s) { await showMenu(chatId); return; }
    const s = d.s;
    if (data === 'a_tk_ap_master') {
      if (s.enabled) {
        const e = await setField('enabled', false);
        if (e) await sendMessage(chatId, '❌ ' + e);
        await showMenu(chatId);
      } else {
        await sendMessage(chatId,
          'Switch automatic posting ON?\n\nPosts then go out by themselves on the schedule. If it is past 08:00 Nigerian time, ' +
            'this week\'s and today\'s fixtures posts go out right away, and the predictions post goes out once it is past ' + s.pred_time + '.\n\n' +
            'Channel: ' + onoff(s.send_channel) + ' · Paid group: ' + onoff(s.send_group),
          [[{ text: '✅ Yes, switch ON', callback_data: 'a_tk_ap_master_yes' }],
           [{ text: '↩️ No', callback_data: 'a_tk_ap' }]]);
      }
    } else if (data === 'a_tk_ap_master_yes') {
      const e = await setField('enabled', true);
      if (e) await sendMessage(chatId, '❌ ' + e);
      await showMenu(chatId);
    } else if (data === 'a_tk_ap_channel') {
      const e = await setField('send_channel', !s.send_channel);
      if (e) await sendMessage(chatId, '❌ ' + e);
      await showMenu(chatId);
    } else if (data === 'a_tk_ap_group') {
      const e = await setField('send_group', !s.send_group);
      if (e) await sendMessage(chatId, '❌ ' + e);
      await showMenu(chatId);
    }
  } catch (e) {
    console.error('auto posting menu failed', e);
    await sendMessage(chatId, '❌ Something went wrong in the Auto Posting menu.');
  }
}
