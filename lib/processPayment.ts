import { createAdminClient } from '@/lib/supabase/admin';
import { sendMessage, createJoinRequestLink } from '@/lib/telegram';
import { isInGroup } from '@/lib/membership';

export type ProcessResult =
  | { ok: true; alreadyProcessed: boolean }
  | { ok: false; error: string };

async function verifyWithPaystack(
  reference: string,
  expectedKobo: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
        cache: 'no-store',
      }
    );
    const json = await res.json();
    if (!res.ok || !json.status) {
      return { ok: false, error: json.message ?? 'Verify failed' };
    }
    const d = json.data;
    if (d.status !== 'success') {
      return { ok: false, error: 'Payment not successful: ' + d.status };
    }
    if (d.currency !== 'NGN' || d.amount !== expectedKobo) {
      return { ok: false, error: 'Amount or currency mismatch' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function issueAccessLink(params: {
  telegramUserId: string;
  telegramId: number;
  subscriptionId: string | null;
  intro: string;
}) {
  const supabase = createAdminClient();

  // Already in the group: no link needed, nothing to share
  if (await isInGroup(params.telegramId)) {
    const base =
      params.intro === 'Here is your access link.' ? '' : params.intro + '\n\n';
    await sendMessage(
      params.telegramId,
      base + 'You are already in the group, so no link is needed.',
      [[{ text: '⬅️ Menu', callback_data: 'menu' }]]
    );
    return true;
  }

  const link = await createJoinRequestLink({
    name: 'sub-' + params.telegramId,
    expireInHours: 24,
  });

  await supabase.from('access_events').insert({
    telegram_user_id: params.telegramUserId,
    subscription_id: params.subscriptionId,
    event_type: 'invite_created',
    result: link.ok ? 'success' : 'failed',
    detail: link.ok ? null : { error: link.error },
  });

  if (!link.ok) {
    await sendMessage(
      params.telegramId,
      params.intro +
        '\n\nWe could not create your access link. Tap the button below to try again.',
      [[{ text: 'Get access link', callback_data: 'get_link' }]]
    );
    return false;
  }

  await sendMessage(
    params.telegramId,
    params.intro +
      '\n\nTap the button below, then tap "Request to Join". The link works for 24 hours.',
    [[{ text: 'Join the group', url: link.link }]]
  );
  return true;
}

export async function processSuccessfulPayment(
  reference: string
): Promise<ProcessResult> {
  const supabase = createAdminClient();

  const { data: payment } = await supabase
    .from('payments')
    .select('id, telegram_user_id, subscription_id, amount, status')
    .eq('payment_reference', reference)
    .maybeSingle();

  if (!payment) return { ok: false, error: 'Payment not found' };

  if (payment.status === 'success' && payment.subscription_id) {
    return { ok: true, alreadyProcessed: true };
  }
  if (payment.status !== 'pending' && payment.status !== 'success') {
    return { ok: false, error: 'Payment status is ' + payment.status };
  }

  if (payment.status === 'pending') {
    const check = await verifyWithPaystack(
      reference,
      Math.round(Number(payment.amount) * 100)
    );
    if (!check.ok) return { ok: false, error: check.error };

    const { data: claimed } = await supabase
      .from('payments')
      .update({ status: 'success' })
      .eq('id', payment.id)
      .eq('status', 'pending')
      .select('id');

    if (!claimed || claimed.length === 0) {
      return { ok: true, alreadyProcessed: true };
    }
  }

  const { data: user } = await supabase
    .from('telegram_users')
    .select('id, telegram_id')
    .eq('id', payment.telegram_user_id)
    .single();

  const { data: plan } = await supabase
    .from('membership_plans')
    .select('id, duration_days, grace_days')
    .eq('name', 'monthly')
    .single();

  if (!user || !plan) return { ok: false, error: 'User or plan missing' };

  const now = new Date();

  const { data: live } = await supabase
    .from('subscriptions')
    .select('id, status, current_period_end')
    .eq('telegram_user_id', user.id)
    .eq('is_deleted', false)
    .maybeSingle();

  let base = now;
  if (live && (live.status === 'active' || live.status === 'grace')) {
    const liveEnd = new Date(live.current_period_end);
    if (liveEnd > now) base = liveEnd;
  }

  const DAY = 86400000;
  const periodEnd = new Date(base.getTime() + plan.duration_days * DAY);
  const graceEnd = new Date(periodEnd.getTime() + plan.grace_days * DAY);

  if (live) {
    await supabase
      .from('subscriptions')
      .update({ is_deleted: true, updated_at: now.toISOString() })
      .eq('id', live.id);
  }

  const { data: sub, error: subError } = await supabase
    .from('subscriptions')
    .insert({
      telegram_user_id: user.id,
      plan_id: plan.id,
      status: 'active',
      renewal_mode: 'manual',
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString(),
      grace_ends_at: graceEnd.toISOString(),
    })
    .select('id')
    .single();

  if (subError || !sub) {
    if (live) {
      await supabase
        .from('subscriptions')
        .update({ is_deleted: false })
        .eq('id', live.id);
    }
    return { ok: false, error: 'Subscription insert failed' };
  }

  await supabase
    .from('payments')
    .update({ subscription_id: sub.id })
    .eq('id', payment.id);

  const until = periodEnd.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  await issueAccessLink({
    telegramUserId: user.id,
    telegramId: user.telegram_id,
    subscriptionId: sub.id,
    intro: 'Payment received. Your membership is active until ' + until + '.',
  });

  return { ok: true, alreadyProcessed: false };
}
