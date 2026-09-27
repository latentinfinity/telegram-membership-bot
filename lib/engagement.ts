import { createAdminClient } from '@/lib/supabase/admin';
import { getChannelProfile } from '@/lib/channelProfile';
import type { ChannelProfile } from '@/lib/channelProfile';
import { getChannelConfig } from '@/lib/channel';
import { generateText } from '@/lib/ai';

function endpoint(method: string) {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function sendPost(chatId: number, text: string) {
  const res = await fetch(endpoint('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const json = await res.json();
  return json.ok ? { ok: true } : { ok: false, error: json.description ?? 'Send failed' };
}

async function sendPoll(chatId: number, question: string, options: string[]) {
  const res = await fetch(endpoint('sendPoll'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      question,
      options,
      is_anonymous: true,
      allows_multiple_answers: false,
    }),
  });
  const json = await res.json();
  return json.ok ? { ok: true } : { ok: false, error: json.description ?? 'Send failed' };
}

// Nigeria has no DST, so a fixed-offset-free Intl lookup is reliable here.
function nigeriaHourMinute(d: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour, minute };
}

async function countToday(postType: 'post' | 'poll') {
  const supabase = createAdminClient();
  const todayUtc = new Date().toISOString().slice(0, 10);
  const { count } = await supabase
    .from('engagement_posts_log')
    .select('id', { count: 'exact', head: true })
    .eq('post_type', postType)
    .gte('sent_at', todayUtc + 'T00:00:00.000Z')
    .lt('sent_at', todayUtc + 'T23:59:59.999Z');
  return count ?? 0;
}

async function recentTopics(limit = 8) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('engagement_posts_log')
    .select('content')
    .order('sent_at', { ascending: false })
    .limit(limit);
  return (data ?? []).map((r) => r.content as string);
}

async function logContent(postType: 'post' | 'poll', content: string) {
  const supabase = createAdminClient();
  await supabase.from('engagement_posts_log').insert({ post_type: postType, content });
}

// buildSystemPrompt() — the hard "no fixture knowledge" rule below is
// intentionally NOT driven by the niche/topics_to_avoid text in the
// database. It always applies, regardless of what an admin later types
// into those fields, because this bot has no live sports data source
// and the AI has no way to know what's actually being played. Without
// this, a well-meaning niche edit ("weekend match previews") could
// silently reopen the hallucination problem this guardrail exists to
// prevent.
function buildSystemPrompt(profile: ChannelProfile) {
  return (
    'You write content for a Telegram channel.\n' +
    'Niche: ' + (profile.niche || 'general sports') + '\n' +
    'Tone: ' + (profile.tone || 'neutral') + '\n' +
    'Never mention or write about: ' + (profile.topics_to_avoid || 'nothing specific') + '\n' +
    'HARD RULE, NEVER BREAK THIS: you have no access to real-time sports ' +
    'data, fixtures, results, or odds. Never invent, name, or imply ' +
    'knowledge of any specific match, team fixture, scoreline, or date. ' +
    'Write only generic, evergreen content — hype, opinion questions, ' +
    'trivia, discussion starters, betting psychology. If a prompt asks ' +
    'for anything that would require knowing an actual upcoming match, ' +
    'write about the general topic instead, never a specific game.\n' +
    'Never make guarantees. Keep it concise and native to Telegram.'
  );
}

// dispatchEngagementContent() — called every minute by the same dispatch
// route that already handles scheduled posts and the daily ad. On each
// tick: check the posting window, check remaining daily slots, and roll
// a chance proportional to (slots remaining / minutes remaining in the
// window) so posts spread naturally across the day instead of firing
// all at once near the start or missing the window entirely near the end.
export async function dispatchEngagementContent() {
  const profile = await getChannelProfile();
  const cfg = await getChannelConfig();
  const channelId = cfg?.channel_id;
  
  if (!profile || !channelId) {
    return { attempted: false, reason: 'not configured' };
  }
  
  if (!profile.ai_posts_enabled) {
    return { attempted: false, reason: 'AI posts disabled' };
  }
  
  const { hour, minute } = nigeriaHourMinute(new Date());
  if (hour < profile.posting_window_start_hour || hour >= profile.posting_window_end_hour) {
    return { attempted: false, reason: 'outside posting window' };
  }
  
  const [postCount, pollCount] = await Promise.all([
    countToday('post'),
    countToday('poll'),
  ]);
  
  const postSlotsLeft = Math.max(0, profile.max_posts_per_day - postCount);
  const pollSlotsLeft = Math.max(0, profile.max_polls_per_day - pollCount);
  const totalSlotsLeft = postSlotsLeft + pollSlotsLeft;
  
  if (totalSlotsLeft === 0) {
    return { attempted: false, reason: 'daily cap reached' };
  }
  
  const nowMinuteOfDay = hour * 60 + minute;
  const windowEndMinuteOfDay = profile.posting_window_end_hour * 60;
  const minutesRemaining = Math.max(1, windowEndMinuteOfDay - nowMinuteOfDay);
  
  const chance = Math.min(1, totalSlotsLeft / minutesRemaining);
  if (Math.random() > chance) {
    return { attempted: false, reason: 'not this tick' };
  }
  
  const wantPoll =
    pollSlotsLeft > 0 &&
    (postSlotsLeft === 0 || Math.random() < pollSlotsLeft / totalSlotsLeft);
  
  const topics = await recentTopics();
  const avoidRepeats = topics.length ?
    '\nDo not repeat these recent topics:\n- ' + topics.join('\n- ') :
    '';
  
  const systemPrompt = buildSystemPrompt(profile);
  
  if (wantPoll) {
    const result = await generateText(
      systemPrompt,
      'Write a short poll for the channel. Format exactly as:\n' +
      'Q: <question>\n' +
      '- <option 1>\n' +
      '- <option 2>\n' +
      '- <option 3 (optional)>\n' +
      '- <option 4 (optional)>\n' +
      'Use 2 to 4 options.' +
      avoidRepeats
    );
    
    if (!result.ok) {
      console.error('engagement poll generation failed', result.error);
      return { attempted: true, sent: false, reason: result.error };
    }
    
    const lines = result.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const qLine = lines.find((l) => l.toLowerCase().startsWith('q:'));
    const optionLines = lines.filter((l) => l.startsWith('-'));
    const question = qLine ? qLine.replace(/^q:\s*/i, '').trim() : null;
    const options = optionLines
      .map((l) => l.replace(/^-+\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 10);
    
    if (!question || options.length < 2) {
      console.error('engagement poll parse failed', result.text);
      return { attempted: true, sent: false, reason: 'could not parse poll format' };
    }
    
    const sendResult = await sendPoll(channelId, question, options);
    if (sendResult.ok) {
      await logContent('poll', question);
      return { attempted: true, sent: true, type: 'poll' };
    }
    return { attempted: true, sent: false, reason: sendResult.error };
  }
  
  const result = await generateText(
    systemPrompt,
    'Write one short, engaging Telegram post (2 to 4 sentences). No hashtag spam, at most one emoji.' +
    avoidRepeats
  );
  
  if (!result.ok) {
    console.error('engagement post generation failed', result.error);
    return { attempted: true, sent: false, reason: result.error };
  }
  
  const sendResult = await sendPost(channelId, result.text);
  if (sendResult.ok) {
    await logContent('post', result.text);
    return { attempted: true, sent: true, type: 'post' };
  }
  return { attempted: true, sent: false, reason: sendResult.error };
}
