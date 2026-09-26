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
import { handleAdminCommand, ADMIN_COMMANDS } from '@/lib/admin';
import { runDailyReconcile } from '@/lib/cron';
import {
  PROMPTS,
  PROMPT_COMMANDS,
  adminMenu,
  channelMenu,
  sendForceReply,
} from '@/lib/menus';
import {
  showMenu,
  showHelp,
  showStatus,
  showPaySupport,
} from '@/lib/userCommands';
import {
  getDraft,
  startDraft,
  setPhoto,
  setCaption,
  setSendAt,
  clearDraft,
} from '@/lib/postDrafts';
import {
  createScheduledPost,
  listPending,
  cancelPost,
  parseSendAt,
  fmtLagos,
} from '@/lib/scheduledPosts';
import { getChannelConfig, setChannelId, setAd, setAdEnabled } from '@/lib/channel';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
    [
      [{ text: 'Pay ₦' + amount.toLocaleString('en-NG'), url: result.authorizationUrl }],
      [{ text: '⬅️ Menu', callback_data: 'menu' }],
    ]
  );
}

async function handleGetLink(chatId: number, from: TgFrom) {
  const access = await findAccess(from.id);
  if (!access) {
    await sendMessage(
      chatId,
      'You do not have an active membership. Tap below to subscribe.',
      [[{ text: '💳 Subscribe', callback_data: 'subscribe' }]]
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

async function handleRunCron(chatId: number) {
  await sendMessage(chatId, 'Running the daily job...');
  const s = await runDailyReconcile();
  await sendMessage(
    chatId,
    'Done.' +
      '\nPayments recovered: ' + s.paymentsRecovered +
      '\nPending payments closed: ' + s.paymentsClosed +
      '\nMoved to grace: ' + s.movedToGrace +
      '\nExpired: ' + s.expired +
      '\nRemoved from group: ' + s.removed +
      '\nRemoval failed: ' + s.removalFailed +
      '\nReminders sent: ' + s.reminders +
      '\nRetries ok/failed: ' + s.retriesOk + '/' + s.retriesFailed +
      (s.truncated ? '\nStopped early (time). Run again.' : '')
  );
}

async function showAdminMenu(chatId: number) {
  await sendMessage(chatId, 'Admin Panel', adminMenu());
}

async function showChannelMenu(chatId: number) {
  const cfg = await getChannelConfig();
  await sendMessage(
    chatId,
    'Channel settings',
    channelMenu(cfg?.ad_enabled ?? false, !!cfg?.channel_id)
  );
}

async function handleScheduleStart(
  chatId: number,
  adminId: number,
  destination: 'group' | 'channel'
) {
  await startDraft(adminId, destination, false);
  await sendMessage(
    chatId,
    'Send the photo for this post now, or tap Skip for a text-only post.',
    [[{ text: 'Skip (text only)', callback_data: 'sched_skip_photo' }]]
  );
}

async function handleScheduledList(chatId: number, destination: 'group' | 'channel') {
  const posts = await listPending(destination, 10);
  if (posts.length === 0) {
    await sendMessage(chatId, 'No scheduled posts.', [
      [{ text: '⬅️ Back', callback_data: destination === 'channel' ? 'a_channel_menu' : 'admin_menu' }],
    ]);
    return;
  }
  for (const p of posts) {
    const when = fmtLagos(new Date(p.send_at));
    const preview =
      (p.caption ? p.caption.slice(0, 80) : '(no caption)') +
      (p.image_file_id ? '\n[has image]' : '');
    await sendMessage(chatId, when + '\n' + preview, [
      [{ text: '❌ Cancel this post', callback_data: 'sched_cancel_' + p.id }],
    ]);
  }
  await sendMessage(chatId, 'That is all scheduled posts.', [
    [{ text: '⬅️ Back', callback_data: destination === 'channel' ? 'a_channel_menu' : 'admin_menu' }],
  ]);
}

async function handleAdEdit(chatId: number, adminId: number) {
  await startDraft(adminId, 'channel', true);
  await sendMessage(
    chatId,
    'Send the image for the daily ad now, or tap Skip for text-only.',
    [[{ text: 'Skip (text only)', callback_data: 'ad_skip_photo' }]]
  );
}

async function handleAdminButton(
  data: string,
  chatId: number,
  adminId: number
) {
  if (data === 'admin_menu') {
    await clearDraft(adminId);
    await showAdminMenu(chatId);
  } else if (data === 'a_stats') {
    await handleAdminCommand(chatId, adminId, '/stats', []);
    await showAdminMenu(chatId);
  } else if (data === 'a_runcron') {
    await handleRunCron(chatId);
    await showAdminMenu(chatId);
  } else if (data === 'a_member') {
    await sendForceReply(chatId, PROMPTS.member);
  } else if (data === 'a_grant') {
    await sendForceReply(chatId, PROMPTS.grant);
  } else if (data === 'a_extend') {
    await sendForceReply(chatId, PROMPTS.extend);
  } else if (data === 'a_revoke') {
    await sendForceReply(chatId, PROMPTS.revoke);
  } else if (data === 'a_price') {
    await sendForceReply(chatId, PROMPTS.price);
  } else if (data === 'a_schedule_group') {
    await handleScheduleStart(chatId, adminId, 'group');
  } else if (data === 'a_scheduled_group') {
    await handleScheduledList(chatId, 'group');
  } else if (data === 'a_channel_menu') {
    await clearDraft(adminId);
    await showChannelMenu(chatId);
  } else if (data === 'a_schedule_channel') {
    await handleScheduleStart(chatId, adminId, 'channel');
  } else if (data === 'a_scheduled_channel') {
    await handleScheduledList(chatId, 'channel');
  } else if (data === 'a_ad_edit') {
    await handleAdEdit(chatId, adminId);
  } else if (data === 'a_ad_toggle') {
    const cfg = await getChannelConfig();
    const next = !(cfg?.ad_enabled ?? false);
    if (next && (!cfg?.ad_caption && !cfg?.ad_image_file_id)) {
      await sendMessage(chatId, 'Set the ad content first with "Set / Edit Daily Ad".');
      await showChannelMenu(chatId);
      return;
    }
    if (next && !cfg?.channel_id) {
      await sendMessage(chatId, 'The channel is not connected yet. Forward a channel post to me first.');
      await showChannelMenu(chatId);
      return;
    }
    await setAdEnabled(next);
    await sendMessage(chatId, next ? 'Daily ad enabled.' : 'Daily ad disabled.');
    await showChannelMenu(chatId);
  } else if (data === 'sched_skip_photo') {
    await setPhoto(adminId, null, 'awaiting_caption');
    await sendMessage(chatId, 'Send the text for the post.');
  } else if (data === 'ad_skip_photo') {
    await setPhoto(adminId, null, 'awaiting_caption');
    await sendMessage(chatId, 'Send the ad text.');
  } else if (data.startsWith('sched_cancel_')) {
    const id = data.slice('sched_cancel_'.length);
    const ok = await cancelPost(id);
    await sendMessage(chatId, ok ? 'Cancelled.' : 'Could not cancel (already sent?).');
  } else if (data === 'sched_confirm') {
    const draft = await getDraft(adminId);
    if (!draft || draft.step !== 'awaiting_confirm' || !draft.send_at) {
      await sendMessage(chatId, 'Nothing to confirm. Start again.');
      await showAdminMenu(chatId);
      return;
    }
    const id = await createScheduledPost({
      createdBy: adminId,
      caption: draft.caption,
      imageFileId: draft.image_file_id,
      sendAt: new Date(draft.send_at),
      destination: draft.destination,
    });
    await clearDraft(adminId);
    await sendMessage(
      chatId,
      id
        ? 'Scheduled for ' + fmtLagos(new Date(draft.send_at)) + '.'
        : 'Could not save the post. Try again.'
    );
    if (draft.destination === 'channel') await showChannelMenu(chatId);
    else await showAdminMenu(chatId);
  } else if (data === 'ad_confirm') {
    const draft = await getDraft(adminId);
    if (!draft) {
      await sendMessage(chatId, 'Nothing to confirm. Start again.');
      await showChannelMenu(chatId);
      return;
    }
    const ok = await setAd({
      caption: draft.caption,
      imageFileId: draft.image_file_id,
    });
    await clearDraft(adminId);
    await sendMessage(chatId, ok ? 'Ad saved.' : 'Could not save the ad. Try again.');
    await showChannelMenu(chatId);
  } else if (data === 'sched_cancel_draft' || data === 'ad_cancel_draft') {
    await clearDraft(adminId);
    await sendMessage(chatId, 'Cancelled.');
    await showAdminMenu(chatId);
  }
}

async function handleAdminMessage(
  chatId: number,
  adminId: number,
  message: {
    text?: string;
    photo?: { file_id: string }[];
  }
): Promise<boolean> {
  const draft = await getDraft(adminId);
  if (!draft) return false;

  const isAd = draft.is_ad;

  if (draft.step === 'awaiting_photo') {
    if (message.photo && message.photo.length > 0) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      await setPhoto(adminId, fileId, 'awaiting_caption');
      await sendMessage(chatId, 'Got the photo. Now send the text.');
      return true;
    }
    await sendMessage(chatId, 'Send a photo, or tap Skip above for text only.');
    return true;
  }

  if (draft.step === 'awaiting_caption') {
    const text = (message.text ?? '').trim();
    if (!text) {
      await sendMessage(chatId, 'Please send some text.');
      return true;
    }

    if (isAd) {
      await setCaption(adminId, text, 'awaiting_confirm');
      const preview =
        text + (draft.image_file_id ? '\n[has image]' : '');
      await sendMessage(chatId, 'Ad preview:\n\n' + preview, [
        [
          { text: '✅ Save Ad', callback_data: 'ad_confirm' },
          { text: '❌ Cancel', callback_data: 'ad_cancel_draft' },
        ],
      ]);
      return true;
    }

    await setCaption(adminId, text, 'awaiting_time');
    await sendMessage(
      chatId,
      'When should this go out? Send the date and time (Nigeria time) like:\n2026-09-28 18:00'
    );
    return true;
  }

  if (draft.step === 'awaiting_time') {
    const parsed = parseSendAt(message.text ?? '');
    if (!parsed) {
      await sendMessage(
        chatId,
        'Could not read that. Use the format: 2026-09-28 18:00'
      );
      return true;
    }
    if (parsed.getTime() <= Date.now()) {
      await sendMessage(chatId, 'That time is in the past. Send a future time.');
      return true;
    }
    await setSendAt(adminId, parsed);
    const preview =
      (draft.caption ?? '(no caption)') +
      (draft.image_file_id ? '\n[has image]' : '') +
      '\n\nDestination: ' +
      draft.destination +
      '\nSend at: ' +
      fmtLagos(parsed);
    await sendMessage(chatId, 'Preview:\n\n' + preview, [
      [
        { text: '✅ Confirm', callback_data: 'sched_confirm' },
        { text: '❌ Cancel', callback_data: 'sched_cancel_draft' },
      ],
    ]);
    return true;
  }

  return false;
}

async function handleForwardedChannelPost(
  chatId: number,
  message: { forward_origin?: { type: string; chat?: { id: number; type: string } }; forward_from_chat?: { id: number; type: string } }
) {
  const originChat =
    message.forward_origin?.chat ?? message.forward_from_chat;

  if (!originChat || originChat.type !== 'channel') {
    return false;
  }

  const ok = await setChannelId(originChat.id);
  await sendMessage(
    chatId,
    ok
      ? 'Channel connected. ID saved: ' + originChat.id
      : 'Could not save the channel ID. Try again.'
  );
  return true;
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

      if (cb.message && cb.from && cb.message.chat.type === 'private') {
        const chatId: number = cb.message.chat.id;
        const data: string = cb.data ?? '';
        const admin = isAdmin(cb.from.id);

        if (data === 'subscribe') {
          await handleSubscribe(chatId, cb.from);
        } else if (data === 'get_link') {
          await handleGetLink(chatId, cb.from);
        } else if (data === 'menu') {
          await showMenu(chatId, admin);
        } else if (data === 'status') {
          await showStatus(chatId, cb.from.id, admin);
        } else if (data === 'help') {
          await showHelp(chatId, admin);
        } else if (data === 'paysupport') {
          await showPaySupport(chatId, cb.from.id);
        } else if (
          data === 'admin_menu' ||
          data.startsWith('a_') ||
          data.startsWith('sched_') ||
          data.startsWith('ad_')
        ) {
          if (admin) {
            await handleAdminButton(data, chatId, cb.from.id);
          }
        }
      }
      return NextResponse.json({ ok: true });
    }

    const message = update.message;

    if (message && (typeof message.text === 'string' || message.photo)) {
      const chatId: number = message.chat.id;
      const chatType: string = message.chat.type;
      const from = message.from;
      const text: string = (message.text ?? '').trim();
      const parts: string[] = text ? text.split(/\s+/) : [];
      const command = parts[0]?.split('@')[0].toLowerCase() ?? '';
      const args = parts.slice(1);

      // Admin forwarding a channel post to capture its ID
      if (
        chatType === 'private' &&
        from &&
        isAdmin(from.id) &&
        (message.forward_origin || message.forward_from_chat)
      ) {
        const handled = await handleForwardedChannelPost(chatId, message);
        if (handled) return NextResponse.json({ ok: true });
      }

      // Admin composing a scheduled post or ad (photo or text, no leading slash)
      if (
        chatType === 'private' &&
        from &&
        isAdmin(from.id) &&
        (message.photo || (text && !text.startsWith('/')))
      ) {
        const handled = await handleAdminMessage(chatId, from.id, {
          text: message.text,
          photo: message.photo,
        });
        if (handled) return NextResponse.json({ ok: true });
      }

      // Admin answering a button prompt (force-reply)
      const replyText: string | undefined = message.reply_to_message?.text;
      if (
        chatType === 'private' &&
        from &&
        isAdmin(from.id) &&
        replyText &&
        PROMPT_COMMANDS[replyText] &&
        !text.startsWith('/')
      ) {
        await handleAdminCommand(
          chatId,
          from.id,
          PROMPT_COMMANDS[replyText],
          parts
        );
        await showAdminMenu(chatId);
        return NextResponse.json({ ok: true });
      }

      if (command === '/runcron') {
        if (chatType === 'private' && from && isAdmin(from.id)) {
          await handleRunCron(chatId);
        }
      } else if (ADMIN_COMMANDS.includes(command)) {
        if (chatType === 'private' && from && isAdmin(from.id)) {
          await handleAdminCommand(chatId, from.id, command, args);
        }
      } else if (command === '/groupid') {
        await sendMessage(chatId, 'Chat ID: ' + chatId);
      } else if (chatType === 'private' && from) {
        const admin = isAdmin(from.id);
        if (command === '/start') {
          await upsertUser(from);
          await sendMessage(
            chatId,
            'Welcome! Tap a button below to get started.',
            [[{ text: '📋 Open Menu', callback_data: 'menu' }]]
          );
          await showMenu(chatId, admin);
        } else if (command === '/subscribe') {
          await handleSubscribe(chatId, from);
        } else if (command === '/status') {
          await showStatus(chatId, from.id, admin);
        } else if (command === '/help') {
          await showHelp(chatId, admin);
        } else if (command === '/paysupport') {
          await showPaySupport(chatId, from.id);
        } else {
          await showMenu(chatId, admin);
        }
      }
    }
  } catch (e) {
    console.error('webhook error', e);
  }

  return NextResponse.json({ ok: true });
}
