export type InlineKeyboard = {
  text: string;
  url ? : string;
  callback_data ? : string;
} [][];

function endpoint(method: string) {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

export async function sendMessage(
  chatId: number,
  text: string,
  keyboard ? : InlineKeyboard
) {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (keyboard) {
    body.reply_markup = { inline_keyboard: keyboard };
  }
  const res = await fetch(endpoint('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

export async function answerCallbackQuery(callbackQueryId: string) {
  await fetch(endpoint('answerCallbackQuery'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}
