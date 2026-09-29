// ═══════════════════════════════════════════════════════════════
// MASANIELLO STORE — database access for cycles and tickets.
// Service-role client only (same pattern as the rest of the bot).
// Never throws: callers get { ok:false, error } or null instead.
// ═══════════════════════════════════════════════════════════════

import { createAdminClient } from '@/lib/supabase/admin';
import {
  CycleState,
  CycleStatus,
  SettleResult,
  cycleStatus,
  formatNaira,
  initialState,
  planStake,
  settle,
  targetReturnKobo,
  validateConfig,
} from '@/lib/masaniello';

export type MasCycleStatus =
  | 'active'
  | 'achieved'
  | 'not_achieved'
  | 'infeasible'
  | 'cancelled';

export type MasCycle = {
  id: string;
  created_by: number;
  label: string | null;
  initial_bankroll_kobo: number;
  total_bets: number;
  wins_required: number;
  ref_odds_h: number;
  bankroll_kobo: number;
  bets_left: number;
  wins_needed: number;
  status: MasCycleStatus;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type MasTicket = {
  id: string;
  cycle_id: string;
  ticket_no: number;
  odds_h: number;
  stake_kobo: number;
  prediction: string | null;
  status: 'open' | 'win' | 'loss' | 'void';
  capped: boolean;
  bankroll_before_kobo: number;
  bankroll_after_kobo: number | null;
  bets_left_before: number;
  wins_needed_before: number;
  created_at: string;
  settled_at: string | null;
};

export function cycleToState(c: MasCycle): CycleState {
  return {
    bankrollKobo: Number(c.bankroll_kobo),
    betsLeft: c.bets_left,
    winsNeeded: c.wins_needed,
  };
}

export async function getActiveCycle(): Promise<MasCycle | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('masaniello_cycles')
    .select('*')
    .eq('status', 'active')
    .maybeSingle();
  if (error) {
    console.error('getActiveCycle failed', error);
    return null;
  }
  return (data as MasCycle | null) ?? null;
}

export async function createCycle(input: {
  createdBy: number;
  bankrollKobo: number;
  totalBets: number;
  winsRequired: number;
  refOddsH: number;
}): Promise<{ ok: true; cycle: MasCycle } | { ok: false; error: string }> {
  const err = validateConfig(
    input.bankrollKobo,
    input.totalBets,
    input.winsRequired,
    input.refOddsH
  );
  if (err) return { ok: false, error: err };

  const start = initialState(
    input.bankrollKobo,
    input.totalBets,
    input.winsRequired
  );

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('masaniello_cycles')
    .insert({
      created_by: input.createdBy,
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
      return {
        ok: false,
        error: 'A cycle is already active. Finish or cancel it before starting a new one.',
      };
    }
    console.error('createCycle failed', error);
    return { ok: false, error: 'Could not save the cycle. Try again.' };
  }
  return { ok: true, cycle: data as MasCycle };
}

// Cancels the active cycle (if any). Returns true if one was cancelled.
export async function cancelActiveCycle(): Promise<boolean> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('masaniello_cycles')
    .update({ status: 'cancelled', closed_at: now, updated_at: now })
    .eq('status', 'active')
    .select('id');
  if (error) {
    console.error('cancelActiveCycle failed', error);
    return false;
  }
  return (data ?? []).length > 0;
}

// ── Tickets ───────────────────────────────────────────────────────────────

export async function getOpenTicket(cycleId: string): Promise<MasTicket | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('masaniello_tickets')
    .select('*')
    .eq('cycle_id', cycleId)
    .eq('status', 'open')
    .maybeSingle();
  if (error) {
    console.error('getOpenTicket failed', error);
    return null;
  }
  return (data as MasTicket | null) ?? null;
}

// Creates an OPEN ticket. The stake is calculated now and stored on the
// ticket, so settlement later uses exactly what was shown to the admin.
export async function createTicket(
  cycle: MasCycle,
  oddsH: number,
  prediction: string | null
): Promise<{ ok: true; ticket: MasTicket } | { ok: false; error: string }> {
  if (cycle.status !== 'active') {
    return { ok: false, error: 'This cycle is not active.' };
  }

  const existing = await getOpenTicket(cycle.id);
  if (existing) {
    return {
      ok: false,
      error: 'There is already an open ticket. Discard it or settle it first.',
    };
  }

  const state = cycleToState(cycle);
  const plan = planStake(state, oddsH, cycle.ref_odds_h);
  if (plan.status !== 'OK' && plan.status !== 'CAPPED') {
    return { ok: false, error: plan.message };
  }

  const supabase = createAdminClient();
  const { data: last, error: lastErr } = await supabase
    .from('masaniello_tickets')
    .select('ticket_no')
    .eq('cycle_id', cycle.id)
    .order('ticket_no', { ascending: false })
    .limit(1);
  if (lastErr) {
    console.error('createTicket ticket_no lookup failed', lastErr);
    return { ok: false, error: 'Could not save the ticket. Try again.' };
  }
  const ticketNo = last && last.length > 0 ? Number(last[0].ticket_no) + 1 : 1;

  const { data, error } = await supabase
    .from('masaniello_tickets')
    .insert({
      cycle_id: cycle.id,
      ticket_no: ticketNo,
      odds_h: oddsH,
      stake_kobo: plan.stakeKobo,
      prediction: prediction,
      status: 'open',
      capped: plan.capped,
      bankroll_before_kobo: state.bankrollKobo,
      bets_left_before: state.betsLeft,
      wins_needed_before: state.winsNeeded,
    })
    .select('*')
    .single();

  if (error || !data) {
    if (error && error.code === '23505') {
      return {
        ok: false,
        error: 'There is already an open ticket. Discard it or settle it first.',
      };
    }
    console.error('createTicket insert failed', error);
    return { ok: false, error: 'Could not save the ticket. Try again.' };
  }
  return { ok: true, ticket: data as MasTicket };
}

// Deletes the open ticket (typo / wrong odds). No bankroll change.
export async function discardOpenTicket(cycleId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('masaniello_tickets')
    .delete()
    .eq('cycle_id', cycleId)
    .eq('status', 'open')
    .select('id');
  if (error) {
    console.error('discardOpenTicket failed', error);
    return false;
  }
  return (data ?? []).length > 0;
}

// ── Settlement ────────────────────────────────────────────────────────────

function mapStatus(s: CycleStatus): MasCycleStatus {
  if (s === 'ACHIEVED') return 'achieved';
  if (s === 'NOT_ACHIEVED') return 'not_achieved';
  if (s === 'INFEASIBLE') return 'infeasible';
  return 'active';
}

function signedNaira(kobo: number): string {
  if (kobo > 0) return '+' + formatNaira(kobo);
  if (kobo < 0) return '-' + formatNaira(-kobo);
  return formatNaira(0);
}

export type SettleOutcome =
  | { ok: true; summary: string; newStatus: MasCycleStatus }
  | { ok: false; error: string };

// Settles the OPEN ticket as win / loss / void.
//  1. The ticket is claimed atomically (open -> result), so a double tap
//     or a stale button can never settle it twice.
//  2. The cycle is then updated with an optimistic lock (it only updates
//     if it is still exactly in the state the ticket was created from).
//  3. If step 2 fails, the ticket is put back to open.
// Void: stake returned, the cycle state is unchanged, no bet is used.
export async function settleTicket(
  cycle: MasCycle,
  ticketId: string,
  result: SettleResult
): Promise<SettleOutcome> {
  if (cycle.status !== 'active') {
    return { ok: false, error: 'This cycle is not active.' };
  }

  const supabase = createAdminClient();
  const { data: t, error: tErr } = await supabase
    .from('masaniello_tickets')
    .select('*')
    .eq('id', ticketId)
    .eq('cycle_id', cycle.id)
    .maybeSingle();
  if (tErr) {
    console.error('settleTicket lookup failed', tErr);
    return { ok: false, error: 'Could not load the ticket. Try again.' };
  }
  const ticket = t as MasTicket | null;
  if (!ticket) {
    return { ok: false, error: 'That ticket no longer exists.' };
  }
  if (ticket.status !== 'open') {
    return {
      ok: false,
      error: 'This ticket was already settled (' + ticket.status + '). Nothing changed.',
    };
  }

  const state = cycleToState(cycle);
  if (
    Number(ticket.bankroll_before_kobo) !== state.bankrollKobo ||
    ticket.bets_left_before !== state.betsLeft ||
    ticket.wins_needed_before !== state.winsNeeded
  ) {
    return {
      ok: false,
      error: 'The cycle changed since this ticket was created. Discard it and enter it again.',
    };
  }

  const stake = Number(ticket.stake_kobo);
  const out = settle(state, result, stake, ticket.odds_h);
  const next = out.state;
  const newStatus = mapStatus(out.status);
  const now = new Date().toISOString();

  const { data: claimed, error: claimErr } = await supabase
    .from('masaniello_tickets')
    .update({
      status: result,
      bankroll_after_kobo: next.bankrollKobo,
      settled_at: now,
    })
    .eq('id', ticket.id)
    .eq('status', 'open')
    .select('id');
  if (claimErr) {
    console.error('settleTicket claim failed', claimErr);
    return { ok: false, error: 'Could not settle the ticket. Try again.' };
  }
  if (!claimed || claimed.length === 0) {
    return { ok: false, error: 'This ticket was already settled. Nothing changed.' };
  }

  const { data: upd, error: updErr } = await supabase
    .from('masaniello_cycles')
    .update({
      bankroll_kobo: next.bankrollKobo,
      bets_left: next.betsLeft,
      wins_needed: next.winsNeeded,
      status: newStatus,
      updated_at: now,
      closed_at: newStatus === 'active' ? null : now,
    })
    .eq('id', cycle.id)
    .eq('status', 'active')
    .eq('bankroll_kobo', cycle.bankroll_kobo)
    .eq('bets_left', cycle.bets_left)
    .eq('wins_needed', cycle.wins_needed)
    .select('id');

  if (updErr || !upd || upd.length === 0) {
    console.error('settleTicket cycle update failed', updErr);
    const { error: revertErr } = await supabase
      .from('masaniello_tickets')
      .update({ status: 'open', bankroll_after_kobo: null, settled_at: null })
      .eq('id', ticket.id);
    if (revertErr) console.error('settleTicket revert failed', revertErr);
    return { ok: false, error: 'Could not update the cycle. The ticket was left open. Try again.' };
  }

  return {
    ok: true,
    newStatus,
    summary: settlementSummary(cycle, ticket, result, next, newStatus),
  };
}

function settlementSummary(
  cycle: MasCycle,
  ticket: MasTicket,
  result: SettleResult,
  next: CycleState,
  newStatus: MasCycleStatus
): string {
  const before = Number(ticket.bankroll_before_kobo);
  const initial = Number(cycle.initial_bankroll_kobo);
  const lines: string[] = [];

  if (result === 'void') {
    lines.push('🎟 Ticket #' + ticket.ticket_no + ' settled: VOID ➖');
    lines.push('Stake ' + formatNaira(Number(ticket.stake_kobo)) + ' returned. No bet was used.');
    lines.push('Bankroll unchanged: ' + formatNaira(next.bankrollKobo));
    lines.push('Bets left: ' + next.betsLeft + ' of ' + cycle.total_bets);
    lines.push('You can enter another ticket.');
    return lines.join('\n');
  }

  lines.push(
    '🎟 Ticket #' + ticket.ticket_no + ' settled: ' +
      (result === 'win' ? 'WIN ✅' : 'LOSS ❌')
  );
  lines.push(
    'Odds ' + (ticket.odds_h / 100).toFixed(2) + ', stake ' +
      formatNaira(Number(ticket.stake_kobo))
  );
  lines.push(
    'Bankroll: ' + formatNaira(before) + ' → ' + formatNaira(next.bankrollKobo)
  );

  if (newStatus === 'achieved') {
    const used = cycle.total_bets - next.betsLeft;
    lines.push('');
    lines.push('🏆 TARGET ACHIEVED after ' + used + ' bets.');
    lines.push('Final bankroll: ' + formatNaira(next.bankrollKobo));
    lines.push('Result vs starting bankroll: ' + signedNaira(next.bankrollKobo - initial));
    lines.push('The cycle is closed. You can start a new one.');
  } else if (newStatus === 'not_achieved') {
    lines.push('');
    lines.push('❌ TARGET NOT ACHIEVED.');
    lines.push('Final bankroll: ' + formatNaira(next.bankrollKobo));
    lines.push('Result vs starting bankroll: ' + signedNaira(next.bankrollKobo - initial));
    lines.push('The cycle is closed. You can start a new one.');
  } else if (newStatus === 'infeasible') {
    lines.push('');
    lines.push('⚠️ TARGET INFEASIBLE: the bankroll is below the ₦1 minimum stake.');
    lines.push('Final bankroll: ' + formatNaira(next.bankrollKobo));
    lines.push('Result vs starting bankroll: ' + signedNaira(next.bankrollKobo - initial));
    lines.push('The cycle is closed. You can start a new one.');
  } else {
    lines.push('Bets left: ' + next.betsLeft + ' of ' + cycle.total_bets);
    lines.push('Wins needed: ' + next.winsNeeded + ' of ' + cycle.wins_required);
    lines.push(
      'Projected return now: ' + formatNaira(targetReturnKobo(next, cycle.ref_odds_h))
    );
    lines.push('');
    lines.push('Ready for the next ticket.');
  }
  return lines.join('\n');
}

// ── Text views ────────────────────────────────────────────────────────────

function statusLabel(s: MasCycleStatus): string {
  if (s === 'active') return 'ACTIVE';
  if (s === 'achieved') return 'TARGET ACHIEVED ✅';
  if (s === 'not_achieved') return 'TARGET NOT ACHIEVED ❌';
  if (s === 'infeasible') return 'TARGET INFEASIBLE ⚠️';
  return 'CANCELLED';
}

// Human-readable dashboard for a cycle.
export function cycleDashboard(c: MasCycle): string {
  const state = cycleToState(c);
  const lines: string[] = [];
  lines.push('🎯 Masaniello cycle');
  lines.push('Status: ' + statusLabel(c.status));
  lines.push(
    'Bankroll: ' +
      formatNaira(state.bankrollKobo) +
      ' (started ' +
      formatNaira(Number(c.initial_bankroll_kobo)) +
      ')'
  );
  lines.push('Bets left: ' + c.bets_left + ' of ' + c.total_bets);
  lines.push('Wins needed: ' + c.wins_needed + ' of ' + c.wins_required);
  lines.push('Reference odds: ' + (c.ref_odds_h / 100).toFixed(2));

  if (c.status === 'active' && cycleStatus(state) === 'ACTIVE') {
    const target = targetReturnKobo(state, c.ref_odds_h);
    lines.push('Target return: ' + formatNaira(target));
    const p = planStake(state, c.ref_odds_h, c.ref_odds_h);
    if (p.stakeKobo > 0) {
      lines.push(
        'If the next ticket is at ' +
          (c.ref_odds_h / 100).toFixed(2) +
          ': stake ' +
          formatNaira(p.stakeKobo)
      );
    }
    lines.push('');
    lines.push(
      'The target is a plan at the reference odds, not a guarantee. If the cycle fails, the cycle bankroll is lost.'
    );
  }
  return lines.join('\n');
}

// Card for a ticket (uses the STORED stake and odds).
export function ticketCard(c: MasCycle, t: MasTicket): string {
  const state = cycleToState(c);
  const stake = Number(t.stake_kobo);
  const win = settle(state, 'win', stake, t.odds_h);
  const loss = settle(state, 'loss', stake, t.odds_h);
  const target = targetReturnKobo(state, c.ref_odds_h);
  const betNo = c.total_bets - c.bets_left + 1;

  const winTxt =
    formatNaira(win.state.bankrollKobo) +
    (win.status === 'ACHIEVED' ? ' ✅ target achieved' : '');
  const lossTxt =
    formatNaira(loss.state.bankrollKobo) +
    (loss.status === 'NOT_ACHIEVED' || loss.status === 'INFEASIBLE'
      ? ' ❌ target not achieved'
      : '');

  const lines: string[] = [];
  lines.push('🎟 Ticket #' + t.ticket_no + ' (bet ' + betNo + ' of ' + c.total_bets + ')');
  lines.push('Odds: ' + (t.odds_h / 100).toFixed(2));
  if (t.prediction) lines.push('Prediction: ' + t.prediction);
  lines.push('');
  lines.push('💰 STAKE: ' + formatNaira(stake));
  lines.push('If it wins: ' + winTxt);
  lines.push('If it loses: ' + lossTxt);
  lines.push('Projected return: ' + formatNaira(target));

  if (t.capped) {
    lines.push('');
    lines.push(
      '⚠️ Plan degraded: these odds are too low to hold the plan, so the stake is your whole bankroll.'
    );
  }
  if (target < Number(c.initial_bankroll_kobo)) {
    lines.push('');
    lines.push(
      '⚠️ The projected return (' +
        formatNaira(target) +
        ') is below your starting bankroll (' +
        formatNaira(Number(c.initial_bankroll_kobo)) +
        ').'
    );
  }
  if (t.odds_h !== c.ref_odds_h) {
    lines.push('');
    lines.push(
      'These odds differ from the reference (' +
        (c.ref_odds_h / 100).toFixed(2) +
        '), so the return is a projection, not a guarantee.'
    );
  }
  return lines.join('\n');
}
