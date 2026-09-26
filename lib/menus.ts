import type { InlineKeyboard } from '@/lib/telegram';

export const PROMPTS = {
  member: 'Send the member Telegram ID or @username:',
  extend: 'Send: ID days reason\nExample: 123456789 7 compensation',
  grant: 'Send: ID days reason\nExample: 123456789 30 fan',
  revoke: 'Send: ID reason\nExample: 123456789 abuse',
  price: 'Send the new monthly price in naira.\nExample: 2000',
};

export const PROMPT_COMMANDS: Record<string, string> = {
  [PROMPTS.member]: '/member',
  [PROMPTS.extend]: '/extend',
  [PROMPTS.grant]: '/grant',
  [PROMPTS.revoke]: '/revoke',
  [PROMPTS.price]: '/price',
};

export function userMenu(isAdminUser: boolean): InlineKeyboard {
  const rows: InlineKeyboard = [
    [{ text: '💳 Subscribe / Renew', callback_data: 'subscribe' }],
    [
      { text: '📊 My Status', callback_data: 'status' },
      { text: '🔗 Access Link', callback_data: 'get_link' },
    ],
    [
      { text: '🧾 Payment Support', callback_data: 'paysupport' },
      { text: '❓ Help', callback_data: 'help' },
    ],
  ];
  if (isAdminUser) {
    rows.push([{ text: '🛠 Admin Panel', callback_data: 'admin_menu' }]);
  }
  return rows;
}

export function adminMenu(): InlineKeyboard {
  return [
    [
      { text: '📈 Stats', callback_data: 'a_stats' },
      { text: '🔍 Find Member', callback_data: 'a_member' },
    ],
    [
      { text: '🎁 Grant Free Access', callback_data: 'a_grant' },
      { text: '➕ Extend', callback_data: 'a_extend' },
    ],
    [
      { text: '⛔ Revoke', callback_data: 'a_revoke' },
      { text: '💰 Set Price', callback_data: 'a_price' },
    ],
    [
      { text: '📝 Schedule Post (Group)', callback_data: 'a_schedule_group' },
      { text: '📋 Group Scheduled', callback_data: 'a_scheduled_group' },
    ],
    [{ text: '📢 Channel', callback_data: 'a_channel_menu' }],
    [{ text: '⚙️ Run Daily Job', callback_data: 'a_runcron' }],
    [{ text: '⬅️ Back to Menu', callback_data: 'menu' }],
  ];
}

export function channelMenu(adEnabled: boolean, channelSet: boolean): InlineKeyboard {
  return [
    [
      {
        text: channelSet ? '✅ Channel Connected' : '⚠️ Channel Not Set',
        callback_data: 'a_channel_menu',
      },
    ],
    [{ text: '✏️ Set / Edit Daily Ad', callback_data: 'a_ad_edit' }],
    [
      {
        text: adEnabled ? '🔴 Disable Daily Ad' : '🟢 Enable Daily Ad',
        callback_data: 'a_ad_toggle',
      },
    ],
    [
      { text: '📝 Schedule Post (Channel)', callback_data: 'a_schedule_channel' },
      { text: '📋 Channel Scheduled', callback_data: 'a_scheduled_channel' },
    ],
    [{ text: '⬅️ Admin Panel', callback_data: 'admin_menu' }],
  ];
}

export async function sendForceReply(chatId: number, text: string) {
  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: { force_reply: true },
      }),
    }
  );
}
