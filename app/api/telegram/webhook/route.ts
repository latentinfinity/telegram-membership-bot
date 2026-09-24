import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  sendMessage,
  answerCallbackQuery,
  approveJoinRequest,
  declineJoinRequest,
} from '@/lib/telegram';
import { initializeTransaction, makeReference } from '@/lib/paystack';
import { issueAccessLink } from '@/lib/processPayment';

export const dynamic = 'force-dynamic';

type TgFrom = { id: number; username?: string };

function isAdmin(telegramId: number) {
  const ids = (process.env.TELEGRAM_ADMIN_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(String(telegramId));
}

async function upsertUser(from: TgFrom) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('telegram_users')
    .upsert(
      {
        telegram_id: from.id,
        telegram_username: from.username ?? null,
        has_started_bot: true,
        is_blocked: false,
      },
      { onConflict: 'telegram_id' }
    )
    .select('id')
    .single();
  if (error) console.error('telegram_users upsert failed', error);
  return data;
}

async function findAccess(telegramId: number) {
  const supabase = createAdminClient();

  const { data: user } = await supabase
    .from('telegram_users')
    .select('id')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  if (!user) return null;

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('id, status, grace_ends_at')
    .eq('telegram_user_id', user.id)
    .eq('is_deleted', false)
    .in('status', ['active', 'grace'])
    .maybeSingle();

  if (!sub) return null;
  if (new Date(sub.grace_ends_at) <= new Date()) return null;

  return { userId: user.id as string, subscriptionId: sub.id as string };
}

async function handleSubscribe(chatId: number, from: TgFrom) {
  const supabase = createAdminClient();

  const user = await upsertUser(from);
  if (!user) {
    await sendMessage(chatId, 'Something went wrong. Please try again.');
    return;
  }

  const { data: plan } = await supabase
    .from('membership_plans')
    .select('id, duration_days')
    .eq('name', 'monthly')
    .eq('active', true)
    .single();

  if (!plan) {
    await sendMessage(chatId, 'No plan is available right now.');
    return;
  }

  const { data: price } = await supabase
    .from('plan_prices')
    .select('amount')
    .eq('plan_id', plan.id)
    .eq('currency', 'NGN')
    .eq('active', true)
    .single();

  if (!price) {
    await sendMessage(chatId, 'No price is set right now.');
    return;
  }

  const amount = Number(price.amount);
  const reference = makeReference(from.id);

  const { error: insertError } = await supabase.from('payments').insert({
    telegram_user_id: user.id,
    provider: 'paystack',
    payment_reference: reference,
    amount,
    currency: 'NGN',
    status: 'pending',
  });

  if (insertError) {
    console.error('payments insert failed', insertError);
    await sendMessage(chatId, 'Something went wrong. Please try again.');
    return;
  }

  const result = await initializeTransaction({
    telegramId: from.id,
    amountNaira: amount,
    reference,
  });

  if (!result.ok) {
    console.error('paystack initialize failed', result.error);
    await supabase
      .from('payments')
      .update({ status: 'failed' })
      .eq('payment_reference', reference);
    await sendMessage(chatId, 'Could not start payment. Please try again.');
    return;
  }

  await sendMessage(
    chatId,
    'Monthly membership: ₦' +
      amount.toLocaleString('en-NG') +
      ' for ' +
      plan.duration_days +
      ' days.\n\nTap the button to pay securely. Access is sent here after payment.',
    [[{ text: 'Pay ₦' + amount.toLocaleString('en-NG'), url: result.authorizationUrl }]]
  );
}

async function handleGetLink(chatId: number, from: TgFrom) {
  const access = await findAccess(from.id);
  if (!access) {
    await sendMessage(
      chatId,
      'You do not have an active membership. Tap below to subscribe.',
      [[{ text: 'Subscribe', callback_data: 'subscribe' }]]
    );
    return;
  }
  await issueAccessLink({
    telegramUserId: access.userId,
    telegramId: from.id,
    subscriptionId: access.subscriptionId,
    intro: 'Here is your access link.',
  });
}

async function handleJoinRequest(req: { chat: { id: number }; from: TgFrom }) {
  if (String(req.chat.id) !== process.env.TELEGRAM_GROUP_ID) return;

  const telegramId = req.from.id;

  if (isAdmin(telegramId)) {
    await approveJoinRequest(telegramId);
    return;
  }

  const access = await findAccess(telegramId);

  if (!access) {
    await declineJoinRequest(telegramId);
    console.log('join request declined for', telegramId);
    return;
  }

  const approved = await approveJoinRequest(telegramId);

  const supabase = createAdminClient();
  await supabase.from('access_events').insert({
    telegram_user_id: access.userId,
    subscription_id: access.subscriptionId,
    event_type: 'join_approved',
    result: approved ? 'success' : 'failed',
  });

  if (approved) {
    await sendMessage(telegramId, 'Approved. Welcome to the group!');
  }
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const update = await req.json();

    if (update.chat_join_request) {
      await handleJoinRequest(update.chat_join_request);
      return NextResponse.json({ ok: true });
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      await answerCallbackQuery(cb.id);
      if (cb.message && cb.from) {
        const chatId: number = cb.message.chat.id;
        if (cb.data === 'subscribe') {
          await handleSubscribe(chatId, cb.from);
        } else if (cb.data === 'get_link') {
          await handleGetLink(chatId, cb.from);
        }
      }
      return NextResponse.json({ ok: true });
    }

    const message = update.message;

    if (message && typeof message.text === 'string') {
      const chatId: number = message.chat.id;
      const chatType: string = message.chat.type;
      const from = message.from;
      const command = message.text.split(' ')[0].split('@')[0].toLowerCase();

      if (command === '/groupid') {
        await sendMessage(chatId, 'Chat ID: ' + chatId);
      } else if (command === '/start' && chatType === 'private' && from) {
        await upsertUser(from);
        await sendMessage(
          chatId,
          'Welcome! Tap below to join the membership.',
          [[{ text: 'Subscribe', callback_data: 'subscribe' }]]
        );
      } else if (command === '/subscribe' && chatType === 'private' && from) {
        await handleSubscribe(chatId, from);
      }
    }
  } catch (e) {
    console.error('webhook error', e);
  }

  return NextResponse.json({ ok: true });
}