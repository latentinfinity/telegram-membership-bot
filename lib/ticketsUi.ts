// ═══════════════════════════════════════════════════════════════
// TICKETS UI — every Tickets button and handler lives here, so route.ts
// only forwards the buttons (data starting with "a_tk_") and the
// "Add Matches" reply. Keyboards for the Tickets menu are defined here too.
//
//   a_tk_menu        Tickets menu
//   a_tk_add         Add Matches (force-reply prompt)
//   a_tk_create      Create Tickets (confirm), a_tk_create_yes (do it)
//   a_tk_pair        Pair Tickets (new): two options per best match
//   a_tk_view        View Stored Matches
//   a_tk_conf        Confidence lists
//   a_tk_clear       Clear Matches (confirm), a_tk_clear_yes (do it)
// ═══════════════════════════════════════════════════════════════

import { sendMessage } from '@/lib/telegram';
import type { InlineKeyboard } from '@/lib/telegram';
import { clearDraft } from '@/lib/postDrafts';
import { PROMPTS, sendForceReply } from '@/lib/menus';
import { PREDICT_USAGE } from '@/lib/predict';
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
import { planConfidence, formatConfidence } from '@/lib/confidence';
import { planPairs, dealPairs, describePairPlan, formatPairTickets } from '@/lib/pairTickets';
import {
  listStored,
  countStored,
  addMatches,
  clearStored,
  takeAll,
  restoreRows,
} from '@/lib/ticketStore';

// ── Keyboards ─────────────────────────────────────────────────────────────
function tkMenu(storedCount: number): InlineKeyboard {
  const rows: InlineKeyboard = [];
  rows.push([{ text: '➕ Add Matches', callback_data: 'a_tk_add' }]);
  if (storedCount > 0) {
    rows.push([
      {
        text: '🎫 Create Tickets (' + storedCount + ' stored)',
        callback_data: 'a_tk_create',
      },
    ]);
    rows.push([{ text: '🧩 Pair Tickets', callback_data: 'a_tk_pair' }]);
    rows.push([{ text: '📋 View Stored Matches', callback_data: 'a_tk_view' }]);
    rows.push([{ text: '🎯 Confidence', callback_data: 'a_tk_conf' }]);
    rows.push([{ text: '🗑 Clear Matches', callback_data: 'a_tk_clear' }]);
  }
  rows.push([{ text: '⬅️ Admin Panel', callback_data: 'admin_menu' }]);
  return rows;
}

function tkCreateConfirm(): InlineKeyboard {
  return [
    [{ text: '✅ Yes, create tickets', callback_data: 'a_tk_create_yes' }],
    [{ text: '↩️ No, go back', callback_data: 'a_tk_menu' }],
  ];
}

function tkClearConfirm(): InlineKeyboard {
  return [
    [{ text: '✅ Yes, clear all', callback_data: 'a_tk_clear_yes' }],
    [{ text: '↩️ No, keep them', callback_data: 'a_tk_menu' }],
  ];
}

function tkBack(): InlineKeyboard {
  return [[{ text: '⬅️ Tickets Menu', callback_data: 'a_tk_menu' }]];
}

// ── Helpers ───────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Sends one plain text message and reports whether Telegram accepted it.
// Retries a few times, and waits when Telegram asks us to slow down.
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

// Stored rows use dataLine; the rules modules expect data_line.
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
    tkMenu(n)
  );
}

// ── Add Matches (the reply to the force-reply prompt) ─────────────────────
export async function handleTicketsAdd(chatId: number, adminId: number, rawText: string) {
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

// ── View Stored Matches ───────────────────────────────────────────────────
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
      await sendMessage(chatId, chunks[i], tkBack());
    } else {
      await sendMessage(chatId, chunks[i]);
    }
  }
}

// ── Confidence (read only) ────────────────────────────────────────────────
async function handleTicketsConfidence(chatId: number) {
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

  const plan = planConfidence(l.rows.map(toRuleRow));
  const chunks = formatConfidence(plan);
  for (let i = 0; i < chunks.length; i++) {
    if (i === chunks.length - 1) {
      await sendMessage(chatId, chunks[i], tkBack());
    } else {
      await sendMessage(chatId, chunks[i]);
    }
  }
}

// ── Pair Tickets (read only, the storage is not emptied) ──────────────────
async function handleTicketsPair(chatId: number) {
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

  const plan = planPairs(l.rows.map(toRuleRow));
  if (!plan.canBuild) {
    await sendMessage(chatId, describePairPlan(plan));
    await showTicketsMenu(chatId);
    return;
  }

  const deal = dealPairs(plan);
  const messages = formatPairTickets(plan, deal);

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
    await sendMessage(
      chatId,
      '❌ Sending stopped at message ' + failedAt + ' of ' + messages.length +
        '. Ignore the tickets sent above, they are not a complete set. Your matches are still stored: tap Pair Tickets again.'
    );
  }
  await showTicketsMenu(chatId);
}

// ── Create Tickets (the 13-call rules; empties the storage) ───────────────
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
  await sendMessage(chatId, describePlan(plan), tkCreateConfirm());
}

// Takes every stored match (atomically), builds and sends the tickets.
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

// ── Clear Matches ─────────────────────────────────────────────────────────
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
    tkClearConfirm()
  );
}

async function handleTicketsClearDo(chatId: number) {
  const r = await clearStored();
  await sendMessage(chatId, r.ok ? 'Storage cleared.' : '❌ Could not clear: ' + r.error);
  await showTicketsMenu(chatId);
}

// ── The one entry point route.ts calls for every a_tk_ button ─────────────
export async function handleTicketsButton(
  data: string,
  chatId: number,
  adminId: number
): Promise<void> {
  if (data === 'a_tk_menu') {
    await clearDraft(adminId);
    await showTicketsMenu(chatId);
  } else if (data === 'a_tk_add') {
    await clearDraft(adminId);
    await sendForceReply(chatId, PROMPTS.tkAdd);
  } else if (data === 'a_tk_view') {
    await handleTicketsView(chatId);
  } else if (data === 'a_tk_conf') {
    await handleTicketsConfidence(chatId);
  } else if (data === 'a_tk_pair') {
    await handleTicketsPair(chatId);
  } else if (data === 'a_tk_create') {
    await handleTicketsCreateAsk(chatId);
  } else if (data === 'a_tk_create_yes') {
    await handleTicketsCreateDo(chatId);
  } else if (data === 'a_tk_clear') {
    await handleTicketsClearAsk(chatId);
  } else if (data === 'a_tk_clear_yes') {
    await handleTicketsClearDo(chatId);
  }
}
