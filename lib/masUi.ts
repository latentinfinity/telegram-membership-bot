// ═══════════════════════════════════════════════════════════════
// MASANIELLO UI — named, parallel cycles. Every a_mas_ button and the
// New Cycle / New Ticket replies live here, so route.ts only forwards.
//   New cycle:  Roll1 | 1000,61,41,2.00
//   New ticket: Roll1 | 1.85 | Arsenal & Chelsea over 1.5
// Several cycles can be active at once; two active cycles cannot share a name.
// ═══════════════════════════════════════════════════════════════

import { sendMessage } from '@/lib/telegram';
import type { InlineKeyboard } from '@/lib/telegram';
import { clearDraft } from '@/lib/postDrafts';
import { PROMPTS, sendForceReply } from '@/lib/menus';
import { createAdminClient } from '@/lib/supabase/admin';
import { formatNaira, parseNairaToKobo, parseOdds, validateConfig, initialState } from '@/lib/masaniello';
import {
  createTicket,
  getOpenTicket,
  discardOpenTicket,
  ticketCard,
  settleTicket,
  getRecentCycles,
  getCycleById,
  getCycleTickets,
  cycleDetail,
  historyLabel,
  cycleDashboard,
  undoLastSettlement,
} from '@/lib/masanielloStore';
import type { MasCycle, MasTicket } from '@/lib/masanielloStore';

const MAX_NAME = 30;
const UUID = /^[0-9a-f-]{36}$/i;

// ── Names ─────────────────────────────────────────────────────────────────
function nameOf(c: MasCycle): string {
  return c.label && c.label.trim() ? c.label.trim() : 'No name';
}
function normKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
function cleanName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}
function head(c: MasCycle): string {
  return '📛 ' + nameOf(c);
}

// ── Database helpers (never throw) ────────────────────────────────────────
async function listActive(): Promise<MasCycle[] | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('masaniello_cycles')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error) {
    console.error('masUi listActive failed', error);
    return null;
  }
  return (data ?? []) as unknown as MasCycle[];
}

async function openCycleIds(ids: string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  if (ids.length === 0) return out;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('masaniello_tickets')
    .select('cycle_id')
    .in('cycle_id', ids)
    .eq('status', 'open');
  if (error) {
    console.error('masUi openCycleIds failed', error);
    return out;
  }
  ((data ?? []) as unknown as { cycle_id: string }[]).forEach((r) => {
    out[r.cycle_id] = true;
  });
  return out;
}

async function getTicketById(id: string): Promise<MasTicket | null> {
  if (!UUID.test(id)) return null;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('masaniello_tickets')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('masUi getTicketById failed', error);
    return null;
  }
  return (data as unknown as MasTicket | null) ?? null;
}

async function cancelCycleById(id: string): Promise<boolean> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('masaniello_cycles')
    .update({ status: 'cancelled', closed_at: now, updated_at: now })
    .eq('id', id)
    .eq('status', 'active')
    .select('id');
  if (error) {
    console.error('masUi cancelCycleById failed', error);
    return false;
  }
  return (data ?? []).length > 0;
}

async function createNamedCycle(input: {
  createdBy: number;
  name: string;
  bankrollKobo: number;
  totalBets: number;
  winsRequired: number;
  refOddsH: number;
}): Promise<{ ok: true; cycle: MasCycle } | { ok: false; error: string }> {
  if (!input.name) return { ok: false, error: 'The cycle needs a name.' };
  if (input.name.length > MAX_NAME) {
    return { ok: false, error: 'The name can be at most ' + MAX_NAME + ' characters.' };
  }
  const err = validateConfig(input.bankrollKobo, input.totalBets, input.winsRequired, input.refOddsH);
  if (err) return { ok: false, error: err };

  const active = await listActive();
  if (active === null) return { ok: false, error: 'Could not read the cycles. Try again.' };
  const key = normKey(input.name);
  if (active.some((c) => normKey(c.label || '') === key)) {
    return { ok: false, error: 'An active cycle is already named "' + input.name + '". Pick another name.' };
  }

  const start = initialState(input.bankrollKobo, input.totalBets, input.winsRequired);
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('masaniello_cycles')
    .insert({
      created_by: input.createdBy,
      label: input.name,
      initial_bankroll_kobo: input.bankrollKobo,
      total_bets: input.totalBets,
      wins_required: input.winsRequired,
      ref_odds_h: input.refOddsH,
      bankroll_kobo: start.bankrollKobo,
      bets_left: start.betsLeft,
      wins_needed: start.winsNeeded,
      status: 'active',
    })
    .select('*')
    .single();
  if (error || !data) {
    if (error && error.code === '23505') {
      return { ok: false, error: 'An active cycle is already named "' + input.name + '".' };
    }
    console.error('masUi createNamedCycle failed', error);
    return { ok: false, error: 'Could not save the cycle. Try again.' };
  }
  return { ok: true, cycle: data as unknown as MasCycle };
}

// ── Screens ───────────────────────────────────────────────────────────────
async function showMenu(chatId: number) {
  const active = await listActive();
  const rows: InlineKeyboard = [];
  let text: string;
  if (active === null) {
    text = 'Masaniello: could not read the cycles. Try again.';
  } else {
    const open = await openCycleIds(active.map((c) => c.id));
    active.forEach((c) => {
      rows.push([
        {
          text:
            nameOf(c) + ' · ' + formatNaira(Number(c.bankroll_kobo)) + ' · ' + c.bets_left + ' left' +
            (open[c.id] ? ' 🎟' : ''),
          callback_data: 'a_mas_c_' + c.id,
        },
      ]);
    });
    text =
      active.length === 0
        ? 'Masaniello: no active cycles. Tap New Cycle.'
        : 'Masaniello: ' + active.length + ' active ' + (active.length === 1 ? 'cycle' : 'cycles') +
          '. Tap one to open it. 🎟 = a ticket is open.';
  }
  rows.push([{ text: '➕ New Cycle', callback_data: 'a_mas_new' }]);
  rows.push([{ text: '📜 History', callback_data: 'a_mas_hist' }]);
  rows.push([{ text: '⬅️ Admin Panel', callback_data: 'admin_menu' }]);
  await sendMessage(chatId, text, rows);
}

async function showCycle(chatId: number, cycle: MasCycle, prefix: string = '') {
  const tickets = await getCycleTickets(cycle.id);
  const hasOpen = tickets.some((t) => t.status === 'open');
  const rows: InlineKeyboard = [];
  if (hasOpen) rows.push([{ text: '🎟 View Open Ticket', callback_data: 'a_mas_t_' + cycle.id }]);
  else rows.push([{ text: '🎟 Next Ticket', callback_data: 'a_mas_n_' + cycle.id }]);
  if (!hasOpen && tickets.length > 0) {
    rows.push([{ text: '↩️ Undo Last Settlement', callback_data: 'a_mas_ud_' + cycle.id }]);
  }
  rows.push([{ text: '🚫 Cancel This Cycle', callback_data: 'a_mas_cx_' + cycle.id }]);
  rows.push([{ text: '⬅️ Masaniello Menu', callback_data: 'a_mas_menu' }]);
  await sendMessage(
    chatId,
    prefix + head(cycle) + '\n' + cycleDashboard(cycle) + (hasOpen ? '\n\n🎟 A ticket is open.' : ''),
    rows
  );
}

function ticketKeyboard(cycleId: string): InlineKeyboard {
  return [
    [
      { text: '✅ Win', callback_data: 'a_mas_w_' + cycleId },
      { text: '❌ Loss', callback_data: 'a_mas_l_' + cycleId },
      { text: '➖ Void', callback_data: 'a_mas_v_' + cycleId },
    ],
    [{ text: '🗑 Discard Ticket', callback_data: 'a_mas_dc_' + cycleId }],
    [{ text: '⬅️ Back to ' + 'cycle', callback_data: 'a_mas_c_' + cycleId }],
  ];
}

async function showOpenTicket(chatId: number, cycle: MasCycle) {
  const ticket = await getOpenTicket(cycle.id);
  if (!ticket) {
    await sendMessage(chatId, 'There is no open ticket on ' + nameOf(cycle) + '.');
    await showCycle(chatId, cycle);
    return;
  }
  await sendMessage(chatId, head(cycle) + '\n' + ticketCard(cycle, ticket), ticketKeyboard(cycle.id));
}

// Loads an ACTIVE cycle by id, or tells the admin and returns null.
async function activeById(chatId: number, id: string): Promise<MasCycle | null> {
  if (!UUID.test(id)) {
    await sendMessage(chatId, 'That button is not valid. Nothing changed.');
    await showMenu(chatId);
    return null;
  }
  const c = await getCycleById(id);
  if (!c || c.status !== 'active') {
    await sendMessage(chatId, 'That cycle is not active any more.');
    await showMenu(chatId);
    return null;
  }
  return c;
}

// Old buttons (no cycle id): work only when exactly one cycle is active.
async function legacyCycle(chatId: number): Promise<MasCycle | null> {
  const active = await listActive();
  if (active && active.length === 1) return active[0];
  await sendMessage(
    chatId,
    active && active.length === 0
      ? 'There is no active cycle.'
      : 'Several cycles are active. Open the Masaniello menu and tap the cycle you want.'
  );
  await showMenu(chatId);
  return null;
}

// ── Actions ───────────────────────────────────────────────────────────────
async function nextTicket(chatId: number, cycle: MasCycle) {
  if (await getOpenTicket(cycle.id)) {
    await sendMessage(chatId, 'There is already an open ticket:');
    await showOpenTicket(chatId, cycle);
    return;
  }
  await sendMessage(
    chatId,
    'Next ticket for ' + nameOf(cycle) + '.\nType it as:\n' + nameOf(cycle) + ' | odds | prediction'
  );
  await sendForceReply(chatId, PROMPTS.masTicket);
}

async function settleAsk(chatId: number, cycle: MasCycle, result: 'win' | 'loss' | 'void') {
  const ticket = await getOpenTicket(cycle.id);
  if (!ticket) {
    await sendMessage(chatId, 'There is no open ticket to settle on ' + nameOf(cycle) + '.');
    await showCycle(chatId, cycle);
    return;
  }
  const what =
    result === 'void'
      ? 'The stake is returned and no bet is used.'
      : 'You can still undo the last settlement afterwards if you tap the wrong one.';
  const rows: InlineKeyboard = [
    [
      {
        text: '✅ Yes, settle as ' + result.toUpperCase(),
        callback_data: 'a_mas_do_' + result + '_' + ticket.id,
      },
    ],
    [{ text: '↩️ No, go back', callback_data: 'a_mas_t_' + cycle.id }],
  ];
  await sendMessage(
    chatId,
    head(cycle) + '\nSettle ticket #' + ticket.ticket_no +
      ' (odds ' + (ticket.odds_h / 100).toFixed(2) +
      ', stake ' + formatNaira(Number(ticket.stake_kobo)) +
      ') as ' + result.toUpperCase() + '?\n' + what,
    rows
  );
}

// data = a_mas_do_<result>_<ticketId>. The ticket tells us which cycle.
async function settleDo(chatId: number, data: string) {
  const rest = data.slice('a_mas_do_'.length);
  const sep = rest.indexOf('_');
  const resultRaw = sep === -1 ? '' : rest.slice(0, sep);
  const ticketId = sep === -1 ? '' : rest.slice(sep + 1);
  if ((resultRaw !== 'win' && resultRaw !== 'loss' && resultRaw !== 'void') || !UUID.test(ticketId)) {
    await sendMessage(chatId, 'That button is not valid. Nothing changed.');
    await showMenu(chatId);
    return;
  }
  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await sendMessage(chatId, 'That ticket no longer exists. Nothing changed.');
    await showMenu(chatId);
    return;
  }
  const cycle = await activeById(chatId, ticket.cycle_id);
  if (!cycle) return;

  const outcome = await settleTicket(cycle, ticketId, resultRaw);
  if (!outcome.ok) {
    await sendMessage(chatId, '❌ ' + outcome.error);
    await showCycle(chatId, cycle);
    return;
  }
  await sendMessage(chatId, head(cycle) + '\n' + outcome.summary);
  if (outcome.newStatus === 'active') {
    const fresh = await getCycleById(cycle.id);
    if (fresh) await showCycle(chatId, fresh);
    else await showMenu(chatId);
  } else {
    await showMenu(chatId);
  }
}

async function discardTicket(chatId: number, cycle: MasCycle) {
  const ok = await discardOpenTicket(cycle.id);
  await sendMessage(
    chatId,
    ok ? 'Ticket discarded. The bankroll of ' + nameOf(cycle) + ' is unchanged.' : 'No open ticket to discard.'
  );
  await showCycle(chatId, cycle);
}

async function cancelAsk(chatId: number, cycle: MasCycle) {
  await sendMessage(
    chatId,
    'Cancel "' + nameOf(cycle) + '"? This cannot be undone. Only this cycle is cancelled.\n\n' + cycleDashboard(cycle),
    [
      [
        { text: '✅ Yes, cancel it', callback_data: 'a_mas_cxy_' + cycle.id },
        { text: '↩️ No, keep it', callback_data: 'a_mas_c_' + cycle.id },
      ],
    ]
  );
}

async function cancelDo(chatId: number, cycle: MasCycle) {
  const ok = await cancelCycleById(cycle.id);
  await sendMessage(chatId, ok ? 'Cycle "' + nameOf(cycle) + '" cancelled.' : 'That cycle was not active.');
  await showMenu(chatId);
}

async function historyList(chatId: number) {
  const cycles = await getRecentCycles(10);
  if (cycles.length === 0) {
    await sendMessage(chatId, 'No cycles yet.');
    await showMenu(chatId);
    return;
  }
  const rows: InlineKeyboard = cycles.map((c) => [
    { text: nameOf(c) + ' ' + historyLabel(c), callback_data: 'a_mas_h_' + c.id },
  ]);
  rows.push([{ text: '⬅️ Masaniello Menu', callback_data: 'a_mas_menu' }]);
  await sendMessage(chatId, 'Recent cycles (newest first). Tap one to see its tickets.', rows);
}

async function historyDetail(chatId: number, id: string) {
  const cycle = UUID.test(id) ? await getCycleById(id) : null;
  if (!cycle) {
    await sendMessage(chatId, 'Cycle not found.');
    await showMenu(chatId);
    return;
  }
  const tickets = await getCycleTickets(cycle.id);
  const canUndo = cycle.status === 'achieved' || cycle.status === 'not_achieved' || cycle.status === 'infeasible';
  const rows: InlineKeyboard = [];
  if (canUndo) rows.push([{ text: '↩️ Undo Last Settlement', callback_data: 'a_mas_ud_' + cycle.id }]);
  rows.push([{ text: '⬅️ History', callback_data: 'a_mas_hist' }]);
  rows.push([{ text: '⬅️ Masaniello Menu', callback_data: 'a_mas_menu' }]);
  await sendMessage(chatId, head(cycle) + '\n' + cycleDetail(cycle, tickets), rows);
}

async function undoAsk(chatId: number, id: string) {
  const cycle = UUID.test(id) ? await getCycleById(id) : null;
  if (!cycle) {
    await sendMessage(chatId, 'Cycle not found.');
    await showMenu(chatId);
    return;
  }
  const tickets = await getCycleTickets(cycle.id);
  const last = tickets.length > 0 ? tickets[tickets.length - 1] : null;
  if (!last || last.status === 'open') {
    await sendMessage(chatId, 'Nothing to undo. If a ticket is open, settle or discard it first.');
    await showMenu(chatId);
    return;
  }
  await sendMessage(
    chatId,
    head(cycle) + '\nUndo the last settlement?\n\nTicket #' + last.ticket_no +
      ' was settled as ' + last.status.toUpperCase() +
      '. It will become open again and the cycle goes back to a bankroll of ' +
      formatNaira(Number(last.bankroll_before_kobo)) +
      '.\n\nYou can then settle it correctly or discard it.',
    [
      [{ text: '✅ Yes, undo it', callback_data: 'a_mas_udo_' + cycle.id }],
      [{ text: '↩️ No, keep it', callback_data: 'a_mas_menu' }],
    ]
  );
}

async function undoDo(chatId: number, id: string) {
  if (!UUID.test(id)) {
    await sendMessage(chatId, 'That button is not valid. Nothing changed.');
    await showMenu(chatId);
    return;
  }
  const outcome = await undoLastSettlement(id);
  if (!outcome.ok) {
    await sendMessage(chatId, '❌ ' + outcome.error);
    await showMenu(chatId);
    return;
  }
  await sendMessage(chatId, outcome.message);
  const fresh = await getCycleById(id);
  if (fresh && fresh.status === 'active') await showOpenTicket(chatId, fresh);
  else await showMenu(chatId);
}

// ── The one entry point route.ts calls for every a_mas_ button ────────────
export async function handleMasButton(data: string, chatId: number, adminId: number): Promise<void> {
  if (data === 'a_mas_menu') {
    await clearDraft(adminId);
    await showMenu(chatId);
    return;
  }
  if (data === 'a_mas_new') {
    await sendForceReply(chatId, PROMPTS.masNew);
    return;
  }
  if (data === 'a_mas_hist') {
    await historyList(chatId);
    return;
  }
  if (data.indexOf('a_mas_h_') === 0) {
    await historyDetail(chatId, data.slice('a_mas_h_'.length));
    return;
  }
  if (data.indexOf('a_mas_udo_') === 0) {
    await undoDo(chatId, data.slice('a_mas_udo_'.length));
    return;
  }
  if (data.indexOf('a_mas_ud_') === 0) {
    await undoAsk(chatId, data.slice('a_mas_ud_'.length));
    return;
  }
  if (data.indexOf('a_mas_do_') === 0) {
    await settleDo(chatId, data);
    return;
  }

  // Buttons that carry the cycle id.
  const withId: { prefix: string; run: (c: MasCycle) => Promise<void> }[] = [
    { prefix: 'a_mas_c_', run: (c) => showCycle(chatId, c) },
    { prefix: 'a_mas_n_', run: (c) => nextTicket(chatId, c) },
    { prefix: 'a_mas_t_', run: (c) => showOpenTicket(chatId, c) },
    { prefix: 'a_mas_w_', run: (c) => settleAsk(chatId, c, 'win') },
    { prefix: 'a_mas_l_', run: (c) => settleAsk(chatId, c, 'loss') },
    { prefix: 'a_mas_v_', run: (c) => settleAsk(chatId, c, 'void') },
    { prefix: 'a_mas_dc_', run: (c) => discardTicket(chatId, c) },
    { prefix: 'a_mas_cxy_', run: (c) => cancelDo(chatId, c) },
    { prefix: 'a_mas_cx_', run: (c) => cancelAsk(chatId, c) },
  ];
  for (let i = 0; i < withId.length; i++) {
    if (data.indexOf(withId[i].prefix) === 0) {
      const c = await activeById(chatId, data.slice(withId[i].prefix.length));
      if (c) await withId[i].run(c);
      return;
    }
  }

  // Old buttons without a cycle id (from messages sent before this update).
  const legacy: Record<string, (c: MasCycle) => Promise<void>> = {
    a_mas_view: (c) => showCycle(chatId, c),
    a_mas_next: (c) => nextTicket(chatId, c),
    a_mas_ticket: (c) => showOpenTicket(chatId, c),
    a_mas_win: (c) => settleAsk(chatId, c, 'win'),
    a_mas_loss: (c) => settleAsk(chatId, c, 'loss'),
    a_mas_void: (c) => settleAsk(chatId, c, 'void'),
    a_mas_discard: (c) => discardTicket(chatId, c),
    a_mas_cancel: (c) => cancelAsk(chatId, c),
    a_mas_cancel_yes: (c) => cancelDo(chatId, c),
  };
  if (legacy[data]) {
    const c = await legacyCycle(chatId);
    if (c) await legacy[data](c);
    return;
  }
  await showMenu(chatId);
}

// ── Replies to the force-reply prompts ────────────────────────────────────
// Roll1 | 1000,61,41,2.00
export async function handleMasNewReply(chatId: number, adminId: number, rawText: string) {
  const bar = rawText.indexOf('|');
  const usage = 'Send: name | bankroll,N,K,odds\nExample: Roll1 | 1000,61,41,2.00';
  if (bar === -1) {
    await sendMessage(chatId, 'Could not read that. The name is missing.\n' + usage);
    await showMenu(chatId);
    return;
  }
  const name = cleanName(rawText.slice(0, bar));
  const fields = rawText.slice(bar + 1).replace(/\s+/g, '').split(',');
  if (!name || fields.length !== 4) {
    await sendMessage(chatId, 'Could not read that.\n' + usage);
    await showMenu(chatId);
    return;
  }
  const bankKobo = parseNairaToKobo(fields[0]);
  const n = /^\d+$/.test(fields[1]) ? parseInt(fields[1], 10) : NaN;
  const k = /^\d+$/.test(fields[2]) ? parseInt(fields[2], 10) : NaN;
  const oddsH = parseOdds(fields[3]);
  if (bankKobo === null || isNaN(n) || isNaN(k) || oddsH === null) {
    await sendMessage(
      chatId,
      'Could not read that. Bankroll in naira, N and K whole numbers, odds like 2.00.\n' + usage
    );
    await showMenu(chatId);
    return;
  }
  const result = await createNamedCycle({
    createdBy: adminId,
    name,
    bankrollKobo: bankKobo,
    totalBets: n,
    winsRequired: k,
    refOddsH: oddsH,
  });
  if (!result.ok) {
    await sendMessage(chatId, '❌ ' + result.error);
    await showMenu(chatId);
    return;
  }
  await showCycle(chatId, result.cycle, 'Cycle created.\n\n');
}

// Roll1 | 1.85 | Arsenal & Chelsea over 1.5
export async function handleMasTicketReply(chatId: number, rawText: string) {
  const usage = 'Send: name | odds | prediction\nExample: Roll1 | 1.85 | Arsenal & Chelsea over 1.5';
  const active = await listActive();
  if (active === null) {
    await sendMessage(chatId, 'Could not read the cycles. Try again.');
    await showMenu(chatId);
    return;
  }
  const parts = rawText.split('|');
  const first = cleanName(parts[0] || '');
  let cycle: MasCycle | undefined = active.find((c) => normKey(c.label || '') === normKey(first));
  let oddsText = parts.length > 1 ? parts[1] : '';
  let predText = parts.length > 2 ? parts.slice(2).join('|').trim() : '';

  // Old style "odds | prediction" still works when exactly one cycle is active.
  if (!cycle && active.length === 1 && parseOdds(first) !== null) {
    cycle = active[0];
    oddsText = first;
    predText = parts.length > 1 ? parts.slice(1).join('|').trim() : '';
  }

  if (!cycle) {
    const names = active.map((c) => nameOf(c)).join(', ');
    await sendMessage(
      chatId,
      'No active cycle is named "' + first + '".' + (names ? '\nActive: ' + names : '') + '\n' + usage
    );
    await showMenu(chatId);
    return;
  }
  const oddsH = parseOdds(oddsText);
  if (oddsH === null) {
    await sendMessage(
      chatId,
      'Could not read the odds.\n' + usage + '\nOdds must be greater than 1.00 with at most 2 decimals.'
    );
    await showCycle(chatId, cycle);
    return;
  }
  const result = await createTicket(cycle, oddsH, predText ? predText.slice(0, 300) : null);
  if (!result.ok) {
    await sendMessage(chatId, '❌ ' + result.error);
    await showCycle(chatId, cycle);
    return;
  }
  await sendMessage(chatId, head(cycle) + '\n' + ticketCard(cycle, result.ticket), ticketKeyboard(cycle.id));
}
