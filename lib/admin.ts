import { createAdminClient } from '@/lib/supabase/admin';
import { sendMessage, removeMember } from '@/lib/telegram';
import { issueAccessLink } from '@/lib/processPayment';

export const ADMIN_COMMANDS = [
  '/member',
  '/extend',
  '/revoke',
  '/grant',
  '/price',
  '/stats',
];

const DAY = 86400000;
const NOT_FOUND =
  'Member not found. They must open the bot and tap Start at least once before you can use their username or ID.';

type Sub = {
  id: string;
  status: string;
  current_period_end: string;
  grace_ends_at: string;
  is_complimentary: boolean;
};

function fmt(d: Date) {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function effectiveStatus(sub: Sub) {
  if (sub.status === 'cancelled') return 'cancelled';
  const now = new Date();
  if (now < new Date(sub.current_period_end)) return 'active';
  if (now < new Date(sub.grace_ends_at)) return 'grace';
  return 'expired';
}

function hasAccess(sub: Sub) {
  const s = effectiveStatus(sub);
  return s === 'active' || s === 'grace';
}

async function findUser(arg: string) {
  const supabase = createAdminClient();
  if (/^\d+$/.test(arg)) {
    const { data } = await supabase
      .from('telegram_users')
      .select('id, telegram_id, telegram_username')
      .eq('telegram_id', Number(arg))
      .maybeSingle();
    return data;
  }
  const name = arg.replace(/^@/, '').toLowerCase();
  if (!name) return null;
  const { data } = await supabase
    .from('telegram_users')
    .select('id, telegram_id, telegram_username')
    .ilike('telegram_username', name)
    .limit(5);
  return (
    (data ?? []).find(
      (u) => (u.telegram_username ?? '').toLowerCase() === name
    ) ?? null
  );
}

async function getLiveSub(userId: string): Promise<Sub | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('subscriptions')
    .select('id, status, current_period_end, grace_ends_at, is_complimentary')
    .eq('telegram_user_id', userId)
    .eq('is_deleted', false)
    .maybeSingle();
  return (data as Sub | null) ?? null;
}

async function audit(
  adminId: number,
  action: string,
  targetTelegramId: number | null,
  subscriptionId: string | null,
  reason: string
) {
  const supabase = createAdminClient();
  const { error } = await supabase.from('admin_audit_logs').insert({
    admin_telegram_id: adminId,
    action,
    target_telegram_user_id: targetTelegramId,
    target_subscription_id: subscriptionId,
    reason,
  });
  if (error) console.error('audit insert failed', error);
}

async function extendLive(sub: Sub, days: number) {
  const supabase = createAdminClient();
  const now = new Date();
  const end = new Date(sub.current_period_end);
  const grace = new Date(sub.grace_ends_at);
  const gap = Math.max(0, grace.getTime() - end.getTime());
  const base = end > now ? end : now;
  const newEnd = new Date(base.getTime() + days * DAY);
  const newGrace = new Date(newEnd.getTime() + gap);

  const { error } = await supabase
    .from('subscriptions')
    .update({
      status: 'active',
      current_period_end: newEnd.toISOString(),
      grace_ends_at: newGrace.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('id', sub.id);

  if (error) {
    console.error('extendLive failed', error);
    return null;
  }
  return { newEnd, newGrace };
}

function parseDays(s: string | undefined) {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 3650) return null;
  return n;
}

async function cmdMember(chatId: number, args: string[]) {
  if (args.length < 1) {
    await sendMessage(chatId, 'Usage: /member <@username or ID>');
    return;
  }
  const user = await findUser(args[0]);
  if (!user) {
    await sendMessage(chatId, NOT_FOUND);
    return;
  }
  const sub = await getLiveSub(user.id);
  const who =
    user.telegram_id +
    (user.telegram_username ? ' (@' + user.telegram_username + ')' : '');
  if (!sub) {
    await sendMessage(chatId, who + '\nNo subscription.');
    return;
  }
  await sendMessage(
    chatId,
    who +
      '\nStatus: ' +
      effectiveStatus(sub) +
      '\nType: ' +
      (sub.is_complimentary ? 'free (granted)' : 'paid') +
      '\nExpires: ' +
      fmt(new Date(sub.current_period_end)) +
      '\nGrace ends: ' +
      fmt(new Date(sub.grace_ends_at))
  );
}

async function cmdExtend(chatId: number, adminId: number, args: string[]) {
  const days = parseDays(args[1]);
  const reason = args.slice(2).join(' ').trim();
  if (args.length < 3 || !days || !reason) {
    await sendMessage(chatId, 'Usage: /extend <ID> <days> <reason>');
    return;
  }
  const user = await findUser(args[0]);
  if (!user) {
    await sendMessage(chatId, NOT_FOUND);
    return;
  }
  const sub = await getLiveSub(user.id);
  if (!sub || !hasAccess(sub)) {
    await sendMessage(
      chatId,
      'No live subscription for this member. Use /grant instead.'
    );
    return;
  }
  const result = await extendLive(sub, days);
  if (!result) {
    await sendMessage(chatId, 'Could not extend. Try again.');
    return;
  }
  await audit(adminId, 'extend ' + days + 'd', user.telegram_id, sub.id, reason);
  await sendMessage(
    user.telegram_id,
    'Your membership was extended by ' +
      days +
      ' days. It is now active until ' +
      fmt(result.newEnd) +
      '.'
  );
  await sendMessage(
    chatId,
    'Done. New expiry: ' + fmt(result.newEnd) + '.'
  );
}

async function cmdRevoke(chatId: number, adminId: number, args: string[]) {
  if (args.length < 1) {
    await sendMessage(chatId, 'Usage: /revoke <ID> [reason]');
    return;
  }
  const user = await findUser(args[0]);
  if (!user) {
    await sendMessage(chatId, NOT_FOUND);
    return;
  }
  const sub = await getLiveSub(user.id);
  if (!sub || sub.status === 'cancelled') {
    await sendMessage(chatId, 'No live subscription to revoke.');
    return;
  }
  const reason = args.slice(1).join(' ').trim() || 'no reason given';
  const supabase = createAdminClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('subscriptions')
    .update({ status: 'cancelled', grace_ends_at: now, updated_at: now })
    .eq('id', sub.id);
  if (error) {
    console.error('revoke update failed', error);
    await sendMessage(chatId, 'Could not revoke. Try again.');
    return;
  }

  const removal = await removeMember(user.telegram_id);
  await supabase.from('access_events').insert({
    telegram_user_id: user.id,
    subscription_id: sub.id,
    event_type: 'removed',
    result: removal.ok ? 'success' : 'failed',
    detail: removal.ok ? null : { error: removal.error },
  });

  await audit(adminId, 'revoke', user.telegram_id, sub.id, reason);
  await sendMessage(
    user.telegram_id,
    'Your access has been ended by the admin.'
  );

  if (removal.ok) {
    await sendMessage(chatId, 'Revoked and removed from the group.');
  } else {
    await sendMessage(
      chatId,
      'Subscription revoked, but removal from the group FAILED: ' +
        removal.error +
        '\nRemove them manually if they are still in the group.'
    );
  }
}

async function cmdGrant(chatId: number, adminId: number, args: string[]) {
  const days = parseDays(args[1]);
  const reason = args.slice(2).join(' ').trim();
  if (args.length < 3 || !days || !reason) {
    await sendMessage(chatId, 'Usage: /grant <ID> <days> <reason>');
    return;
  }
  const user = await findUser(args[0]);
  if (!user) {
    await sendMessage(chatId, NOT_FOUND);
    return;
  }
  const supabase = createAdminClient();
  const sub = await getLiveSub(user.id);

  if (sub && hasAccess(sub)) {
    const result = await extendLive(sub, days);
    if (!result) {
      await sendMessage(chatId, 'Could not grant. Try again.');
      return;
    }
    await audit(adminId, 'grant +' + days + 'd', user.telegram_id, sub.id, reason);
    await sendMessage(
      user.telegram_id,
      'You received ' +
        days +
        ' extra days. Your membership is active until ' +
        fmt(result.newEnd) +
        '.'
    );
    await sendMessage(chatId, 'Added ' + days + ' days. New expiry: ' + fmt(result.newEnd) + '.');
    return;
  }

  const { data: plan } = await supabase
    .from('membership_plans')
    .select('id')
    .eq('name', 'monthly')
    .single();
  if (!plan) {
    await sendMessage(chatId, 'Plan missing.');
    return;
  }

  const now = new Date();
  if (sub) {
    await supabase
      .from('subscriptions')
      .update({ is_deleted: true, updated_at: now.toISOString() })
      .eq('id', sub.id);
  }

  const end = new Date(now.getTime() + days * DAY);
  const { data: created, error } = await supabase
    .from('subscriptions')
    .insert({
      telegram_user_id: user.id,
      plan_id: plan.id,
      status: 'active',
      renewal_mode: 'manual',
      current_period_start: now.toISOString(),
      current_period_end: end.toISOString(),
      grace_ends_at: end.toISOString(),
      is_complimentary: true,
    })
    .select('id')
    .single();

  if (error || !created) {
    console.error('grant insert failed', error);
    if (sub) {
      await supabase
        .from('subscriptions')
        .update({ is_deleted: false })
        .eq('id', sub.id);
    }
    await sendMessage(chatId, 'Could not grant. Try again.');
    return;
  }

  await audit(adminId, 'grant ' + days + 'd', user.telegram_id, created.id, reason);

  const delivered = await issueAccessLink({
    telegramUserId: user.id,
    telegramId: user.telegram_id,
    subscriptionId: created.id,
    intro:
      'You have been given free access for ' +
      days +
      ' days, until ' +
      fmt(end) +
      '.',
  });

  await sendMessage(
    chatId,
    'Granted ' +
      days +
      ' days, until ' +
      fmt(end) +
      '.' +
      (delivered ? '' : '\nCould not send the access link. They can tap Get access link in the bot.')
  );
}

async function cmdPrice(chatId: number, adminId: number, args: string[]) {
  const amount = Number(args[0]);
  if (!args[0] || !Number.isFinite(amount) || amount <= 0) {
    await sendMessage(chatId, 'Usage: /price <amount in naira>');
    return;
  }
  const supabase = createAdminClient();
  const { data: plan } = await supabase
    .from('membership_plans')
    .select('id')
    .eq('name', 'monthly')
    .single();
  if (!plan) {
    await sendMessage(chatId, 'Plan missing.');
    return;
  }
  const { data: old } = await supabase
    .from('plan_prices')
    .select('amount')
    .eq('plan_id', plan.id)
    .eq('currency', 'NGN')
    .single();

  const { error } = await supabase
    .from('plan_prices')
    .update({ amount, updated_at: new Date().toISOString() })
    .eq('plan_id', plan.id)
    .eq('currency', 'NGN');
  if (error) {
    console.error('price update failed', error);
    await sendMessage(chatId, 'Could not change the price.');
    return;
  }
  await audit(
    adminId,
    'price NGN ' + (old ? old.amount : '?') + ' -> ' + amount,
    null,
    null,
    'price change'
  );
  await sendMessage(chatId, 'Monthly price is now ₦' + amount.toLocaleString('en-NG') + '.');
}

async function cmdStats(chatId: number) {
  const supabase = createAdminClient();
  const { data: subs } = await supabase
    .from('subscriptions')
    .select('id, status, current_period_end, grace_ends_at, is_complimentary')
    .eq('is_deleted', false);
  const { data: paid } = await supabase
    .from('payments')
    .select('amount')
    .eq('status', 'success');

  let active = 0;
  let grace = 0;
  let expired = 0;
  let free = 0;
  for (const s of (subs ?? []) as Sub[]) {
    const st = effectiveStatus(s);
    if (st === 'active') active++;
    else if (st === 'grace') grace++;
    else expired++;
    if (s.is_complimentary && (st === 'active' || st === 'grace')) free++;
  }
  const revenue = (paid ?? []).reduce((sum, p) => sum + Number(p.amount), 0);

  await sendMessage(
    chatId,
    'Active: ' +
      active +
      '\nGrace: ' +
      grace +
      '\nExpired/cancelled: ' +
      expired +
      '\nFree (granted, currently live): ' +
      free +
      '\nSuccessful payments: ' +
      (paid ?? []).length +
      '\nRevenue: ₦' +
      revenue.toLocaleString('en-NG')
  );
}

export async function handleAdminCommand(
  chatId: number,
  adminId: number,
  command: string,
  args: string[]
) {
  if (command === '/member') return cmdMember(chatId, args);
  if (command === '/extend') return cmdExtend(chatId, adminId, args);
  if (command === '/revoke') return cmdRevoke(chatId, adminId, args);
  if (command === '/grant') return cmdGrant(chatId, adminId, args);
  if (command === '/price') return cmdPrice(chatId, adminId, args);
  if (command === '/stats') return cmdStats(chatId);
}
