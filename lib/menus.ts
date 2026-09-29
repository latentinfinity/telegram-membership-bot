import type { InlineKeyboard } from '@/lib/telegram';

export const PROMPTS = {
  member: 'Send the member Telegram ID or @username:',
  extend: 'Send: ID days reason\nExample: 123456789 7 compensation',
  grant: 'Send: ID days reason\nExample: 123456789 30 fan',
  revoke: 'Send: ID reason\nExample: 123456789 abuse',
  price: 'Send the new monthly price in naira.\nExample: 2000',
  engNiche:
    'Send the channel niche/topic (what the AI should post about).\nExample: football betting tips, odds, match previews, weekend slips',
  engTone:
    'Send the tone the AI should write in.\nExample: confident, punchy, a little playful, never scammy or hypey',
  engAvoid:
    'Send topics the AI must avoid, comma separated.\nExample: guaranteed wins, exact score promises, politics, religion',
  engWindow:
    'Send the posting window as start-end (24h, Nigeria time).\nExample: 8-21',
  engCaps: 'Send max posts,max polls per day.\nExample: 3,1',
  engReplyLimits:
    'Send max replies per day,cooldown minutes.\nExample: 20,3',
  masNew:
    'Send the new cycle as: bankroll,N,K,odds\nExample: 1000,5,3,2.00\n(bankroll in naira, N = total bets, K = wins needed, odds = reference odds)',
  masTicket:
    'Send the next ticket as: odds | prediction\nExample: 1.85 | Arsenal & Chelsea over 1.5\n(odds = final odds of this ticket, single or combined; the prediction text is optional)',
};

export const PROMPT_COMMANDS: Record<string, string> = {
  [PROMPTS.member]: '/member',
  [PROMPTS.extend]: '/extend',
  [PROMPTS.grant]: '/grant',
  [PROMPTS.revoke]: '/revoke',
  [PROMPTS.price]: '/price',
  [PROMPTS.engNiche]: 'eng_niche',
  [PROMPTS.engTone]: 'eng_tone',
  [PROMPTS.engAvoid]: 'eng_avoid',
  [PROMPTS.engWindow]: 'eng_window',
  [PROMPTS.engCaps]: 'eng_caps',
  [PROMPTS.engReplyLimits]: 'eng_reply_limits',
  [PROMPTS.masNew]: 'mas_new',
  [PROMPTS.masTicket]: 'mas_ticket',
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
    [{ text: '🤖 Engagement', callback_data: 'a_engagement_menu' }],
    [{ text: '🎯 Masaniello', callback_data: 'a_mas_menu' }],
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

export function engagementMenu(
  aiPostsEnabled: boolean,
  aiRepliesEnabled: boolean
): InlineKeyboard {
  return [
    [
      { text: '📋 View Profile', callback_data: 'a_eng_view' },
      { text: "📊 Today's Activity", callback_data: 'a_eng_stats' },
    ],
    [
      { text: '🎯 Set Niche', callback_data: 'a_eng_niche' },
      { text: '🎭 Set Tone', callback_data: 'a_eng_tone' },
    ],
    [{ text: '🚫 Set Topics to Avoid', callback_data: 'a_eng_avoid' }],
    [
      { text: '🕒 Posting Window', callback_data: 'a_eng_window' },
      { text: '📊 Daily Caps', callback_data: 'a_eng_caps' },
    ],
    [
      {
        text: aiPostsEnabled ? '🔴 Disable AI Posts' : '🟢 Enable AI Posts',
        callback_data: 'a_eng_posts_toggle',
      },
    ],
    [{ text: '💬 Reply Limits', callback_data: 'a_eng_reply_limits' }],
    [
      {
        text: aiRepliesEnabled ? '🔴 Disable AI Replies' : '🟢 Enable AI Replies',
        callback_data: 'a_eng_toggle',
      },
    ],
    [{ text: '⬅️ Admin Panel', callback_data: 'admin_menu' }],
  ];
}

// undoCycleId: pass the active cycle's id when it has a settled ticket and
// no open ticket, to show the Undo button. Otherwise leave it null.
export function masanielloMenu(
  hasActiveCycle: boolean,
  hasOpenTicket: boolean = false,
  undoCycleId: string | null = null
): InlineKeyboard {
  const rows: InlineKeyboard = [];
  if (hasActiveCycle) {
    if (hasOpenTicket) {
      rows.push([{ text: '🎟 View Open Ticket', callback_data: 'a_mas_ticket' }]);
    } else {
      rows.push([{ text: '🎟 Next Ticket', callback_data: 'a_mas_next' }]);
    }
    if (undoCycleId) {
      rows.push([
        { text: '↩️ Undo Last Settlement', callback_data: 'a_mas_ud_' + undoCycleId },
      ]);
    }
    rows.push([{ text: '📊 View Active Cycle', callback_data: 'a_mas_view' }]);
    rows.push([{ text: '🚫 Cancel Active Cycle', callback_data: 'a_mas_cancel' }]);
  } else {
    rows.push([{ text: '➕ New Cycle', callback_data: 'a_mas_new' }]);
  }
  rows.push([{ text: '📜 History', callback_data: 'a_mas_hist' }]);
  rows.push([{ text: '⬅️ Admin Panel', callback_data: 'admin_menu' }]);
  return rows;
}

// Buttons under an open ticket: settle it, discard it, or go back.
export function masanielloTicketKeyboard(): InlineKeyboard {
  return [
    [
      { text: '✅ Win', callback_data: 'a_mas_win' },
      { text: '❌ Loss', callback_data: 'a_mas_loss' },
      { text: '➖ Void', callback_data: 'a_mas_void' },
    ],
    [{ text: '🗑 Discard Ticket', callback_data: 'a_mas_discard' }],
    [{ text: '⬅️ Masaniello Menu', callback_data: 'a_mas_menu' }],
  ];
}

// Confirmation step before settling. The ticket id is inside the button,
// so an old message can only ever settle the ticket it was made for.
export function masanielloSettleConfirm(
  result: 'win' | 'loss' | 'void',
  ticketId: string
): InlineKeyboard {
  return [
    [
      {
        text: '✅ Yes, settle as ' + result.toUpperCase(),
        callback_data: 'a_mas_do_' + result + '_' + ticketId,
      },
    ],
    [{ text: '↩️ No, go back', callback_data: 'a_mas_ticket' }],
  ];
}

export function masanielloCancelConfirm(): InlineKeyboard {
  return [
    [
      { text: '✅ Yes, cancel it', callback_data: 'a_mas_cancel_yes' },
      { text: '↩️ No, keep it', callback_data: 'a_mas_menu' },
    ],
  ];
}

// List of past cycles: one button per cycle.
export function masanielloHistoryKeyboard(
  items: { id: string; label: string }[]
): InlineKeyboard {
  const rows: InlineKeyboard = items.map((it) => [
    { text: it.label, callback_data: 'a_mas_h_' + it.id },
  ]);
  rows.push([{ text: '⬅️ Masaniello Menu', callback_data: 'a_mas_menu' }]);
  return rows;
}

// Buttons under one cycle's detail. Undo is offered only when the cycle
// was closed by a settlement (the store re-checks every rule when tapped).
export function masanielloHistoryDetailKeyboard(
  cycleId: string,
  canUndo: boolean
): InlineKeyboard {
  const rows: InlineKeyboard = [];
  if (canUndo) {
    rows.push([
      { text: '↩️ Undo Last Settlement', callback_data: 'a_mas_ud_' + cycleId },
    ]);
  }
  rows.push([{ text: '⬅️ History', callback_data: 'a_mas_hist' }]);
  rows.push([{ text: '⬅️ Masaniello Menu', callback_data: 'a_mas_menu' }]);
  return rows;
}

export function masanielloUndoConfirm(cycleId: string): InlineKeyboard {
  return [
    [{ text: '✅ Yes, undo it', callback_data: 'a_mas_udo_' + cycleId }],
    [{ text: '↩️ No, keep it', callback_data: 'a_mas_menu' }],
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
