import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendMessage, answerCallbackQuery } from '@/lib/telegram';
import { initializeTransaction, makeReference } from '@/lib/paystack';

export const dynamic = 'force-dynamic';

type TgFrom = { id: number; username?: string };

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

export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const update = await req.json();

    if (update.callback_query) {
      const cb = update.callback_query;
      await answerCallbackQuery(cb.id);
      if (cb.data === 'subscribe' && cb.message && cb.from) {
        await handleSubscribe(cb.message.chat.id, cb.from);
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
