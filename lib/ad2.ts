// lib/ad2.ts  (REPLACES the earlier version) - the 1win Ad: a second daily channel ad.
// Own table (ad2_config), own switch, own time. Does not touch channel_config.
import { createAdminClient } from '@/lib/supabase/admin';

export type Ad2Config = {
  ad_caption: string | null;
  ad_image_file_id: string | null;
  ad_enabled: boolean;
  ad_hour_utc: number;
  ad_minute_utc: number;
  last_sent_date: string | null;
};

function endpoint(method: string) {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

// Nigeria is UTC+1 all year (no daylight saving).
export function nigeriaTimeText(hourUtc: number, minuteUtc: number): string {
  return pad((hourUtc + 1) % 24) + ':' + pad(minuteUtc);
}

// "09:30" (Nigerian time) -> UTC hour and minute, or null if not valid.
export function parseNigeriaTime(input: string): { hour: number;minute: number } | null {
  const m = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { hour: (h + 23) % 24, minute: mi };
}

export async function getAd2(): Promise < Ad2Config | null > {
  const supabase = createAdminClient();
  const { data, error } = await supabase
  .from('ad2_config')
  .select('ad_caption, ad_image_file_id, ad_enabled, ad_hour_utc, ad_minute_utc, last_sent_date')
  .eq('id', 1)
  .maybeSingle();
  if (error) {
    console.error('getAd2 failed', error);
    return null;
  }
  return data as Ad2Config | null;
}

async function updateAd2(fields: Record < string, unknown > ): Promise < boolean > {
  const supabase = createAdminClient();
  const { data, error } = await supabase
  .from('ad2_config')
  .update({ ...fields, updated_at: new Date().toISOString() })
  .eq('id', 1)
  .select('id');
  if (error) {
    console.error('updateAd2 failed', error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

export async function setAd2Caption(caption: string | null): Promise < boolean > {
  return updateAd2({ ad_caption: caption });
}

export async function setAd2Image(fileId: string | null): Promise < boolean > {
  return updateAd2({ ad_image_file_id: fileId });
}

export async function setAd2Enabled(enabled: boolean): Promise < boolean > {
  return updateAd2({ ad_enabled: enabled });
}

// Takes Nigerian time text such as "09:30". Only the time changes; the
// "sent today" mark is left alone, so the ad still goes out at most once a day.
export async function setAd2Time(input: string): Promise < boolean > {
  const t = parseNigeriaTime(input);
  if (!t) return false;
  return updateAd2({ ad_hour_utc: t.hour, ad_minute_utc: t.minute });
}

async function sendAd(
  chatId: number,
  ad: { caption: string | null;image_file_id: string | null }
): Promise < { ok: boolean;error ? : string } > {
  try {
    if (ad.image_file_id) {
      const res = await fetch(endpoint('sendPhoto'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          photo: ad.image_file_id,
          caption: ad.caption ?? undefined,
        }),
      });
      const json = await res.json();
      if (!json.ok) return { ok: false, error: json.description ?? 'Send failed' };
      return { ok: true };
    }
    if (ad.caption) {
      const res = await fetch(endpoint('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: ad.caption }),
      });
      const json = await res.json();
      if (!json.ok) return { ok: false, error: json.description ?? 'Send failed' };
      return { ok: true };
    }
    return { ok: false, error: 'Empty ad' };
  } catch (e) {
    console.error('1win ad send failed', e);
    return { ok: false, error: 'Send failed' };
  }
}

// Called by the per-minute dispatch route. Sends at most once per UTC day.
export async function dispatchAd2(): Promise < { sent: boolean;reason ? : string } > {
  const supabase = createAdminClient();
  
  const { data: cfg } = await supabase
  .from('ad2_config')
  .select('id, ad_caption, ad_image_file_id, ad_enabled, ad_hour_utc, ad_minute_utc, last_sent_date')
  .eq('id', 1)
  .maybeSingle();
  if (!cfg || !cfg.ad_enabled) return { sent: false, reason: 'not configured or disabled' };
  if (!cfg.ad_caption && !cfg.ad_image_file_id) return { sent: false, reason: 'no ad content set' };
  
  const { data: ch } = await supabase
  .from('channel_config')
  .select('channel_id')
  .limit(1)
  .maybeSingle();
  const channelId = ch?.channel_id ?? null;
  if (!channelId) return { sent: false, reason: 'no channel configured' };
  
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  if (cfg.last_sent_date === todayUtc) return { sent: false, reason: 'already sent today' };
  
  const scheduled = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      cfg.ad_hour_utc,
      cfg.ad_minute_utc
    )
  );
  if (now < scheduled) return { sent: false, reason: 'not time yet' };
  
  // Claim today before sending, so a second tick can never send it again.
  const { data: claimed } = await supabase
  .from('ad2_config')
  .update({ last_sent_date: todayUtc })
  .eq('id', 1)
  .or('last_sent_date.is.null,last_sent_date.neq.' + todayUtc)
  .select('id');
  if (!claimed || claimed.length === 0) return { sent: false, reason: 'already claimed' };
  
  const result = await sendAd(channelId as number, {
    caption: cfg.ad_caption,
    image_file_id: cfg.ad_image_file_id,
  });
  return result.ok ? { sent: true } : { sent: false, reason: result.error };
}
