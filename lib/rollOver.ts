// ═══════════════════════════════════════════════════════════════
// ROLL OVER — the best stored matches for a daily roll over, ranked.
// Pure functions, no DB / Telegram imports. Only ./correctScore.
//
// Matches in the 2+ pool (both formulas give both teams 2 or more) are
// LEFT OUT, so nothing here clashes with Confidence or Best Options.
//
// With the four averages a1 (home scored), a2 (home conceded),
// b1 (away scored), b2 (away conceded):
//   eH = (a1 + b2) / 2     eA = (b1 + a2) / 2
//   expected goals (total) = eH + eA = (a1 + a2 + b1 + b2) / 2
//   strongest side = max(eH, eA)
//
// OVER 2.5 : both formulas predict a total of 5 or more goals
//            AND strongest side >= 2.4           (the best slice of that set)
// OVER 1.5 : both formulas give 2:1, 1:2, 3:1 or 1:3 (any mix of these)
//            AND expected goals >= 3.2           (the best slice of that set)
//
// Ranking: every Over 2.5 match first, then every Over 1.5 match; inside
// each group the highest expected goals first (ties: stored order).
// All comparisons are exact (decimal strings scaled to integers).
// No percentage is calculated. The storage is only read, never changed.
// ═══════════════════════════════════════════════════════════════

import { calibratedScores, TRAINING_ROWS } from './correctScore';

// ── Types ─────────────────────────────────────────────────────────────────
export type RollRow = {
  name: string;
  data_line: string;
  league: string | null;
};

export type RollKind = 'over25' | 'over15';

export type RollPick = {
  name: string;
  league: string | null;
  kind: RollKind;
  sum4: bigint; // a1 + a2 + b1 + b2, scaled by 10^9
  strongest2: bigint; // max(a1 + b2, b1 + a2), scaled by 10^9
};

export type RollPlan = {
  stored: number;
  picks: RollPick[]; // already ranked: Over 2.5 first, then Over 1.5
  poolLeftOut: number;
  noneCount: number;
  unreadable: string[];
};

type Pair = { home: number;away: number };

const MAX_NAME_SHOWN = 60;
const MAX_LEAGUE_SHOWN = 60;
const MAX_MESSAGE_CHARS = 3500;

// Measured on the TRAINING_ROWS past matches (fitted on the same matches).
const PAST_OVER25_GROUP = { over25: 84, over15: 93, matches: 74 };
const PAST_OVER15_GROUP = { over15: 84, matches: 91 };

// ── Exact decimal helpers (no BigInt literals) ────────────────────────────
let SCALE = BigInt(1);
for (let i = 0; i < 9; i++) SCALE = SCALE * BigInt(10);
const STRONGEST_MIN = BigInt(48) * (SCALE / BigInt(10)); // a1+b2 or b1+a2 >= 4.8 (strongest side 2.4)
const OVER15_SUM = BigInt(64) * (SCALE / BigInt(10)); // sum of four >= 6.4 (expected goals 3.2)
const TWO = BigInt(2);
const HUNDRED = BigInt(100);

function toScaled(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d{1,9}(\.\d{1,9})?$/.test(t)) return null;
  const dot = t.indexOf('.');
  const whole = dot === -1 ? t : t.slice(0, dot);
  let frac = dot === -1 ? '' : t.slice(dot + 1);
  while (frac.length < 9) frac += '0';
  return BigInt(whole + frac);
}

// hundredths of a goal, rounded DOWN
function hundredthsText(sumScaled: bigint): string {
  const h = (sumScaled * HUNDRED) / (TWO * SCALE);
  const whole = h / HUNDRED;
  const frac = (h % HUNDRED).toString();
  return whole.toString() + '.' + (frac.length < 2 ? '0' + frac : frac);
}

// ── The rules (pure, testable over every score pair) ──────────────────────
function isPool(p: Pair, e: Pair): boolean {
  return p.home >= 2 && p.away >= 2 && e.home >= 2 && e.away >= 2;
}

function totalFive(p: Pair, e: Pair): boolean {
  return p.home + p.away >= 5 && e.home + e.away >= 5;
}

function inCornerSet(s: Pair): boolean {
  return (
    (s.home === 2 && s.away === 1) ||
    (s.home === 1 && s.away === 2) ||
    (s.home === 3 && s.away === 1) ||
    (s.home === 1 && s.away === 3)
  );
}

// 'pool' | 'over25-set' | 'over15-set' | null (before the best-slice checks)
export function rollSet(p: Pair, e: Pair): 'pool' | 'over25-set' | 'over15-set' | null {
  if (isPool(p, e)) return 'pool';
  if (totalFive(p, e)) return 'over25-set';
  if (inCornerSet(p) && inCornerSet(e)) return 'over15-set';
  return null;
}

function shorten(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 3).trim() + '...';
}

// ── The plan ──────────────────────────────────────────────────────────────
export function planRollOver(rows: RollRow[]): RollPlan {
  const over25: { pick: RollPick;idx: number } [] = [];
  const over15: { pick: RollPick;idx: number } [] = [];
  const unreadable: string[] = [];
  let poolLeftOut = 0;
  let noneCount = 0;
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const parts = row.data_line.split(',').map(function(s) { return s.trim(); });
    let nums: string[] | null = null;
    if (parts.length === 4) nums = parts;
    else if (parts.length === 6) nums = parts.slice(2);
    const cs = nums ? calibratedScores(nums[0], nums[1], nums[2], nums[3]) : null;
    const a1 = nums ? toScaled(nums[0]) : null;
    const a2 = nums ? toScaled(nums[1]) : null;
    const b1 = nums ? toScaled(nums[2]) : null;
    const b2 = nums ? toScaled(nums[3]) : null;
    if (!nums || !cs || a1 === null || a2 === null || b1 === null || b2 === null) {
      unreadable.push(row.name);
      continue;
    }
    
    const set = rollSet(cs.prod, cs.exp);
    if (set === 'pool') {
      poolLeftOut++;
      continue;
    }
    
    const sum4 = a1 + a2 + b1 + b2;
    const homeSide = a1 + b2;
    const awaySide = b1 + a2;
    const strongest2 = homeSide > awaySide ? homeSide : awaySide;
    
    if (set === 'over25-set' && strongest2 >= STRONGEST_MIN) {
      over25.push({
        pick: { name: row.name, league: row.league, kind: 'over25', sum4: sum4, strongest2: strongest2 },
        idx: i,
      });
    } else if (set === 'over15-set' && sum4 >= OVER15_SUM) {
      over15.push({
        pick: { name: row.name, league: row.league, kind: 'over15', sum4: sum4, strongest2: strongest2 },
        idx: i,
      });
    } else {
      noneCount++;
    }
  }
  
  function rank(x: { pick: RollPick;idx: number }, y: { pick: RollPick;idx: number }): number {
    if (x.pick.sum4 !== y.pick.sum4) return x.pick.sum4 < y.pick.sum4 ? 1 : -1;
    return x.idx - y.idx;
  }
  over25.sort(rank);
  over15.sort(rank);
  
  const picks: RollPick[] = [];
  for (let i = 0; i < over25.length; i++) picks.push(over25[i].pick);
  for (let i = 0; i < over15.length; i++) picks.push(over15[i].pick);
  
  return {
    stored: rows.length,
    picks: picks,
    poolLeftOut: poolLeftOut,
    noneCount: noneCount,
    unreadable: unreadable,
  };
}

// ── Output ────────────────────────────────────────────────────────────────
function footerText(plan: RollPlan): string {
  let n25 = 0;
  let n15 = 0;
  for (let i = 0; i < plan.picks.length; i++) {
    if (plan.picks[i].kind === 'over25') n25++;
    else n15++;
  }
  const lines: string[] = [];
  lines.push(
    plan.picks.length + ' of ' + plan.stored + ' stored matches: ' + n25 + ' Over 2.5, ' + n15 + ' Over 1.5.'
  );
  if (plan.poolLeftOut > 0) {
    lines.push(plan.poolLeftOut + ' match' + (plan.poolLeftOut === 1 ? '' : 'es') + ' in the 2+ pool left out on purpose.');
  }
  if (plan.unreadable.length > 0) {
    lines.push('Could not be read: ' + plan.unreadable.join('; ') + '.');
  }
  lines.push(
    'In ' + TRAINING_ROWS + ' past matches: the Over 2.5 group won Over 2.5 about ' + PAST_OVER25_GROUP.over25 +
    '% and Over 1.5 about ' + PAST_OVER25_GROUP.over15 + '% (' + PAST_OVER25_GROUP.matches +
    ' matches); the Over 1.5 group won Over 1.5 about ' + PAST_OVER15_GROUP.over15 + '% (' +
    PAST_OVER15_GROUP.matches + ' matches). The cut points were fitted on those same matches, so new matches may do worse. No result is recorded.'
  );
  return lines.join('\n');
}

export function formatRollOver(plan: RollPlan): string[] {
  const footer = footerText(plan);
  if (plan.picks.length === 0) {
    return ['No stored match fits the Roll Over rules.\n\n' + footer];
  }
  
  const blocks: string[] = [];
  for (let i = 0; i < plan.picks.length; i++) {
    const p = plan.picks[i];
    const lines: string[] = [];
    lines.push((i + 1) + ') ' + shorten(p.name, MAX_NAME_SHOWN));
    if (p.league) lines.push(shorten(p.league, MAX_LEAGUE_SHOWN));
    lines.push(p.kind === 'over25' ? 'Over 2.5' : 'Over 1.5');
    lines.push('Expected goals ' + hundredthsText(p.sum4) + ' · strongest side ' + hundredthsText(p.strongest2));
    let block = lines.join('\n');
    if (i === 0) {
      block =
        'ROLL OVER MATCHES (outside the 2+ pool, Over 2.5 first, then Over 1.5, best first)\n' +
        'Over 2.5: both formulas total 5 or more, strongest side 2.4 or more.\n' +
        'Over 1.5: both formulas 2:1, 1:2, 3:1 or 1:3 (any mix), expected goals 3.2 or more.\n\n' +
        block;
    }
    blocks.push(block);
  }
  
  const chunks: string[] = [];
  let current = '';
  for (let i = 0; i < blocks.length; i++) {
    const add = (current ? '\n\n' : '') + blocks[i];
    if (current && current.length + add.length > MAX_MESSAGE_CHARS) {
      chunks.push(current);
      current = blocks[i];
    } else {
      current += add;
    }
  }
  if (current) chunks.push(current);
  
  const last = chunks[chunks.length - 1];
  if (last.length + 2 + footer.length <= MAX_MESSAGE_CHARS) {
    chunks[chunks.length - 1] = last + '\n\n' + footer;
  } else {
    chunks.push(footer);
  }
  return chunks;
}
