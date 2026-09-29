// ═══════════════════════════════════════════════════════════════
// MASANIELLO ENGINE — pure functions, no DB / Telegram imports.
//
// CONVENTION (validated in Stage 0, see report):
//   V(n,0) = 1                       (target reached, cycle stops)
//   V(n,k) = 0 when k > n            (unreachable)
//   V(n,k) = V(n-1,k) + (V(n-1,k-1) - V(n-1,k)) / Oref
//   Target return R = bankroll / V(n,k), re-derived at every ticket.
//   Stake for a ticket at ACTUAL odds O:
//        s = (R * V(n-1,k-1) - bankroll) / (O - 1)
//   so a WIN lands exactly on the plan. Future tickets are assumed
//   to be at the reference odds. Under variable odds the return is
//   a projection, NOT a guarantee.
//
// MONEY: integer kobo. ODDS: integer hundredths (1.85 -> 185).
// Stakes are floored to whole naira. Exact rational math via BigInt,
// so a stake that is exactly 375 never comes out as 374.999...
// No BigInt literals (1n) are used, so it compiles on any TS target.
// ═══════════════════════════════════════════════════════════════

export const MIN_STAKE_KOBO = 100; // ₦1

export type CycleStatus =
  | 'ACTIVE'
  | 'ACHIEVED'
  | 'NOT_ACHIEVED'
  | 'INFEASIBLE';

export type CycleState = {
  bankrollKobo: number;
  betsLeft: number;
  winsNeeded: number;
};

export type StakeStatus =
  | 'OK'
  | 'CAPPED'
  | 'ACHIEVED'
  | 'NOT_ACHIEVED'
  | 'INFEASIBLE'
  | 'INVALID_ODDS';

export type StakePlan = {
  status: StakeStatus;
  stakeKobo: number;
  // bankroll if this ticket wins / loses (after flooring + payout flooring)
  winBankrollKobo: number;
  lossBankrollKobo: number;
  // target return re-derived from current bankroll (projection only)
  projectedReturnKobo: number;
  capped: boolean; // stake had to be reduced to the bankroll
  message: string;
};

// ── Exact rational arithmetic (BigInt) ────────────────────────────────────
type Q = { n: bigint; d: bigint };
const ZERO = BigInt(0);
const ONE = BigInt(1);

function gcd(a: bigint, b: bigint): bigint {
  let x = a < ZERO ? -a : a;
  let y = b < ZERO ? -b : b;
  while (y !== ZERO) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}
function q(n: bigint, d: bigint): Q {
  if (d < ZERO) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  if (g > ONE) {
    n = n / g;
    d = d / g;
  }
  return { n, d };
}
const qAdd = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
const qSub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
const qMul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const qDiv = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
const qInt = (x: number): Q => q(BigInt(x), ONE);
function qFloor(a: Q): bigint {
  // floor for possibly negative values
  const div = a.n / a.d;
  if (a.n < ZERO && div * a.d !== a.n) return div - ONE;
  return div;
}

// ── V(n,k) at reference odds ──────────────────────────────────────────────
const vCache: Record<string, Q> = {};
function V(n: number, k: number, refH: number): Q {
  if (k <= 0) return qInt(1);
  if (k > n) return qInt(0);
  const key = n + ',' + k + ',' + refH;
  const hit = vCache[key];
  if (hit) return hit;
  const a = V(n - 1, k, refH);
  const b = V(n - 1, k - 1, refH);
  // a + (b - a) / Oref, Oref = refH/100
  const res = qAdd(a, qDiv(qMul(qSub(b, a), qInt(100)), qInt(refH)));
  vCache[key] = res;
  return res;
}

// ── Input helpers ─────────────────────────────────────────────────────────
// "1.85" -> 185. Rejects >2 decimals, non-numbers, and odds <= 1.00.
export function parseOdds(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const h = Math.round(parseFloat(t) * 100);
  if (!isFinite(h) || h <= 100 || h > 100000) return null;
  return h;
}

// Naira text (up to 2 decimals) -> kobo integer, or null.
export function parseNairaToKobo(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const kobo = Math.round(parseFloat(t) * 100);
  if (!isFinite(kobo) || kobo <= 0) return null;
  return kobo;
}

export function validateConfig(
  bankrollKobo: number,
  totalBets: number,
  winsRequired: number,
  refOddsH: number
): string | null {
  if (!Number.isInteger(bankrollKobo) || bankrollKobo < MIN_STAKE_KOBO)
    return 'Bankroll must be at least ₦1.';
  if (!Number.isInteger(totalBets) || totalBets < 2 || totalBets > 30)
    return 'Total bets (N) must be a whole number from 2 to 30.';
  if (!Number.isInteger(winsRequired) || winsRequired < 1 || winsRequired >= totalBets)
    return 'Required wins (K) must be at least 1 and less than N.';
  if (!Number.isInteger(refOddsH) || refOddsH <= 100)
    return 'Reference odds must be greater than 1.00.';
  return null;
}

export function initialState(
  bankrollKobo: number,
  totalBets: number,
  winsRequired: number
): CycleState {
  return { bankrollKobo, betsLeft: totalBets, winsNeeded: winsRequired };
}

// Target return (kobo, floored) for a state at reference odds.
export function targetReturnKobo(state: CycleState, refOddsH: number): number {
  const v = V(state.betsLeft, state.winsNeeded, refOddsH);
  if (v.n === ZERO) return 0;
  return Number(qFloor(qDiv(qInt(state.bankrollKobo), v)));
}

export function cycleStatus(state: CycleState): CycleStatus {
  if (state.winsNeeded <= 0) return 'ACHIEVED';
  if (state.betsLeft <= 0 || state.winsNeeded > state.betsLeft)
    return 'NOT_ACHIEVED';
  if (state.bankrollKobo < MIN_STAKE_KOBO) return 'INFEASIBLE';
  return 'ACTIVE';
}

function payoutKobo(stakeKobo: number, oddsH: number): number {
  return Math.floor((stakeKobo * oddsH) / 100);
}

// ── The stake for the next ticket ─────────────────────────────────────────
export function planStake(
  state: CycleState,
  oddsH: number,
  refOddsH: number
): StakePlan {
  const blank = (status: StakeStatus, message: string): StakePlan => ({
    status,
    stakeKobo: 0,
    winBankrollKobo: state.bankrollKobo,
    lossBankrollKobo: state.bankrollKobo,
    projectedReturnKobo: 0,
    capped: false,
    message,
  });

  if (!Number.isInteger(oddsH) || oddsH <= 100 || !Number.isInteger(refOddsH) || refOddsH <= 100)
    return blank('INVALID_ODDS', 'Odds must be greater than 1.00.');

  const st = cycleStatus(state);
  if (st === 'ACHIEVED') return blank('ACHIEVED', 'Target already achieved.');
  if (st === 'NOT_ACHIEVED') return blank('NOT_ACHIEVED', 'Target can no longer be achieved.');
  if (st === 'INFEASIBLE')
    return blank('INFEASIBLE', 'Bankroll is below the minimum stake (₦1).');

  const n = state.betsLeft;
  const k = state.winsNeeded;
  const bank = qInt(state.bankrollKobo);
  const vNow = V(n, k, refOddsH);
  const R = qDiv(bank, vNow); // vNow > 0 here because k <= n
  const winTarget = qMul(R, V(n - 1, k - 1, refOddsH));
  const oMinus1 = q(BigInt(oddsH - 100), BigInt(100));
  const exact = qDiv(qSub(winTarget, bank), oMinus1);

  let capped = false;
  let stakeKobo: number;
  const exactFloorKobo = Number(qFloor(exact));
  if (exactFloorKobo >= state.bankrollKobo) {
    capped = true;
    stakeKobo = Math.floor(state.bankrollKobo / 100) * 100;
  } else {
    stakeKobo = Math.floor(exactFloorKobo / 100) * 100;
  }
  if (stakeKobo < 0) stakeKobo = 0;

  if (stakeKobo < MIN_STAKE_KOBO)
    return {
      ...blank('INFEASIBLE', 'Calculated stake is below ₦1, so the cycle cannot continue.'),
      projectedReturnKobo: Number(qFloor(R)),
    };

  const winBank = state.bankrollKobo - stakeKobo + payoutKobo(stakeKobo, oddsH);
  const lossBank = state.bankrollKobo - stakeKobo;

  return {
    status: capped ? 'CAPPED' : 'OK',
    stakeKobo,
    winBankrollKobo: winBank,
    lossBankrollKobo: lossBank,
    projectedReturnKobo: Number(qFloor(R)),
    capped,
    message: capped
      ? 'Plan degraded: the odds are too low to hold the plan, so the stake is capped at your bankroll.'
      : 'OK',
  };
}

// ── Settlement ────────────────────────────────────────────────────────────
export type SettleResult = 'win' | 'loss' | 'void';

export function settle(
  state: CycleState,
  result: SettleResult,
  stakeKobo: number,
  oddsH: number
): { state: CycleState; status: CycleStatus } {
  if (result === 'void') {
    // stake returned, nothing consumed
    return { state: { ...state }, status: cycleStatus(state) };
  }
  let next: CycleState;
  if (result === 'win') {
    next = {
      bankrollKobo: state.bankrollKobo - stakeKobo + payoutKobo(stakeKobo, oddsH),
      betsLeft: state.betsLeft - 1,
      winsNeeded: state.winsNeeded - 1,
    };
  } else {
    next = {
      bankrollKobo: state.bankrollKobo - stakeKobo,
      betsLeft: state.betsLeft - 1,
      winsNeeded: state.winsNeeded,
    };
  }
  return { state: next, status: cycleStatus(next) };
}

// ── Formatting helpers ────────────────────────────────────────────────────
export function formatNaira(kobo: number): string {
  const whole = Math.floor(kobo / 100);
  const frac = kobo % 100;
  const w = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '₦' + w + (frac ? '.' + String(frac).padStart(2, '0') : '');
}

// Text ladder of every reachable state at REFERENCE odds (for /testmas).
export function describeCycle(
  bankrollKobo: number,
  totalBets: number,
  winsRequired: number,
  refOddsH: number
): string {
  const err = validateConfig(bankrollKobo, totalBets, winsRequired, refOddsH);
  if (err) return '❌ ' + err;
  if (totalBets > 12) return '❌ /testmas ladder is limited to N up to 12.';

  const start = initialState(bankrollKobo, totalBets, winsRequired);
  const target = targetReturnKobo(start, refOddsH);
  const lines: string[] = [];
  lines.push(
    'Bankroll ' + formatNaira(bankrollKobo) + ', N=' + totalBets + ', K=' + winsRequired +
      ', odds ' + (refOddsH / 100).toFixed(2)
  );
  lines.push('Target return: ' + formatNaira(target));
  lines.push('');
  lines.push('left/need | bankroll | stake | win -> | loss ->');

  const seen: Record<string, boolean> = {};
  let queue: CycleState[] = [start];
  let rows = 0;
  while (queue.length > 0 && rows < 60) {
    const s = queue.shift() as CycleState;
    const key = s.bankrollKobo + '|' + s.betsLeft + '|' + s.winsNeeded;
    if (seen[key]) continue;
    seen[key] = true;
    if (cycleStatus(s) !== 'ACTIVE') continue;
    const p = planStake(s, refOddsH, refOddsH);
    if (p.stakeKobo <= 0) continue;
    const w = settle(s, 'win', p.stakeKobo, refOddsH);
    const l = settle(s, 'loss', p.stakeKobo, refOddsH);
    const wTxt = w.status === 'ACHIEVED' ? formatNaira(w.state.bankrollKobo) + ' ✅' : formatNaira(w.state.bankrollKobo);
    const lTxt =
      l.status === 'NOT_ACHIEVED' || l.status === 'INFEASIBLE'
        ? formatNaira(l.state.bankrollKobo) + ' ❌'
        : formatNaira(l.state.bankrollKobo);
    lines.push(
      s.betsLeft + '/' + s.winsNeeded + ' | ' + formatNaira(s.bankrollKobo) + ' | ' +
        formatNaira(p.stakeKobo) + ' | ' + wTxt + ' | ' + lTxt
    );
    rows++;
    if (w.status === 'ACTIVE') queue.push(w.state);
    if (l.status === 'ACTIVE') queue.push(l.state);
  }
  return lines.join('\n');
}
