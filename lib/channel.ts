import { createAdminClient } from '@/lib/supabase/admin';

export type ChannelConfig = {
  channel_id: number | null;
  ad_caption: string | null;
  ad_image_file_id: string | null;
  ad_enabled: boolean;
  ad_hour_utc: number;
  ad_minute_utc: number;
  last_sent_date: string | null;
};

export async function getChannelConfig(): Promise < ChannelConfig | null > {
  const supabase = createAdminClient();
  const { data } = await supabase
  .from('channel_config')
  .select(
    'channel_id, ad_caption, ad_image_file_id, ad_enabled, ad_hour_utc, ad_minute_utc, last_sent_date'
  )
  .limit(1)
  .maybeSingle();
  return data as ChannelConfig | null;
}

export async function setChannelId(channelId: number) {
  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from('channel_config')
    .select('id')
    .limit(1)
    .maybeSingle();
  if (!existing) return false;
  const { error } = await supabase
    .from('channel_config')
    .update({ channel_id: channelId, updated_at: new Date().toISOString() })
    .eq('id', existing.id);
  return !error;
}

export async function setAd(params: {
  caption: string | null;
  imageFileId: string | null;
}) {
  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from('channel_config')
    .select('id')
    .limit(1)
    .maybeSingle();
  if (!existing) return false;
  const { error } = await supabase
    .from('channel_config')
    .update({
      ad_caption: params.caption,
      ad_image_file_id: params.imageFileId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id);
  return !error;
}

export async function setAdEnabled(enabled: boolean) {
  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from('channel_config')
    .select('id')
    .limit(1)
    .maybeSingle();
  if (!existing) return false;
  const { error } = await supabase
    .from('channel_config')
    .update({ ad_enabled: enabled, updated_at: new Date().toISOString() })
    .eq('id', existing.id);
  return !error;
}
