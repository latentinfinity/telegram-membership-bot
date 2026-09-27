import { createAdminClient } from '@/lib/supabase/admin';

export type ChannelProfile = {
  id: string;
  niche: string | null;
  tone: string | null;
  topics_to_avoid: string | null;
  posting_window_start_hour: number;
  posting_window_end_hour: number;
  max_posts_per_day: number;
  max_polls_per_day: number;
  ai_posts_enabled: boolean;
  ai_replies_enabled: boolean;
  max_replies_per_day: number;
  reply_cooldown_minutes: number;
  updated_at: string;
};

export async function getChannelProfile(): Promise < ChannelProfile | null > {
  const supabase = createAdminClient();
  const { data, error } = await supabase
  .from('channel_profile')
  .select('*')
  .limit(1)
  .maybeSingle();
  if (error) {
    console.error('getChannelProfile failed', error);
    return null;
  }
  return data as ChannelProfile | null;
}

async function updateProfile(fields: Record < string, unknown > ): Promise < boolean > {
  const profile = await getChannelProfile();
  if (!profile) return false;
  
  const { error } = await createAdminClient()
  .from('channel_profile')
  .update({ ...fields, updated_at: new Date().toISOString() })
  .eq('id', profile.id);
  
  if (error) {
    console.error('updateProfile failed', error);
    return false;
  }
  return true;
}

export async function setNiche(niche: string) {
  return updateProfile({ niche });
}

export async function setTone(tone: string) {
  return updateProfile({ tone });
}

export async function setTopicsToAvoid(topics: string) {
  return updateProfile({ topics_to_avoid: topics });
}

// text like "8-21" (24h Nigeria local hours)
export async function setPostingWindow(text: string): Promise < boolean > {
  const match = text.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!match) return false;
  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  if (start < 0 || start > 23 || end < 0 || end > 23 || start >= end) return false;
  return updateProfile({
    posting_window_start_hour: start,
    posting_window_end_hour: end,
  });
}

// text like "3,1" for max posts,polls per day
export async function setDailyCaps(text: string): Promise < boolean > {
  const match = text.trim().match(/^(\d{1,2})\s*,\s*(\d{1,2})$/);
  if (!match) return false;
  const posts = parseInt(match[1], 10);
  const polls = parseInt(match[2], 10);
  if (posts < 0 || polls < 0) return false;
  return updateProfile({ max_posts_per_day: posts, max_polls_per_day: polls });
}

// text like "20,3" for max replies per day, cooldown minutes
export async function setReplyLimits(text: string): Promise < boolean > {
  const match = text.trim().match(/^(\d{1,3})\s*,\s*(\d{1,3})$/);
  if (!match) return false;
  const maxReplies = parseInt(match[1], 10);
  const cooldown = parseInt(match[2], 10);
  if (maxReplies < 0 || cooldown < 0) return false;
  return updateProfile({
    max_replies_per_day: maxReplies,
    reply_cooldown_minutes: cooldown,
  });
}

export async function toggleAiPosts(): Promise < boolean | null > {
  const profile = await getChannelProfile();
  if (!profile) return null;
  const next = !profile.ai_posts_enabled;
  const ok = await updateProfile({ ai_posts_enabled: next });
  return ok ? next : null;
}

export async function toggleAiReplies(): Promise < boolean | null > {
  const profile = await getChannelProfile();
  if (!profile) return null;
  const next = !profile.ai_replies_enabled;
  const ok = await updateProfile({ ai_replies_enabled: next });
  return ok ? next : null;
}

export function formatProfile(p: ChannelProfile): string {
  return (
    '📋 Channel Profile\n\n' +
    'Niche: ' + (p.niche || '(not set)') + '\n' +
    'Tone: ' + (p.tone || '(not set)') + '\n' +
    'Avoid: ' + (p.topics_to_avoid || '(not set)') + '\n\n' +
    'AI posts/polls: ' + (p.ai_posts_enabled ? 'ON ✅' : 'OFF ❌') + '\n' +
    'Posting window: ' + p.posting_window_start_hour + ':00–' + p.posting_window_end_hour + ':00 (Nigeria time)\n' +
    'Max posts/day: ' + p.max_posts_per_day + '\n' +
    'Max polls/day: ' + p.max_polls_per_day + '\n\n' +
    'AI replies: ' + (p.ai_replies_enabled ? 'ON ✅' : 'OFF ❌') + '\n' +
    'Max replies/day: ' + p.max_replies_per_day + '\n' +
    'Reply cooldown: ' + p.reply_cooldown_minutes + ' min'
  );
}
