// lib/ad2Admin.ts  (NEW) - the 1win Ad menu and its edit handlers.
// Buttons start with a_tk_ad2 (forwarded here by lib/ticketsUi.ts).
// Replies to the three prompts (text, time, photo) are forwarded by route.ts.
import { sendMessage } from '@/lib/telegram';
import type { InlineKeyboard } from '@/lib/telegram';
import { clearDraft } from '@/lib/postDrafts';
import { PROMPTS, sendForceReply } from '@/lib/menus';
import {
  getAd2,
  setAd2Caption,
  setAd2Image,
  setAd2Enabled,
  setAd2Time,
  nigeriaTimeText,
} from '@/lib/ad2';

const PHOTO_CAPTION_LIMIT = 1024; // Telegram's limit for a caption under a photo
const TEXT_LIMIT = 4096; // Telegram's limit for a plain message

function menuKeyboard(enabled: boolean, hasImage: boolean): InlineKeyboard {
  const rows: InlineKeyboard = [];
  rows.push([
    { text: '✏️ Edit Text', callback_data: 'a_tk_ad2_text' },
    { text: '🕒 Edit Time', callback_data: 'a_tk_ad2_time' },
  ]);
  rows.push([{ text: '🖼 Set Image', callback_data: 'a_tk_ad2_photo' }]);
  if (hasImage) {
    rows.push([{ text: '🗑 Remove Image', callback_data: 'a_tk_ad2_noimg' }]);
  }
  rows.push([
    {
      text: enabled ? '🔴 Disable 1win Ad' : '🟢 Enable 1win Ad',
      callback_data: 'a_tk_ad2_toggle',
    },
  ]);
  rows.push([{ text: '⬅️ Tickets Menu', callback_data: 'a_tk_menu' }]);
  return rows;
}

export async function showAd2Menu(chatId: number): Promise<void> {
  const cfg = await getAd2();
  if (!cfg) {
    await sendMessage(
      chatId,
      '1win Ad: the settings row was not found. Check that the ad2_config table has its row.',
      [[{ text: '⬅️ Tickets Menu', callback_data: 'a_tk_menu' }]]
    );
    return;
  }
  const text = cfg.ad_caption
    ? cfg.ad_caption.length > 300
      ? cfg.ad_caption.slice(0, 300) + '...'
      : cfg.ad_caption
    : '(no text set)';
  await sendMessage(
    chatId,
    '1WIN AD\n\n' +
      'Status: ' + (cfg.ad_enabled ? 'ON' : 'OFF') + '\n' +
      'Time: every day at ' + nigeriaTimeText(cfg.ad_hour_utc, cfg.ad_minute_utc) + ' (Nigerian time)\n' +
      'Image: ' + (cfg.ad_image_file_id ? 'yes' : 'none') + '\n' +
      'Destination: the public channel\n\n' +
      'Text:\n' + text,
    menuKeyboard(cfg.ad_enabled, !!cfg.ad_image_file_id)
  );
}

// Every button that starts with a_tk_ad2.
export async function handleAd2Button(
  data: string,
  chatId: number,
  adminId: number
): Promise<void> {
  // Make sure no half-finished compose draft swallows the next reply or photo.
  await clearDraft(adminId);

  if (data === 'a_tk_ad2') {
    await showAd2Menu(chatId);
  } else if (data === 'a_tk_ad2_text') {
    await sendForceReply(chatId, PROMPTS.ad2Text);
  } else if (data === 'a_tk_ad2_time') {
    await sendForceReply(chatId, PROMPTS.ad2Time);
  } else if (data === 'a_tk_ad2_photo') {
    await sendForceReply(chatId, PROMPTS.ad2Photo);
  } else if (data === 'a_tk_ad2_noimg') {
    const ok = await setAd2Image(null);
    await sendMessage(chatId, ok ? 'Image removed.' : 'Could not remove the image. Try again.');
    await showAd2Menu(chatId);
  } else if (data === 'a_tk_ad2_toggle') {
    const cfg = await getAd2();
    if (!cfg) {
      await sendMessage(chatId, 'The 1win Ad settings were not found.');
      await showAd2Menu(chatId);
      return;
    }
    const next = !cfg.ad_enabled;
    if (next && !cfg.ad_caption && !cfg.ad_image_file_id) {
      await sendMessage(chatId, 'Set the text first with Edit Text.');
      await showAd2Menu(chatId);
      return;
    }
    const ok = await setAd2Enabled(next);
    await sendMessage(
      chatId,
      ok ? (next ? '1win Ad enabled.' : '1win Ad disabled.') : 'Could not change the switch. Try again.'
    );
    await showAd2Menu(chatId);
  }
}

// The reply to one of the three prompts. command = ad2_text | ad2_time | ad2_photo.
export async function handleAd2Reply(
  chatId: number,
  command: string,
  text: string,
  photo?: { file_id: string }[]
): Promise<void> {
  if (command === 'ad2_text') {
    const value = text.trim();
    if (!value) {
      await sendMessage(chatId, 'The text was empty. Nothing changed.');
      await showAd2Menu(chatId);
      return;
    }
    if (value.length > TEXT_LIMIT) {
      await sendMessage(chatId, 'That text is too long (the limit is ' + TEXT_LIMIT + ' characters). Nothing changed.');
      await showAd2Menu(chatId);
      return;
    }
    const cfg = await getAd2();
    if (cfg && cfg.ad_image_file_id && value.length > PHOTO_CAPTION_LIMIT) {
      await sendMessage(
        chatId,
        'With an image, the text can be at most ' + PHOTO_CAPTION_LIMIT +
          ' characters (yours is ' + value.length + '). Shorten it, or remove the image first. Nothing changed.'
      );
      await showAd2Menu(chatId);
      return;
    }
    const ok = await setAd2Caption(value);
    await sendMessage(chatId, ok ? 'Text saved.' : 'Could not save the text. Try again.');
    await showAd2Menu(chatId);
    return;
  }

  if (command === 'ad2_time') {
    const ok = await setAd2Time(text);
    if (!ok) {
      await sendMessage(chatId, 'Could not read that time. Send it like 09:30 (24h, Nigerian time). Nothing changed.');
      await showAd2Menu(chatId);
      return;
    }
    await sendMessage(
      chatId,
      'Time saved. Note: if this time has already passed today and the ad has not gone out yet today, it will post within a minute.'
    );
    await showAd2Menu(chatId);
    return;
  }

  if (command === 'ad2_photo') {
    if (!photo || photo.length === 0) {
      await sendMessage(chatId, 'Please send the image as a photo (not as a file). Nothing changed.');
      await showAd2Menu(chatId);
      return;
    }
    const cfg = await getAd2();
    if (cfg && cfg.ad_caption && cfg.ad_caption.length > PHOTO_CAPTION_LIMIT) {
      await sendMessage(
        chatId,
        'The current text is ' + cfg.ad_caption.length +
          ' characters, which is too long for a photo caption (limit ' + PHOTO_CAPTION_LIMIT +
          '). Shorten the text first. Nothing changed.'
      );
      await showAd2Menu(chatId);
      return;
    }
    const fileId = photo[photo.length - 1].file_id;
    const ok = await setAd2Image(fileId);
    await sendMessage(chatId, ok ? 'Image saved.' : 'Could not save the image. Try again.');
    await showAd2Menu(chatId);
    return;
  }
}
