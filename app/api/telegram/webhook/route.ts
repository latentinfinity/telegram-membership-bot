import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

async function sendMessage(chatId: number, text: string) {
  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    }
  );
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const update = await req.json();
    const message = update.message;

    if (message && typeof message.text === 'string') {
      const chatId: number = message.chat.id;
      const chatType: string = message.chat.type;
      const from = message.from;
      const command = message.text.split(' ')[0].split('@')[0].toLowerCase();

      if (command === '/groupid') {
        await sendMessage(chatId, 'Chat ID: ' + chatId);
      } else if (command === '/start' && chatType === 'private' && from) {
        const supabase = createAdminClient();
        const { error } = await supabase.from('telegram_users').upsert(
          {
            telegram_id: from.id,
            telegram_username: from.username ?? null,
            has_started_bot: true,
            is_blocked: false,
          },
          { onConflict: 'telegram_id' }
        );
        if (error) console.error('telegram_users upsert failed', error);

        await sendMessage(
          chatId,
          'Welcome! Your Telegram ID is ' + from.id + '.\n\nSubscription features are coming soon.'
        );
      }
    }
  } catch (e) {
    console.error('webhook error', e);
  }

  return NextResponse.json({ ok: true });
}
