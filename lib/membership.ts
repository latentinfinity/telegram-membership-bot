export async function isInGroup(telegramId: number): Promise < boolean > {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getChatMember`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: Number(process.env.TELEGRAM_GROUP_ID),
          user_id: telegramId,
        }),
      }
    );
    const json = await res.json();
    if (!json.ok) return false;
    const status: string = json.result.status;
    if (status === 'creator' || status === 'administrator' || status === 'member') {
      return true;
    }
    if (status === 'restricted') return json.result.is_member === true;
    return false;
  } catch {
    return false;
  }
}
