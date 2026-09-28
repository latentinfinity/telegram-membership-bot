import { createAdminClient } from '@/lib/supabase/admin';
import { getChannelProfile } from '@/lib/channelProfile';
import { fmtLagos } from '@/lib/scheduledPosts';

function short(text: string, max: number) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

// Counts use the UTC day, same as the caps in engagement.ts and replies.ts,
// so what you see here matches what the caps actually enforce.
export async function getEngagementSummary(): Promise < string > {
  const profile = await getChannelProfile();
  if (!profile) return 'No channel profile found.';
  
  const supabase = createAdminClient();
  const dayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const dayEnd = new Date(Date.parse(dayStart) + 86400000).toISOString();
  
  const [posts, polls, replies, recentPosts, recentReplies] = await Promise.all([
    supabase
    .from('engagement_posts_log')
    .select('id', { count: 'exact', head: true })
    .eq('post_type', 'post')
    .gte('sent_at', dayStart)
    .lt('sent_at', dayEnd),
    supabase
    .from('engagement_posts_log')
    .select('id', { count: 'exact', head: true })
    .eq('post_type', 'poll')
    .gte('sent_at', dayStart)
    .lt('sent_at', dayEnd),
    supabase
    .from('ai_reply_log')
    .select('id', { count: 'exact', head: true })
    .neq('reply_text', '')
    .gte('sent_at', dayStart)
    .lt('sent_at', dayEnd),
    supabase
    .from('engagement_posts_log')
    .select('post_type, content, sent_at')
    .order('sent_at', { ascending: false })
    .limit(3),
    supabase
    .from('ai_reply_log')
    .select('reply_text, sent_at')
    .neq('reply_text', '')
    .order('sent_at', { ascending: false })
    .limit(3),
  ]);
  
  let out =
    '📊 Engagement today (UTC day)\n\n' +
    'AI posts/polls: ' + (profile.ai_posts_enabled ? 'ON ✅' : 'OFF ❌') + '\n' +
    'Posts: ' + (posts.count ?? 0) + '/' + profile.max_posts_per_day + '\n' +
    'Polls: ' + (polls.count ?? 0) + '/' + profile.max_polls_per_day + '\n\n' +
    'AI replies: ' + (profile.ai_replies_enabled ? 'ON ✅' : 'OFF ❌') + '\n' +
    'Replies: ' + (replies.count ?? 0) + '/' + profile.max_replies_per_day +
    ' (cooldown ' + profile.reply_cooldown_minutes + ' min)\n';
  
  out += '\nLatest posts/polls:\n';
  if (!recentPosts.data || recentPosts.data.length === 0) {
    out += '(none yet)\n';
  } else {
    for (const p of recentPosts.data) {
      out +=
        '• [' + p.post_type + '] ' + fmtLagos(new Date(p.sent_at)) + '\n  ' +
        short(String(p.content), 90) + '\n';
    }
  }
  
  out += '\nLatest replies:\n';
  if (!recentReplies.data || recentReplies.data.length === 0) {
    out += '(none yet)';
  } else {
    for (const r of recentReplies.data) {
      out +=
        '• ' + fmtLagos(new Date(r.sent_at)) + '\n  ' +
        short(String(r.reply_text), 90) + '\n';
    }
  }
  
  return out.trim();
}
