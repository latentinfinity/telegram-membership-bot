import { createAdminClient } from '@/lib/supabase/admin';

function endpoint(method: string) {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

export type Destination = 'group' | 'channel';

export function parseSendAt(input: string): Date | null {
  const m = input.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  const utcMs = Date.UTC(y, mo - 1, d, h - 1, mi);
  const date = new Date(utcMs);
  if (isNaN(date.getTime())) return null;
  return date;
}

export function fmtLagos(d: Date) {
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
  });
}

export async function createScheduledPost(params: {
  createdBy: number;
  caption: string | null;
  imageFileId: string | null;
  sendAt: Date;
  destination: Destination;
}) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('scheduled_posts')
    .insert({
      created_by: params.createdBy,
      caption: params.caption,
      image_file_id: params.imageFileId,
      send_at: params.sendAt.toISOString(),
      status: 'pending',
      destination: params.destination,
    })
    .select('id')
    .single();
  if (error) {
    console.error('createScheduledPost failed', error);
    return null;
  }
  return data.id as string;
}

export async function listPending(destination: Destination, limit = 10) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('scheduled_posts')
    .select('id, caption, image_file_id, send_at')
    .eq('status', 'pending')
    .eq('destination', destination)
    .order('send_at', { ascending: true })
    .limit(limit);
  return data ?? [];
}

export async function cancelPost(id: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('scheduled_posts')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id');
  if (error) {
    console.error('cancelPost failed', error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

async function sendToChat(
  chatId: number,
  post: { caption: string | null;image_file_id: string | null }
) {
  if (post.image_file_id) {
    const res = await fetch(endpoint('sendPhoto'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: post.image_file_id,
        caption: post.caption ?? undefined,
      }),
    });
    const json = await res.json();
    if (!json.ok) return { ok: false, error: json.description ?? 'Send failed' };
    return { ok: true };
  }
  
  if (post.caption) {
    const res = await fetch(endpoint('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: post.caption }),
    });
    const json = await res.json();
    if (!json.ok) return { ok: false, error: json.description ?? 'Send failed' };
    return { ok: true };
  }
  
  return { ok: false, error: 'Empty post' };
}

export async function dispatchDuePosts() {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();
  
  const { data: due } = await supabase
    .from('scheduled_posts')
    .select('id, caption, image_file_id, destination')
    .eq('status', 'pending')
    .lte('send_at', nowIso)
    .order('send_at', { ascending: true })
    .limit(5);
  
  let sent = 0;
  let failed = 0;
  
  const { data: channelRow, error: channelErr } = await supabase
    .from('channel_config')
    .select('channel_id')
    .limit(1)
    .maybeSingle();
  if (channelErr) {
    console.error('channel_config lookup failed in dispatchDuePosts', channelErr);
  }
  const channelId = channelRow?.channel_id ?? null;
  const groupId = Number(process.env.TELEGRAM_GROUP_ID);
  
  for (const post of due ?? []) {
    const { data: claimed } = await supabase
      .from('scheduled_posts')
      .update({ status: 'sending' })
      .eq('id', post.id)
      .eq('status', 'pending')
      .select('id');
    if (!claimed || claimed.length === 0) continue;
    
    const targetChatId =
      post.destination === 'channel' ? channelId : groupId;
    
    if (!targetChatId) {
      console.error(
        'dispatchDuePosts: no channel configured, channelRow was',
        JSON.stringify(channelRow),
        'error was',
        JSON.stringify(channelErr)
      );
      await supabase
        .from('scheduled_posts')
        .update({ status: 'failed', error: 'No channel configured' })
        .eq('id', post.id);
      failed++;
      continue;
    }
    
    const result = await sendToChat(targetChatId, post);
    
    if (result.ok) {
      await supabase
        .from('scheduled_posts')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', post.id);
      sent++;
    } else {
      await supabase
        .from('scheduled_posts')
        .update({ status: 'failed', error: result.error })
        .eq('id', post.id);
      failed++;
    }
  }
  
  return { sent, failed, checked: (due ?? []).length };
}

export async function dispatchDailyAd() {
  const supabase = createAdminClient();
  const { data: cfg } = await supabase
    .from('channel_config')
    .select(
      'id, channel_id, ad_caption, ad_image_file_id, ad_enabled, ad_hour_utc, ad_minute_utc, last_sent_date'
    )
    .limit(1)
    .maybeSingle();
  
  if (!cfg || !cfg.ad_enabled || !cfg.channel_id) {
    return { sent: false, reason: 'not configured or disabled' };
  }
  if (!cfg.ad_caption && !cfg.ad_image_file_id) {
    return { sent: false, reason: 'no ad content set' };
  }
  
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  if (cfg.last_sent_date === todayUtc) {
    return { sent: false, reason: 'already sent today' };
  }
  
  const scheduled = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      cfg.ad_hour_utc,
      cfg.ad_minute_utc
    )
  );
  if (now < scheduled) {
    return { sent: false, reason: 'not time yet' };
  }
  
  const { data: claimed } = await supabase
    .from('channel_config')
    .update({ last_sent_date: todayUtc })
    .eq('id', cfg.id)
    .or('last_sent_date.is.null,last_sent_date.neq.' + todayUtc)
    .select('id');
  if (!claimed || claimed.length === 0) {
    return { sent: false, reason: 'already claimed' };
  }
  
  const result = await sendToChat(cfg.channel_id, {
    caption: cfg.ad_caption,
    image_file_id: cfg.ad_image_file_id,
  });
  
  return result.ok ?
    { sent: true } :
    { sent: false, reason: result.error };
}
