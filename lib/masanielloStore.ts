// ═══════════════════════════════════════════════════════════════
// MASANIELLO STORE — database access for cycles and tickets.
// Service-role client only (same pattern as the rest of the bot).
// Never throws: callers get { ok:false, error } or null instead.
// ═══════════════════════════════════════════════════════════════

import { createAdminClient } from '@/lib/supabase/admin';
import {
  CycleState,
  cycleStatus,
  formatNaira,
  initialState,
  planStake,
  targetReturnKobo,
  validateConfig,
} from '@/lib/masaniello';

export type MasCycleStatus = |
  'active' |
  'achieved' |
  'not_achieved' |
  'infeasible' |
  'cancelled';

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

export function cycleToState(c: MasCycle): CycleState {
  return {
    bankrollKobo: Number(c.bankroll_kobo),
    betsLeft: c.bets_left,
    winsNeeded: c.wins_needed,
  };
}

export async function getActiveCycle(): Promise < MasCycle | null > {
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
}): Promise < { ok: true;cycle: MasCycle } | { ok: false;error: string } > {
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
export async function cancelActiveCycle(): Promise < boolean > {
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
