// ═══════════════════════════════════════════════════════════════
// BEST OPTIONS (file name kept from the old "Pair Tickets").
// Pure functions, no DB / Telegram imports. Only ./confidence.
//
// NO TICKETS ARE CREATED HERE. It is a list: every match in the 2+ pool
// (both formulas give both teams 2 or more) that earns an option, with
// ONE option each.
//
// Options a pool match EARNS (a1 home scored, a2 home conceded,
// b1 away scored, b2 away conceded; eH = (a1+b2)/2, eA = (b1+a2)/2):
//   Over 2.5            : total (eH + eA) >= 3.8
//   BTTS Yes            : weaker side min(eH, eA) >= 1.8
//   BTTS Yes + Over 2.5 : both of the two rules above
//   Over 3.5            : total >= 4.0
//
// A match that earns several gets the HARDEST one it earned, in this
// order (PAIR_PRIORITY): Over 3.5, BTTS Yes + Over 2.5, Over 2.5, BTTS Yes.
// A match that earns nothing is not listed.
// All comparisons are exact. No percentages. The storage is only read.
// ═══════════════════════════════════════════════════════════════

import { planConfidence } from './confidence';
import type { ConfidencePick } from './confidence';
import { TRAINING_ROWS } from './correctScore';

// ── Types ─────────────────────────────────────────────────────────────────
export type PairRow = {
  name: string;
  data_line: string;
  league: string | null;
};

export type PairOption = 'over25' | 'btts' | 'combo' | 'over35';

export const PAIR_OPTION_LABEL: { [k: string]: string } = {
  over25: 'Over 2.5',
  btts: 'BTTS Yes',
  combo: 'BTTS Yes + Over 2.5',
  over35: 'Over 3.5',
};

// hardest first: the first one a match earned is the one it gets
export const PAIR_PRIORITY: PairOption[] = ['over35', 'combo', 'over25', 'btts'];

export type PairItem = {
  name: string;
  league: string | null;
  option: PairOption;
  sum4: bigint; // a1 + a2 + b1 + b2, scaled by 10^9
  weaker2: bigint; // min(a1 + b2, b1 + a2), scaled by 10^9
};

export type PairPlan = {
  stored: number;
  unreadable: string[];
  poolCount: number; // matches in the 2+ pool
  items: PairItem[]; // pool matches that earned an option (stored order)
  noOptionCount: number; // pool matches that earned nothing
};

const MAX_NAME_SHOWN = 60;
const MAX_LEAGUE_SHOWN = 60;
const MAX_MESSAGE_CHARS = 3500;

// Measured on the TRAINING_ROWS past matches (fitted on the same matches).
const PAST_BY_OPTION: { [k: string]: { percent: number; matches: number } } = {
  over35: { percent: 56, matches: 95 },
  combo: { percent: 64, matches: 25 },
  over25: { percent: 100, matches: 15 },
  btts: { percent: 72, matches: 18 },
};

// ── Exact decimal helper for the display ──────────────────────────────────
let SCALE = BigInt(1);
for (let i = 0; i < 9; i++) SCALE = SCALE * BigInt(10);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);

function hundredthsText(sumScaled: bigint): string {
  const h = (sumScaled * HUNDRED) / (TWO * SCALE);
  const whole = h / HUNDRED;
  const frac = (h % HUNDRED).toString();
  return whole.toString() + '.' + (frac.length < 2 ? '0' + frac : frac);
}

// ── Which options does a pool pick earn? (pure) ───────────────────────────
export function earnedOptions(pick: ConfidencePick): PairOption[] {
  const out: PairOption[] = [];
  if (pick.kind !== 'over25') return out;
  const t = pick.high === 'both' || pick.high === 'total';
  const w = pick.high === 'both' || pick.high === 'weaker';
  if (t) out.push('over25');
  if (w) out.push('btts');
  if (t && w) out.push('combo');
  if (pick.highOver35) out.push('over35');
  return out;
}

// The hardest earned option, or null
export function bestOption(earned: PairOption[]): PairOption | null {
  for (let i = 0; i < PAIR_PRIORITY.length; i++) {
    if (earned.indexOf(PAIR_PRIORITY[i]) !== -1) return PAIR_PRIORITY[i];
  }
  return null;
}

// ── The plan ──────────────────────────────────────────────────────────────
export function planPairs(rows: PairRow[]): PairPlan {
  const conf = planConfidence(rows);
  const items: PairItem[] = [];
  let poolCount = 0;
  let noOption = 0;

  for (let i = 0; i < conf.picks.length; i++) {
    const p = conf.picks[i];
    if (p.kind !== 'over25') continue;
    poolCount++;
    const option = bestOption(earnedOptions(p));
    if (option === null) noOption++;
    else items.push({ name: p.name, league: p.league, option: option, sum4: p.sum4, weaker2: p.weaker2 });
  }

  return {
    stored: rows.length,
    unreadable: conf.unreadable,
    poolCount: poolCount,
    items: items,
    noOptionCount: noOption,
  };
}

// ── Output ────────────────────────────────────────────────────────────────
function shorten(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 3).trim() + '...';
}

function footerText(plan: PairPlan): string {
  const counts: { [k: string]: number } = {};
  for (let i = 0; i < plan.items.length; i++) {
    const o = plan.items[i].option;
    counts[o] = (counts[o] || 0) + 1;
  }
  const parts: string[] = [];
  for (let i = 0; i < PAIR_PRIORITY.length; i++) {
    const n = counts[PAIR_PRIORITY[i]] || 0;
    if (n > 0) parts.push(n + ' ' + PAIR_OPTION_LABEL[PAIR_PRIORITY[i]]);
  }

  const lines: string[] = [];
  lines.push(
    plan.items.length + ' of ' + plan.poolCount + ' pool matches have an option' +
      (parts.length > 0 ? ': ' + parts.join(', ') : '') + '.'
  );
  if (plan.noOptionCount > 0) {
    lines.push(plan.noOptionCount + ' pool match' + (plan.noOptionCount === 1 ? '' : 'es') + ' earned no option and ' + (plan.noOptionCount === 1 ? 'is' : 'are') + ' not listed.');
  }
  if (plan.unreadable.length > 0) {
    lines.push('Could not be read: ' + plan.unreadable.join('; ') + '.');
  }
  const hist: string[] = [];
  for (let i = 0; i < PAIR_PRIORITY.length; i++) {
    const k = PAIR_PRIORITY[i];
    hist.push(PAIR_OPTION_LABEL[k] + ' about ' + PAST_BY_OPTION[k].percent + '% (' + PAST_BY_OPTION[k].matches + ' matches)');
  }
  lines.push(
    'In ' + TRAINING_ROWS + ' past matches, options set this way won: ' + hist.join(', ') +
      '. The cut points were fitted on those same matches, so new matches may do worse. No result is recorded.'
  );
  return lines.join('\n');
}

// The list, grouped by option (hardest first), highest expected goals first
// inside a group (BTTS Yes: highest weaker side first). Returns messages of
// at most about 3,500 characters. The storage is not touched.
export function formatPairList(plan: PairPlan): string[] {
  const footer = footerText(plan);
  if (plan.items.length === 0) {
    return [
      'No pool match earned an option.\n\nPool = both formulas give both teams 2 or more (' +
        plan.poolCount + ' stored).\n\n' + footer,
    ];
  }

  const titles: { [k: string]: string } = {
    over35: 'OVER 3.5 (expected goals 4.0 or more)',
    combo: 'BTTS YES + OVER 2.5 (expected goals 3.8 or more and weaker side 1.8 or more)',
    over25: 'OVER 2.5 (expected goals 3.8 or more)',
    btts: 'BTTS YES (weaker side 1.8 or more)',
  };

  const blocks: string[] = [];
  let n = 0;
  for (let g = 0; g < PAIR_PRIORITY.length; g++) {
    const option = PAIR_PRIORITY[g];
    const group: { item: PairItem; idx: number }[] = [];
    for (let i = 0; i < plan.items.length; i++) {
      if (plan.items[i].option === option) group.push({ item: plan.items[i], idx: i });
    }
    group.sort(function (x, y) {
      const kx = option === 'btts' ? x.item.weaker2 : x.item.sum4;
      const ky = option === 'btts' ? y.item.weaker2 : y.item.sum4;
      if (kx !== ky) return kx < ky ? 1 : -1;
      return x.idx - y.idx;
    });
    for (let k = 0; k < group.length; k++) {
      n++;
      const it = group[k].item;
      const lines: string[] = [];
      lines.push(n + ') ' + shorten(it.name, MAX_NAME_SHOWN));
      if (it.league) lines.push(shorten(it.league, MAX_LEAGUE_SHOWN));
      lines.push(PAIR_OPTION_LABEL[option]);
      lines.push('Expected goals ' + hundredthsText(it.sum4) + ' · weaker side ' + hundredthsText(it.weaker2));
      let block = lines.join('\n');
      if (k === 0) {
        block = (n === 1 ? 'BEST OPTIONS (pool matches, one option each, hardest earned first)\n\n' : '') + titles[option] + '\n\n' + block;
      }
      blocks.push(block);
    }
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
