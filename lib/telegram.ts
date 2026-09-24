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
  const body: Record < string, unknown > = { chat_id: chatId, text };
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

export async function createJoinRequestLink(params: {
  name: string;
  expireInHours: number;
}): Promise < { ok: true;link: string } | { ok: false;error: string } > {
  try {
    const res = await fetch(endpoint('createChatInviteLink'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: Number(process.env.TELEGRAM_GROUP_ID),
        name: params.name.slice(0, 32),
        expire_date: Math.floor(Date.now() / 1000) + params.expireInHours * 3600,
        creates_join_request: true,
      }),
    });
    const json = await res.json();
    if (!json.ok) {
      return { ok: false, error: json.description ?? 'Telegram error' };
    }
    return { ok: true, link: json.result.invite_link };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function approveJoinRequest(userId: number) {
  const res = await fetch(endpoint('approveChatJoinRequest'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: Number(process.env.TELEGRAM_GROUP_ID),
      user_id: userId,
    }),
  });
  const json = await res.json();
  return json.ok === true;
}

export async function declineJoinRequest(userId: number) {
  const res = await fetch(endpoint('declineChatJoinRequest'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: Number(process.env.TELEGRAM_GROUP_ID),
      user_id: userId,
    }),
  });
  const json = await res.json();
  return json.ok === true;
}

export async function removeMember(
  userId: number
): Promise < { ok: true } | { ok: false;error: string } > {
  try {
    const chatId = Number(process.env.TELEGRAM_GROUP_ID);
    
    const banRes = await fetch(endpoint('banChatMember'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, user_id: userId }),
    });
    const banJson = await banRes.json();
    if (!banJson.ok) {
      return { ok: false, error: banJson.description ?? 'Ban failed' };
    }
    
    const unbanRes = await fetch(endpoint('unbanChatMember'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        user_id: userId,
        only_if_is_banned: true,
      }),
    });
    const unbanJson = await unbanRes.json();
    if (!unbanJson.ok) {
      return { ok: false, error: unbanJson.description ?? 'Unban failed' };
    }
    
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}