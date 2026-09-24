import { createAdminClient } from '@/lib/supabase/admin';
import { sendMessage } from '@/lib/telegram';
import { userMenu } from '@/lib/menus';

const DAY = 86400000;

function fmt(d: Date) {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export async function showMenu(chatId: number, admin: boolean) {
  await sendMessage(
    chatId,
    'What would you like to do? Tap a button below.',
    userMenu(admin)
  );
}

export async function showHelp(chatId: number, admin: boolean) {
  await sendMessage(
    chatId,
    'How this works:\n\n' +
      '1. Tap Subscribe / Renew and pay securely.\n' +
      '2. After payment you get a link to the private group. Tap it, then tap "Request to Join".\n' +
      '3. Tap My Status any time to see when your membership ends.\n\n' +
      'After your membership ends you get a few days of grace. Renew before then to keep access.\n\n' +
      'Problem with a payment? Tap Payment Support.',
    userMenu(admin)
  );
}

export async function showStatus(
  chatId: number,
  telegramId: number,
  admin: boolean
) {
  const supabase = createAdminClient();

  const { data: user } = await supabase
    .from('telegram_users')
    .select('id')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  const { data: sub } = user
    ? await supabase
        .from('subscriptions')
        .select('status, current_period_end, grace_ends_at, is_complimentary')
        .eq('telegram_user_id', user.id)
        .eq('is_deleted', false)
        .maybeSingle()
    : { data: null };

  const now = new Date();
  let state: 'none' | 'active' | 'grace' = 'none';
  if (sub && sub.status !== 'cancelled') {
    if (now < new Date(sub.current_period_end)) state = 'active';
    else if (now < new Date(sub.grace_ends_at)) state = 'grace';
  }

  if (!sub || state === 'none') {
    await sendMessage(
      chatId,
      'You do not have an active membership.',
      [
        [{ text: '💳 Subscribe', callback_data: 'subscribe' }],
        [{ text: '⬅️ Menu', callback_data: 'menu' }],
      ]
    );
    return;
  }

  const end = new Date(sub.current_period_end);
  const graceEnd = new Date(sub.grace_ends_at);
  const kind = sub.is_complimentary ? 'Free access' : 'Paid';

  let text: string;
  if (state === 'active') {
    const daysLeft = Math.max(
      1,
      Math.ceil((end.getTime() - now.getTime()) / DAY)
    );
    text =
      'Status: Active\nType: ' +
      kind +
      '\nExpires: ' +
      fmt(end) +
      '\nDays left: ' +
      daysLeft;
  } else {
    text =
      'Status: Grace period\nYour membership ended on ' +
      fmt(end) +
      '. Your access stops on ' +
      fmt(graceEnd) +
      '. Renew now to keep it.';
  }

  await sendMessage(chatId, text, [
    [{ text: '💳 Renew', callback_data: 'subscribe' }],
    [{ text: '🔗 Access Link', callback_data: 'get_link' }],
    [{ text: '⬅️ Menu', callback_data: 'menu' }],
  ]);
  void admin;
}

export async function showPaySupport(chatId: number, telegramId: number) {
  const supabase = createAdminClient();
  const contact = process.env.SUPPORT_CONTACT || 'the admin';

  const { data: user } = await supabase
    .from('telegram_users')
    .select('id')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  let recent = '';
  if (user) {
    const { data: pays } = await supabase
      .from('payments')
      .select('payment_reference, amount, status, created_at')
      .eq('telegram_user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(3);

    if (pays && pays.length > 0) {
      recent =
        '\n\nYour latest payments:\n' +
        pays
          .map(
            (p) =>
              '• ₦' +
              Number(p.amount).toLocaleString('en-NG') +
              ' - ' +
              p.status +
              ' - ' +
              fmt(new Date(p.created_at)) +
              '\n  Ref: ' +
              p.payment_reference
          )
          .join('\n');
    }
  }

  await sendMessage(
    chatId,
    'Payment help\n\nIf you paid and did not get access, or were charged wrongly, contact ' +
      contact +
      '.\n\nSend them your Telegram ID (' +
      telegramId +
      ') and the payment reference below.' +
      recent,
    [[{ text: '⬅️ Menu', callback_data: 'menu' }]]
  );
}