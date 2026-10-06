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
  engagementMenu,
  masanielloMenu,
  masanielloCancelConfirm,
  masanielloTicketKeyboard,
  masanielloSettleConfirm,
  masanielloHistoryKeyboard,
  masanielloHistoryDetailKeyboard,
  masanielloUndoConfirm,
  predictAgainKeyboard,
  ticketsMenu,
  ticketsCreateConfirm,
  ticketsClearConfirm,
  ticketsBackKeyboard,
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
import { generateText } from '@/lib/ai';
import {
  getChannelProfile,
  setNiche,
  setTone,
  setTopicsToAvoid,
  setPostingWindow,
  setDailyCaps,
  setReplyLimits,
  toggleAiPosts,
  toggleAiReplies,
  formatProfile,
} from '@/lib/channelProfile';
import { handleDiscussionMessage, generateReply } from '@/lib/replies';
import { getEngagementSummary } from '@/lib/engagementStats';
import {
  describeCycle,
  parseNairaToKobo,
  parseOdds,
  formatNaira,
} from '@/lib/masaniello';
import {
  getActiveCycle,
  createCycle,
  cancelActiveCycle,
  cycleDashboard,
  getOpenTicket,
  createTicket,
  discardOpenTicket,
  ticketCard,
  settleTicket,
  getRecentCycles,
  getCycleById,
  getCycleTickets,
  cycleDetail,
  historyLabel,
  undoLastSettlement,
} from '@/lib/masanielloStore';
import type { MasCycle } from '@/lib/masanielloStore';
import { runPrediction, formatPrediction, PREDICT_USAGE } from '@/lib/predict';
import { parseNewMatches, MAX_STORED_MATCHES } from '@/lib/tickets';
import {
  analyseMatch,
  planRules,
  dealTickets,
  describePlan,
  formatTicketMessages,
  formatSummary,
  formatTopOver35,
} from '@/lib/ruleTickets';
import type { RuleRow } from '@/lib/ruleTickets';
import {
  listStored,
  countStored,
  addMatches,
  clearStored,
  takeAll,
  restoreRows,
} from '@/lib/ticketStore';

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

async function showEngagementMenu(chatId: number) {
  const profile = await getChannelProfile();
  await sendMessage(
    chatId,
    'Engagement settings',
    engagementMenu(
      profile?.ai_posts_enabled ?? false,
      profile?.ai_replies_enabled ?? false
    )
  );
}

async function showMasanielloMenu(chatId: number) {
  const active = await getActiveCycle();
  let hasOpen = false;
  let undoCycleId: string | null = null;
  if (active) {
    const tickets = await getCycleTickets(active.id);
    hasOpen = tickets.some((t) => t.status === 'open');
    if (!hasOpen && tickets.length > 0) {
      undoCycleId = active.id;
    }
  }
  await sendMessage(
    chatId,
    active
      ? hasOpen
        ? 'Masaniello: a cycle is active and a ticket is open.'
        : 'Masaniello: a cycle is active.'
      : 'Masaniello: no active cycle.',
    masanielloMenu(!!active, hasOpen, undoCycleId)
  );
}

async function showOpenTicket(chatId: number, cycle: MasCycle) {
  const ticket = await getOpenTicket(cycle.id);
  if (!ticket) {
    await sendMessage(chatId, 'There is no open ticket.');
    await showMasanielloMenu(chatId);
    return;
  }
  await sendMessage(chatId, ticketCard(cycle, ticket), masanielloTicketKeyboard());
}

async function handleMasanielloNew(
  chatId: number,
  adminId: number,
  rawText: string
) {
  const fields = rawText.replace(/\s+/g, '').split(',');
  if (fields.length !== 4) {
    await sendMessage(
      chatId,
      'Could not read that. Send: bankroll,N,K,odds\nExample: 1000,5,3,2.00'
    );
    await showMasanielloMenu(chatId);
    return;
  }
  const bankKobo = parseNairaToKobo(fields[0]);
  const n = /^\d+$/.test(fields[1]) ? parseInt(fields[1], 10) : NaN;
  const k = /^\d+$/.test(fields[2]) ? parseInt(fields[2], 10) : NaN;
  const oddsH = parseOdds(fields[3]);
  if (bankKobo === null || isNaN(n) || isNaN(k) || oddsH === null) {
    await sendMessage(
      chatId,
      'Could not read that. Bankroll in naira, N and K whole numbers, odds like 2.00.\nExample: 1000,5,3,2.00'
    );
    await showMasanielloMenu(chatId);
    return;
  }

  const result = await createCycle({
    createdBy: adminId,
    bankrollKobo: bankKobo,
    totalBets: n,
    winsRequired: k,
    refOddsH: oddsH,
  });

  if (!result.ok) {
    await sendMessage(chatId, '❌ ' + result.error);
    await showMasanielloMenu(chatId);
    return;
  }

  await sendMessage(chatId, 'Cycle created.\n\n' + cycleDashboard(result.cycle));
  await showMasanielloMenu(chatId);
}

async function handleMasanielloTicket(chatId: number, rawText: string) {
  const active = await getActiveCycle();
  if (!active) {
    await sendMessage(chatId, 'There is no active cycle.');
    await showMasanielloMenu(chatId);
    return;
  }

  const bar = rawText.indexOf('|');
  const oddsText = bar === -1 ? rawText : rawText.slice(0, bar);
  const predText = bar === -1 ? '' : rawText.slice(bar + 1).trim();
  const oddsH = parseOdds(oddsText);
  if (oddsH === null) {
    await sendMessage(
      chatId,
      'Could not read the odds. Send: odds | prediction\nExample: 1.85 | Arsenal & Chelsea over 1.5\nOdds must be greater than 1.00 with at most 2 decimals.'
    );
    await showMasanielloMenu(chatId);
    return;
  }

  const prediction = predText ? predText.slice(0, 300) : null;
  const result = await createTicket(active, oddsH, prediction);
  if (!result.ok) {
    await sendMessage(chatId, '❌ ' + result.error);
    await showMasanielloMenu(chatId);
    return;
  }

  await sendMessage(
    chatId,
    ticketCard(active, result.ticket),
    masanielloTicketKeyboard()
  );
}

// Step 1 of settling: ask for confirmation (Win / Loss / Void tapped).
async function handleMasanielloSettleAsk(
  chatId: number,
  result: 'win' | 'loss' | 'void'
) {
  const active = await getActiveCycle();
  if (!active) {
    await sendMessage(chatId, 'There is no active cycle.');
    await showMasanielloMenu(chatId);
    return;
  }
  const ticket = await getOpenTicket(active.id);
  if (!ticket) {
    await sendMessage(chatId, 'There is no open ticket to settle.');
    await showMasanielloMenu(chatId);
    return;
  }
  const what =
    result === 'void'
      ? 'The stake is returned and no bet is used.'
      : 'You can still undo the last settlement afterwards if you tap the wrong one.';
  await sendMessage(
    chatId,
    'Settle ticket #' + ticket.ticket_no +
      ' (odds ' + (ticket.odds_h / 100).toFixed(2) +
      ', stake ' + formatNaira(Number(ticket.stake_kobo)) +
      ') as ' + result.toUpperCase() + '?\n' + what,
    masanielloSettleConfirm(result, ticket.id)
  );
}

// Step 2 of settling: the confirm button (data = a_mas_do_<result>_<ticketId>).
async function handleMasanielloSettleDo(chatId: number, data: string) {
  const rest = data.slice('a_mas_do_'.length);
  const sep = rest.indexOf('_');
  const resultRaw = sep === -1 ? '' : rest.slice(0, sep);
  const ticketId = sep === -1 ? '' : rest.slice(sep + 1);

  if (
    (resultRaw !== 'win' && resultRaw !== 'loss' && resultRaw !== 'void') ||
    !ticketId
  ) {
    await sendMessage(chatId, 'That button is not valid. Nothing changed.');
    await showMasanielloMenu(chatId);
    return;
  }

  const active = await getActiveCycle();
  if (!active) {
    await sendMessage(chatId, 'There is no active cycle. Nothing changed.');
    await showMasanielloMenu(chatId);
    return;
  }

  const outcome = await settleTicket(active, ticketId, resultRaw);
  if (!outcome.ok) {
    await sendMessage(chatId, '❌ ' + outcome.error);
    await showMasanielloMenu(chatId);
    return;
  }

  await sendMessage(chatId, outcome.summary);
  await showMasanielloMenu(chatId);
}

// History list: the last 10 cycles, newest first.
async function handleMasanielloHistory(chatId: number) {
  const cycles = await getRecentCycles(10);
  if (cycles.length === 0) {
    await sendMessage(chatId, 'No cycles yet.');
    await showMasanielloMenu(chatId);
    return;
  }
  await sendMessage(
    chatId,
    'Recent cycles (newest first). Tap one to see its tickets.',
    masanielloHistoryKeyboard(
      cycles.map((c) => ({ id: c.id, label: historyLabel(c) }))
    )
  );
}

// Detail of one past (or current) cycle.
async function handleMasanielloHistoryDetail(chatId: number, cycleId: string) {
  const cycle = await getCycleById(cycleId);
  if (!cycle) {
    await sendMessage(chatId, 'Cycle not found.');
    await showMasanielloMenu(chatId);
    return;
  }
  const tickets = await getCycleTickets(cycle.id);
  const canUndo =
    cycle.status === 'achieved' ||
    cycle.status === 'not_achieved' ||
    cycle.status === 'infeasible';
  await sendMessage(
    chatId,
    cycleDetail(cycle, tickets),
    masanielloHistoryDetailKeyboard(cycle.id, canUndo)
  );
}

// Undo step 1: ask for confirmation.
async function handleMasanielloUndoAsk(chatId: number, cycleId: string) {
  const cycle = await getCycleById(cycleId);
  if (!cycle) {
    await sendMessage(chatId, 'Cycle not found.');
    await showMasanielloMenu(chatId);
    return;
  }
  const tickets = await getCycleTickets(cycle.id);
  const last = tickets.length > 0 ? tickets[tickets.length - 1] : null;
  if (!last || last.status === 'open') {
    await sendMessage(
      chatId,
      'Nothing to undo. If a ticket is open, settle or discard it first.'
    );
    await showMasanielloMenu(chatId);
    return;
  }
  await sendMessage(
    chatId,
    'Undo the last settlement?\n\nTicket #' + last.ticket_no +
      ' was settled as ' + last.status.toUpperCase() +
      '. It will become open again and the cycle goes back to a bankroll of ' +
      formatNaira(Number(last.bankroll_before_kobo)) +
      '.\n\nYou can then settle it correctly or discard it.',
    masanielloUndoConfirm(cycle.id)
  );
}

// Undo step 2: do it.
async function handleMasanielloUndoDo(chatId: number, cycleId: string) {
  const outcome = await undoLastSettlement(cycleId);
  if (!outcome.ok) {
    await sendMessage(chatId, '❌ ' + outcome.error);
    await showMasanielloMenu(chatId);
    return;
  }
  await sendMessage(chatId, outcome.message);
  const active = await getActiveCycle();
  if (active) {
    await showOpenTicket(chatId, active);
  } else {
    await showMasanielloMenu(chatId);
  }
}

// Predict: runs the pasted matches through the rule and sends the
// Home / Draw / Away picks (in several messages if the list is long).
async function handlePredict(chatId: number, rawText: string) {
  const chunks = formatPrediction(runPrediction(rawText));
  for (let i = 0; i < chunks.length; i++) {
    if (i === chunks.length - 1) {
      await sendMessage(chatId, chunks[i], predictAgainKeyboard());
    } else {
      await sendMessage(chatId, chunks[i]);
    }
  }
}

// ── Tickets ───────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Sends one plain text message and reports whether Telegram accepted it.
// Used for the tickets so a failed send is noticed (the matches are then put
// back). Retries a few times, and waits when Telegram asks us to slow down.
async function sendTicketText(chatId: number, text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        }
      );
      if (res.ok) return true;
      if (res.status === 429) {
        let waitMs = 2000;
        try {
          const body = await res.json();
          const retryAfter = body && body.parameters && body.parameters.retry_after;
          if (typeof retryAfter === 'number') {
            waitMs = Math.min(retryAfter, 10) * 1000 + 200;
          }
        } catch (e) {
          console.error('could not read 429 body', e);
        }
        await sleep(waitMs);
        continue;
      }
      if (res.status >= 500) {
        await sleep(1000);
        continue;
      }
      return false;
    } catch (e) {
      console.error('ticket message send failed', e);
      await sleep(500);
    }
  }
  return false;
}

// Stored rows use dataLine; the rules module expects data_line.
function toRuleRow(r: { name: string; dataLine: string; league: string | null }): RuleRow {
  return { name: r.name, data_line: r.dataLine, league: r.league };
}

async function showTicketsMenu(chatId: number) {
  const c = await countStored();
  const n = c.ok ? c.count : 0;
  await sendMessage(
    chatId,
    c.ok
      ? 'Tickets: ' + n + ' ' + (n === 1 ? 'match' : 'matches') +
          ' stored (up to ' + MAX_STORED_MATCHES + ').'
      : 'Tickets: could not read the storage (' + c.error + ').',
    ticketsMenu(n)
  );
}

// The admin replied to the "Add Matches" prompt.
async function handleTicketsAdd(chatId: number, adminId: number, rawText: string) {
  const parsed = parseNewMatches(rawText);
  const lines: string[] = [];

  if (parsed.matches.length > 0) {
    const r = await addMatches(adminId, parsed.matches);
    if (r.ok) {
      lines.push(
        'Stored ' + r.added + ' new' +
          (r.replaced > 0 ? ', replaced ' + r.replaced + ' with the same name' : '') +
          '. Total stored: ' + r.total + '.'
      );
    } else {
      lines.push('❌ ' + r.error);
    }
  } else if (parsed.rejected.length === 0) {
    await sendMessage(chatId, 'No matches found.\n\n' + PREDICT_USAGE);
    await showTicketsMenu(chatId);
    return;
  } else {
    lines.push('Nothing was stored.');
  }

  if (parsed.matches.length > 0 && parsed.leaguesFound > 0) {
    const noLeague = parsed.matches.filter((x) => !x.league).length;
    lines.push(
      'Leagues found: ' + parsed.leaguesFound +
        (noLeague > 0 ? ' (' + noLeague + ' match' + (noLeague === 1 ? '' : 'es') + ' without a league)' : '') + '.'
    );
  }
  if (parsed.duplicatesInPaste > 0) {
    lines.push(
      parsed.duplicatesInPaste + ' repeated name(s) in this message: the later one was kept.'
    );
  }
  if (parsed.rejected.length > 0) {
    const shown = parsed.rejected
      .slice(0, 15)
      .map((x) => x.label + ' (' + x.reason + ')')
      .join(', ');
    lines.push(
      'Not stored: ' + shown +
        (parsed.rejected.length > 15 ? ' and ' + (parsed.rejected.length - 15) + ' more' : '') + '.'
    );
  }

  await sendMessage(chatId, lines.join('\n'));
  await showTicketsMenu(chatId);
}

// Lists the stored matches and the legs each one has under the rules
// (or 'no call').
async function handleTicketsView(chatId: number) {
  const l = await listStored();
  if (!l.ok) {
    await sendMessage(chatId, '❌ Could not read the storage: ' + l.error);
    await showTicketsMenu(chatId);
    return;
  }
  if (l.rows.length === 0) {
    await sendMessage(chatId, 'The storage is empty. Tap Add Matches.');
    await showTicketsMenu(chatId);
    return;
  }

  const entries = l.rows.map((r, i) => {
    const a = analyseMatch(toRuleRow(r));
    const what = !a
      ? 'could not be read'
      : a.legs.length === 0
        ? 'no call'
        : a.legs.map((x) => x.label).join(' | ');
    return i + 1 + ') ' + r.name + ' · ' + what + (r.league ? '\n' + r.league : '');
  });

  const chunks: string[] = [];
  let current = 'STORED MATCHES (' + l.rows.length + ')\n';
  for (let i = 0; i < entries.length; i++) {
    if (current.length + entries[i].length + 1 > 3500) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + entries[i];
  }
  if (current) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    if (i === chunks.length - 1) {
      await sendMessage(chatId, chunks[i], ticketsBackKeyboard());
    } else {
      await sendMessage(chatId, chunks[i]);
    }
  }
}

// Step 1 of creating tickets: show what will happen and ask to confirm.
async function handleTicketsCreateAsk(chatId: number) {
  const l = await listStored();
  if (!l.ok) {
    await sendMessage(chatId, '❌ Could not read the storage: ' + l.error);
    await showTicketsMenu(chatId);
    return;
  }
  if (l.rows.length === 0) {
    await sendMessage(chatId, 'The storage is empty. Add matches first.');
    await showTicketsMenu(chatId);
    return;
  }

  const plan = planRules(l.rows.map(toRuleRow));
  if (!plan.canBuild) {
    await sendMessage(chatId, describePlan(plan));
    await showTicketsMenu(chatId);
    return;
  }
  await sendMessage(chatId, describePlan(plan), ticketsCreateConfirm());
}

// Step 2: take every stored match (atomically), build and send the tickets.
// A second tap finds the storage empty and does nothing.
async function handleTicketsCreateDo(chatId: number) {
  const taken = await takeAll();
  if (!taken.ok) {
    await sendMessage(chatId, '❌ Could not read the storage: ' + taken.error);
    await showTicketsMenu(chatId);
    return;
  }
  const rows = taken.rows;
  if (rows.length === 0) {
    await sendMessage(
      chatId,
      'The storage is empty, nothing to do. (If you tapped twice, the tickets were already sent.)'
    );
    await showTicketsMenu(chatId);
    return;
  }

  const putBack = async (why: string) => {
    const rs = await restoreRows(rows);
    await sendMessage(
      chatId,
      why + '\n' +
        (rs.ok
          ? 'Your ' + rows.length + ' matches are back in the storage.'
          : '⚠️ Could not put the matches back (' + rs.error + '). Please add them again.')
    );
  };

  try {
    const plan = planRules(rows.map(toRuleRow));
    if (!plan.canBuild) {
      await putBack('No tickets were made. ' + (plan.reason || ''));
    } else {
      const deal = dealTickets(plan);
      const messages = formatTicketMessages(plan, deal).concat([
        formatSummary(plan, deal),
        formatTopOver35(plan, deal),
      ]);

      let failedAt = 0;
      for (let i = 0; i < messages.length; i++) {
        const sent = await sendTicketText(chatId, messages[i]);
        if (!sent) {
          failedAt = i + 1;
          break;
        }
        if (i < messages.length - 1) await sleep(300);
      }

      if (failedAt > 0) {
        await putBack(
          '❌ Sending stopped at message ' + failedAt + ' of ' + messages.length +
            '. Ignore the tickets sent above, they are not a complete set.'
        );
      } else {
        await sendMessage(
          chatId,
          'Done. The storage is now empty. Add the next batch whenever you are ready.'
        );
      }
    }
  } catch (e) {
    console.error('tickets create failed', e);
    await putBack('❌ Something went wrong while creating the tickets.');
  }
  await showTicketsMenu(chatId);
}

async function handleTicketsClearAsk(chatId: number) {
  const c = await countStored();
  if (!c.ok) {
    await sendMessage(chatId, '❌ Could not read the storage: ' + c.error);
    await showTicketsMenu(chatId);
    return;
  }
  if (c.count === 0) {
    await sendMessage(chatId, 'The storage is already empty.');
    await showTicketsMenu(chatId);
    return;
  }
  await sendMessage(
    chatId,
    'Clear all ' + c.count + ' stored matches? This cannot be undone.',
    ticketsClearConfirm()
  );
}

async function handleTicketsClearDo(chatId: number) {
  const r = await clearStored();
  await sendMessage(chatId, r.ok ? 'Storage cleared.' : '❌ Could not clear: ' + r.error);
  await showTicketsMenu(chatId);
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
  } else if (data === 'a_engagement_menu') {
    await clearDraft(adminId);
    await showEngagementMenu(chatId);
  } else if (data === 'a_eng_view') {
    const profile = await getChannelProfile();
    if (profile) {
      await sendMessage(chatId, formatProfile(profile));
    } else {
      await sendMessage(chatId, 'No channel profile found.');
    }
    await showEngagementMenu(chatId);
  } else if (data === 'a_eng_stats') {
    await sendMessage(chatId, await getEngagementSummary());
    await showEngagementMenu(chatId);
  } else if (data === 'a_eng_niche') {
    await sendForceReply(chatId, PROMPTS.engNiche);
  } else if (data === 'a_eng_tone') {
    await sendForceReply(chatId, PROMPTS.engTone);
  } else if (data === 'a_eng_avoid') {
    await sendForceReply(chatId, PROMPTS.engAvoid);
  } else if (data === 'a_eng_window') {
    await sendForceReply(chatId, PROMPTS.engWindow);
  } else if (data === 'a_eng_caps') {
    await sendForceReply(chatId, PROMPTS.engCaps);
  } else if (data === 'a_eng_reply_limits') {
    await sendForceReply(chatId, PROMPTS.engReplyLimits);
  } else if (data === 'a_eng_posts_toggle') {
    const next = await toggleAiPosts();
    if (next === null) {
      await sendMessage(chatId, 'Could not toggle AI posts.');
    } else {
      await sendMessage(chatId, next ? 'AI posts enabled.' : 'AI posts disabled.');
    }
    await showEngagementMenu(chatId);
  } else if (data === 'a_eng_toggle') {
    const next = await toggleAiReplies();
    if (next === null) {
      await sendMessage(chatId, 'Could not toggle AI replies.');
    } else {
      await sendMessage(chatId, next ? 'AI replies enabled.' : 'AI replies disabled.');
    }
    await showEngagementMenu(chatId);
  } else if (data === 'a_mas_menu') {
    await clearDraft(adminId);
    await showMasanielloMenu(chatId);
  } else if (data === 'a_mas_new') {
    const active = await getActiveCycle();
    if (active) {
      await sendMessage(
        chatId,
        'A cycle is already active. Finish or cancel it before starting a new one.'
      );
      await showMasanielloMenu(chatId);
    } else {
      await sendForceReply(chatId, PROMPTS.masNew);
    }
  } else if (data === 'a_mas_view') {
    const active = await getActiveCycle();
    if (active) {
      await sendMessage(chatId, cycleDashboard(active));
    } else {
      await sendMessage(chatId, 'No active cycle.');
    }
    await showMasanielloMenu(chatId);
  } else if (data === 'a_mas_next') {
    const active = await getActiveCycle();
    if (!active) {
      await sendMessage(chatId, 'No active cycle.');
      await showMasanielloMenu(chatId);
    } else if (await getOpenTicket(active.id)) {
      await sendMessage(chatId, 'There is already an open ticket:');
      await showOpenTicket(chatId, active);
    } else {
      await sendForceReply(chatId, PROMPTS.masTicket);
    }
  } else if (data === 'a_mas_ticket') {
    const active = await getActiveCycle();
    if (!active) {
      await sendMessage(chatId, 'No active cycle.');
      await showMasanielloMenu(chatId);
    } else {
      await showOpenTicket(chatId, active);
    }
  } else if (data === 'a_mas_win') {
    await handleMasanielloSettleAsk(chatId, 'win');
  } else if (data === 'a_mas_loss') {
    await handleMasanielloSettleAsk(chatId, 'loss');
  } else if (data === 'a_mas_void') {
    await handleMasanielloSettleAsk(chatId, 'void');
  } else if (data.startsWith('a_mas_do_')) {
    await handleMasanielloSettleDo(chatId, data);
  } else if (data === 'a_mas_hist') {
    await handleMasanielloHistory(chatId);
  } else if (data.startsWith('a_mas_h_')) {
    await handleMasanielloHistoryDetail(chatId, data.slice('a_mas_h_'.length));
  } else if (data.startsWith('a_mas_udo_')) {
    await handleMasanielloUndoDo(chatId, data.slice('a_mas_udo_'.length));
  } else if (data.startsWith('a_mas_ud_')) {
    await handleMasanielloUndoAsk(chatId, data.slice('a_mas_ud_'.length));
  } else if (data === 'a_mas_discard') {
    const active = await getActiveCycle();
    if (!active) {
      await sendMessage(chatId, 'No active cycle.');
    } else {
      const ok = await discardOpenTicket(active.id);
      await sendMessage(
        chatId,
        ok
          ? 'Ticket discarded. Your bankroll is unchanged.'
          : 'No open ticket to discard.'
      );
    }
    await showMasanielloMenu(chatId);
  } else if (data === 'a_mas_cancel') {
    const active = await getActiveCycle();
    if (!active) {
      await sendMessage(chatId, 'No active cycle to cancel.');
      await showMasanielloMenu(chatId);
    } else {
      await sendMessage(
        chatId,
        'Cancel the active cycle? This cannot be undone.\n\n' + cycleDashboard(active),
        masanielloCancelConfirm()
      );
    }
  } else if (data === 'a_mas_cancel_yes') {
    const ok = await cancelActiveCycle();
    await sendMessage(chatId, ok ? 'Cycle cancelled.' : 'No active cycle to cancel.');
    await showMasanielloMenu(chatId);
  } else if (data === 'a_predict') {
    await sendForceReply(chatId, PROMPTS.predict);
  } else if (data === 'a_tk_menu') {
    await clearDraft(adminId);
    await showTicketsMenu(chatId);
  } else if (data === 'a_tk_add') {
    await clearDraft(adminId);
    await sendForceReply(chatId, PROMPTS.tkAdd);
  } else if (data === 'a_tk_view') {
    await handleTicketsView(chatId);
  } else if (data === 'a_tk_create') {
    await handleTicketsCreateAsk(chatId);
  } else if (data === 'a_tk_create_yes') {
    await handleTicketsCreateDo(chatId);
  } else if (data === 'a_tk_clear') {
    await handleTicketsClearAsk(chatId);
  } else if (data === 'a_tk_clear_yes') {
    await handleTicketsClearDo(chatId);
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

async function handleEngagementReply(
  chatId: number,
  engCommand: string,
  rawText: string
): Promise<boolean> {
  let ok = false;
  let label = '';

  if (engCommand === 'eng_niche') {
    ok = await setNiche(rawText);
    label = 'Niche';
  } else if (engCommand === 'eng_tone') {
    ok = await setTone(rawText);
    label = 'Tone';
  } else if (engCommand === 'eng_avoid') {
    ok = await setTopicsToAvoid(rawText);
    label = 'Topics to avoid';
  } else if (engCommand === 'eng_window') {
    ok = await setPostingWindow(rawText);
    label = 'Posting window';
  } else if (engCommand === 'eng_caps') {
    ok = await setDailyCaps(rawText);
    label = 'Daily caps';
  } else if (engCommand === 'eng_reply_limits') {
    ok = await setReplyLimits(rawText);
    label = 'Reply limits';
  } else {
    return false;
  }

  await sendMessage(
    chatId,
    ok
      ? label + ' updated.'
      : label + ' could not be saved. Check the format and try again.'
  );
  await showEngagementMenu(chatId);
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

      // AI replies in the channel's linked discussion group.
      // The paid membership group is skipped up front.
      if (
        (chatType === 'group' || chatType === 'supergroup') &&
        typeof message.text === 'string' &&
        !text.startsWith('/') &&
        String(chatId) !== process.env.TELEGRAM_GROUP_ID
      ) {
        const consumed = await handleDiscussionMessage(
          message,
          !!from && isAdmin(from.id)
        );
        if (consumed) return NextResponse.json({ ok: true });
      }

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
        const promptCommand = PROMPT_COMMANDS[replyText];
        if (promptCommand.startsWith('eng_')) {
          await handleEngagementReply(chatId, promptCommand, text);
        } else if (promptCommand === 'mas_new') {
          await handleMasanielloNew(chatId, from.id, text);
        } else if (promptCommand === 'mas_ticket') {
          await handleMasanielloTicket(chatId, text);
        } else if (promptCommand === 'predict') {
          await handlePredict(chatId, text);
        } else if (promptCommand === 'tk_add') {
          await handleTicketsAdd(chatId, from.id, text);
        } else {
          await handleAdminCommand(chatId, from.id, promptCommand, parts);
          await showAdminMenu(chatId);
        }
        return NextResponse.json({ ok: true });
      }

      if (command === '/runcron') {
        if (chatType === 'private' && from && isAdmin(from.id)) {
          await handleRunCron(chatId);
        }
      } else if (command === '/testai') {
        if (chatType === 'private' && from && isAdmin(from.id)) {
          await sendMessage(chatId, 'Testing AI providers...');
          const result = await generateText(
            'You are a witty football betting channel assistant. Keep replies under 2 sentences.',
            'Write one short hype line about weekend football odds.'
          );
          if (result.ok) {
            await sendMessage(
              chatId,
              '✅ Provider: ' + result.provider + '\n\n' + result.text
            );
          } else {
            await sendMessage(chatId, '❌ Failed:\n' + result.error);
          }
        }
      } else if (command === '/testreply') {
        if (chatType === 'private' && from && isAdmin(from.id)) {
          const sample = args.join(' ').trim();
          if (!sample) {
            await sendMessage(
              chatId,
              'Usage: /testreply <a sample member comment>\nExample: /testreply Happy Sunday sir'
            );
          } else {
            const profile = await getChannelProfile();
            if (!profile) {
              await sendMessage(chatId, 'No channel profile found.');
            } else {
              const r = await generateReply(profile, sample);
              if (!r.ok) {
                await sendMessage(chatId, '❌ Failed:\n' + r.error);
              } else if (r.skip) {
                await sendMessage(
                  chatId,
                  '⏭ The AI chose to skip this message (no reply would be sent).'
                );
              } else {
                await sendMessage(
                  chatId,
                  '✅ (' + r.provider + ') Would reply:\n\n' + r.text
                );
              }
            }
          }
        }
      } else if (command === '/testmas') {
        if (chatType === 'private' && from && isAdmin(from.id)) {
          const usage =
            'Usage: /testmas bankroll,N,K,odds\nExample: /testmas 1000,5,3,2.00';
          const fields = args.join('').split(',');
          if (fields.length !== 4) {
            await sendMessage(chatId, usage);
          } else {
            const bankKobo = parseNairaToKobo(fields[0]);
            const n = /^\d+$/.test(fields[1]) ? parseInt(fields[1], 10) : NaN;
            const k = /^\d+$/.test(fields[2]) ? parseInt(fields[2], 10) : NaN;
            const oddsH = parseOdds(fields[3]);
            if (bankKobo === null || isNaN(n) || isNaN(k) || oddsH === null) {
              await sendMessage(
                chatId,
                'Could not read that. Bankroll in naira, N and K whole numbers, odds like 2.00.\n\n' +
                  usage
              );
            } else {
              await sendMessage(chatId, describeCycle(bankKobo, n, k, oddsH));
            }
          }
        }
      } else if (command === '/predict') {
        if (chatType === 'private' && from && isAdmin(from.id)) {
          const dataText = text.slice(parts[0].length).trim();
          if (!dataText) {
            await sendMessage(
              chatId,
              'Tap 🔮 Predict in the Admin Panel, or send /predict followed by your matches.\n\n' +
                PREDICT_USAGE
            );
          } else {
            await handlePredict(chatId, dataText);
          }
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
