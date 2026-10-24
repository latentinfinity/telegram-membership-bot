// lib/fb/fbAdmin.ts  (NEW) - the Facebook menu in the bot.
// Buttons start with a_tk_fb (forwarded here by lib/ticketsUi.ts).
// Replies to the four fb prompts are forwarded here by route.ts.
import { sendMessage } from '@/lib/telegram';
import type { InlineKeyboard } from '@/lib/telegram';
import { clearDraft } from '@/lib/postDrafts';
import { PROMPTS, sendForceReply } from '@/lib/menus';
import { createAdminClient } from '@/lib/supabase/admin';

type Trigger = {
  id: number;
  name: string;
  words: string[];
  teaser: string;
  image_title: string;
  active: boolean;
};

function short(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + '...' : text;
}

function onOff(b: boolean): string {
  return b ? 'ON' : 'OFF';
}

function when(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
  });
}

const BACK: InlineKeyboard = [[{ text: '⬅️ Facebook Menu', callback_data: 'a_tk_fb' }]];

async function count(table: string): Promise<number> {
  const supabase = createAdminClient();
  const { count: c } = await supabase.from(table).select('id', { count: 'exact', head: true });
  return c ?? 0;
}

export async function showFbMenu(chatId: number): Promise<void> {
  const supabase = createAdminClient();
  const { data: s, error } = await supabase
    .from('fb_settings')
    .select('enabled, teasers_enabled, token_saved_at, last_event, last_event_at')
    .eq('id', 1)
    .maybeSingle();
  if (error || !s) {
    await sendMessage(chatId, 'Facebook: could not read the settings row.', [
      [{ text: '⬅️ Tickets Menu', callback_data: 'a_tk_menu' }],
    ]);
    return;
  }
  const comments = await count('fb_comments');
  const triggers = await count('fb_triggers');
  await sendMessage(
    chatId,
    'FACEBOOK\n\n' +
      'Auto comments: ' + onOff(s.enabled === true) + '\n' +
      'Teaser posts: ' + onOff(s.teasers_enabled === true) + '\n' +
      'Page token: ' + (s.token_saved_at ? 'saved' : 'not saved') + '\n' +
      'Comments in the list: ' + comments + '\n' +
      'Triggers: ' + triggers + '\n\n' +
      'Last check: ' + (s.last_event ? short(String(s.last_event), 120) : '-') +
      ' (' + when(s.last_event_at) + ')',
    [
      [
        { text: (s.enabled === true ? '🔴 Stop' : '🟢 Start') + ' Auto Comments', callback_data: 'a_tk_fb_cm_toggle' },
      ],
      [
        { text: (s.teasers_enabled === true ? '🔴 Stop' : '🟢 Start') + ' Teaser Posts', callback_data: 'a_tk_fb_tz_toggle' },
      ],
      [
        { text: '💬 View Comments', callback_data: 'a_tk_fb_cm_list' },
        { text: '➕ Add Comment', callback_data: 'a_tk_fb_cm_add' },
      ],
      [
        { text: '🎯 View Triggers', callback_data: 'a_tk_fb_tg_list' },
        { text: '➕ Add Trigger', callback_data: 'a_tk_fb_tg_add' },
      ],
      [
        { text: '✏️ Edit Teaser Text', callback_data: 'a_tk_fb_tg_edit' },
        { text: '🔢 Odds Text', callback_data: 'a_tk_fb_gen' },
      ],
      [{ text: '📜 Last Posts', callback_data: 'a_tk_fb_last' }],
      [{ text: '⬅️ Tickets Menu', callback_data: 'a_tk_menu' }],
    ]
  );
}

async function toggle(field: 'enabled' | 'teasers_enabled', label: string, chatId: number) {
  const supabase = createAdminClient();
  const { data: s } = await supabase.from('fb_settings').select(field).eq('id', 1).maybeSingle();
  if (!s) {
    await sendMessage(chatId, 'Could not read the settings.');
    return;
  }
  const current = (s as Record<string, unknown>)[field] === true;
  const { error } = await supabase
    .from('fb_settings')
    .update({ [field]: !current, updated_at: new Date().toISOString() })
    .eq('id', 1);
  await sendMessage(
    chatId,
    error ? 'Could not change the switch. Try again.' : label + ' ' + (!current ? 'started.' : 'stopped.')
  );
}

async function listComments(chatId: number) {
  const supabase = createAdminClient();
  const { data } = await supabase.from('fb_comments').select('id, body').order('id', { ascending: true }).limit(20);
  const list = (data ?? []) as { id: number; body: string }[];
  if (list.length === 0) {
    await sendMessage(
      chatId,
      'The comment list is empty. The three starting comments are added automatically the next time a comment is needed, or tap Add Comment.',
      BACK
    );
    return;
  }
  for (const c of list) {
    await sendMessage(chatId, '#' + c.id + '\n' + short(c.body, 600), [
      [{ text: '🗑 Remove this comment', callback_data: 'a_tk_fb_cmdel_' + c.id }],
    ]);
  }
  await sendMessage(chatId, 'That is the list (' + list.length + ').', BACK);
}

async function listTriggers(chatId: number) {
  const supabase = createAdminClient();
  const { data } = await supabase.from('fb_triggers').select('*').order('sort_order', { ascending: true }).order('id', { ascending: true });
  const list = (data ?? []) as Trigger[];
  if (list.length === 0) {
    await sendMessage(chatId, 'No triggers yet. The two starting ones are added automatically with the first channel post, or tap Add Trigger.', BACK);
    return;
  }
  for (const t of list) {
    await sendMessage(
      chatId,
      '#' + t.id + ' ' + t.name + ' (' + onOff(t.active) + ')\n' +
        'Words: ' + t.words.join(' + ') + '\n' +
        'Teaser: ' + short(t.teaser, 300) + '\n' +
        'Image title: ' + t.image_title,
      [
        [
          { text: t.active ? '🔴 Switch off' : '🟢 Switch on', callback_data: 'a_tk_fb_tgon_' + t.id },
          { text: '🗑 Delete', callback_data: 'a_tk_fb_tgdel_' + t.id },
        ],
      ]
    );
  }
  await sendMessage(chatId, 'That is all triggers (' + list.length + ').', BACK);
}

async function lastPosts(chatId: number) {
  const supabase = createAdminClient();
  const { data: tz } = await supabase
    .from('fb_teaser_log')
    .select('rule_name, status, error, created_at')
    .order('created_at', { ascending: false })
    .limit(8);
  const { data: cm } = await supabase
    .from('fb_comment_log')
    .select('status, error, created_at')
    .order('created_at', { ascending: false })
    .limit(5);
  const lines: string[] = ['LAST TEASER POSTS'];
  const t = (tz ?? []) as { rule_name: string | null; status: string; error: string | null; created_at: string }[];
  if (t.length === 0) lines.push('none yet');
  t.forEach((r) =>
    lines.push(when(r.created_at) + ' - ' + (r.rule_name ?? '?') + ' - ' + r.status + (r.error ? ' (' + short(r.error, 80) + ')' : ''))
  );
  lines.push('', 'LAST COMMENTS');
  const c = (cm ?? []) as { status: string; error: string | null; created_at: string }[];
  if (c.length === 0) lines.push('none yet');
  c.forEach((r) => lines.push(when(r.created_at) + ' - ' + r.status + (r.error ? ' (' + short(r.error, 80) + ')' : '')));
  await sendMessage(chatId, lines.join('\n'), BACK);
}

function idFrom(data: string, prefix: string): number | null {
  const rest = data.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

// Every button that starts with a_tk_fb.
export async function handleFbButton(data: string, chatId: number, adminId: number): Promise<void> {
  await clearDraft(adminId); // no half-finished compose draft may swallow the next reply
  const supabase = createAdminClient();

  if (data === 'a_tk_fb') {
    await showFbMenu(chatId);
  } else if (data === 'a_tk_fb_cm_toggle') {
    await toggle('enabled', 'Auto comments', chatId);
    await showFbMenu(chatId);
  } else if (data === 'a_tk_fb_tz_toggle') {
    await toggle('teasers_enabled', 'Teaser posts', chatId);
    await showFbMenu(chatId);
  } else if (data === 'a_tk_fb_cm_list') {
    await listComments(chatId);
  } else if (data === 'a_tk_fb_cm_add') {
    await sendForceReply(chatId, PROMPTS.fbAddComment);
  } else if (data.indexOf('a_tk_fb_cmdel_') === 0) {
    const id = idFrom(data, 'a_tk_fb_cmdel_');
    if (id === null) return;
    const { error } = await supabase.from('fb_comments').delete().eq('id', id);
    await sendMessage(chatId, error ? 'Could not remove it.' : 'Comment removed.', BACK);
  } else if (data === 'a_tk_fb_tg_list') {
    await listTriggers(chatId);
  } else if (data === 'a_tk_fb_tg_add') {
    await sendForceReply(chatId, PROMPTS.fbAddTrigger);
  } else if (data === 'a_tk_fb_tg_edit') {
    await sendForceReply(chatId, PROMPTS.fbEditTeaser);
  } else if (data === 'a_tk_fb_gen') {
    await sendForceReply(chatId, PROMPTS.fbGeneric);
  } else if (data.indexOf('a_tk_fb_tgon_') === 0) {
    const id = idFrom(data, 'a_tk_fb_tgon_');
    if (id === null) return;
    const { data: t } = await supabase.from('fb_triggers').select('active').eq('id', id).maybeSingle();
    if (!t) {
      await sendMessage(chatId, 'Trigger not found.', BACK);
      return;
    }
    const { error } = await supabase.from('fb_triggers').update({ active: t.active !== true }).eq('id', id);
    await sendMessage(chatId, error ? 'Could not change it.' : 'Trigger switched ' + (t.active !== true ? 'on.' : 'off.'), BACK);
  } else if (data.indexOf('a_tk_fb_tgdel_') === 0) {
    const id = idFrom(data, 'a_tk_fb_tgdel_');
    if (id === null) return;
    const { error } = await supabase.from('fb_triggers').delete().eq('id', id);
    await sendMessage(chatId, error ? 'Could not delete it.' : 'Trigger deleted.', BACK);
  } else if (data === 'a_tk_fb_last') {
    await lastPosts(chatId);
  }
}

// The reply to one of the four prompts. command = fb_comment | fb_trigger | fb_tedit | fb_generic.
export async function handleFbReply(chatId: number, command: string, text: string): Promise<void> {
  const supabase = createAdminClient();
  const value = text.trim();

  if (command === 'fb_comment') {
    if (!value || value.length > 2000) {
      await sendMessage(chatId, 'The comment must be between 1 and 2000 characters. Nothing changed.', BACK);
      return;
    }
    const { error } = await supabase.from('fb_comments').insert({ body: value });
    await sendMessage(chatId, error ? 'Could not save the comment. Try again.' : 'Comment added.', BACK);
    return;
  }

  if (command === 'fb_generic') {
    if (!value || value.length > 1000) {
      await sendMessage(chatId, 'The text must be between 1 and 1000 characters. Nothing changed.', BACK);
      return;
    }
    const { error } = await supabase
      .from('fb_settings')
      .update({ generic_teaser: value, updated_at: new Date().toISOString() })
      .eq('id', 1);
    await sendMessage(
      chatId,
      error
        ? 'Could not save the text. Try again.'
        : 'Odds text saved.' + (value.indexOf('{n}') === -1 ? ' Note: it has no {n}, so the number will not appear.' : ''),
      BACK
    );
    return;
  }

  if (command === 'fb_trigger') {
    const parts = value.split('|').map((p) => p.trim());
    if (parts.length < 3 || !parts[0] || !parts[2]) {
      await sendMessage(chatId, 'Could not read that. Send: name | words | teaser | image title. Nothing changed.', BACK);
      return;
    }
    const words = parts[1].split(',').map((w) => w.trim()).filter((w) => w.length > 0);
    const name = parts[0];
    const teaser = parts[2];
    const title = parts[3] ? parts[3] : name;
    if (words.length === 0 || words.some((w) => w.length > 40) || name.length > 60 || teaser.length > 1000 || title.length > 48) {
      await sendMessage(
        chatId,
        'Check the lengths: name up to 60, each word up to 40, teaser up to 1000, image title up to 48, and at least one word. Nothing changed.',
        BACK
      );
      return;
    }
    const { error } = await supabase
      .from('fb_triggers')
      .insert({ name, words, teaser, image_title: title, sort_order: 3 });
    await sendMessage(
      chatId,
      error ? 'Could not save the trigger. Try again.' : 'Trigger added. It is checked after the existing ones.',
      BACK
    );
    return;
  }

  if (command === 'fb_tedit') {
    const bar = value.indexOf('|');
    const idText = bar === -1 ? '' : value.slice(0, bar).trim();
    const teaser = bar === -1 ? '' : value.slice(bar + 1).trim();
    if (!/^\d+$/.test(idText) || !teaser || teaser.length > 1000) {
      await sendMessage(chatId, 'Could not read that. Send: id | new teaser text. Nothing changed.', BACK);
      return;
    }
    const { data, error } = await supabase
      .from('fb_triggers')
      .update({ teaser })
      .eq('id', Number(idText))
      .select('id');
    if (error || !data || data.length === 0) {
      await sendMessage(chatId, 'Trigger #' + idText + ' was not found. Nothing changed.', BACK);
      return;
    }
    await sendMessage(chatId, 'Teaser text saved for trigger #' + idText + '.', BACK);
    return;
  }
}
