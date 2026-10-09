// ═══════════════════════════════════════════════════════════════
// CONFIDENCE — the matches in the storage that fit three strict rules.
// Pure functions, no DB / Telegram imports. Only ./correctScore.
//
// Each stored match gets calibrated scores from both formulas
// (prod = Formula 1, exp = Formula 2; 5 means "5+"). EVERY condition
// below must hold in BOTH formulas:
//
//   Under 3.5     : both formulas give 0:0
//   Over 2.5      : both formulas give both teams 2 or more
//   Double Chance : both formulas give 3:0 or better  -> 1X
//                   both formulas give 0:3 or better  -> X2
//
// The three rules cannot overlap, so a match has at most one pick.
//
// HIGH CONFIDENCE (a section inside the Over 2.5 group). With the four
// averages a1 (home scored), a2 (home conceded), b1 (away scored),
// b2 (away conceded):
//   expected goals home  eH = (a1 + b2) / 2
//   expected goals away  eA = (b1 + a2) / 2
//   total = eH + eA = (a1 + a2 + b1 + b2) / 2     weaker side = min(eH, eA)
//   total >= 3.8        -> high-confidence Over 2.5
//   weaker side >= 1.8  -> high-confidence BTTS Yes
//   both                -> BTTS Yes + Over 2.5 candidate
// All comparisons are exact (decimal strings scaled to integers).
//
// No percentage is calculated. The storage is only read, never changed.
// ═══════════════════════════════════════════════════════════════

import { calibratedScores, TRAINING_ROWS } from './correctScore';

// ── Types ─────────────────────────────────────────────────────────────────
export type ConfidenceRow = {
  name: string;
  data_line: string;
  league: string | null;
};

export type ConfidenceKind = 'under35' | 'over25' | 'double_home' | 'double_away';

export type HighKind = 'both' | 'total' | 'weaker';

export type ConfidencePick = {
  name: string;
  league: string | null;
  kind: ConfidenceKind;
  high: HighKind | null; // only for the Over 2.5 group
  highOver35: boolean; // Over 2.5 group and total expected goals >= 4.0
  sum4: bigint; // a1 + a2 + b1 + b2, scaled by 10^9
  weaker2: bigint; // min(a1 + b2, b1 + a2), scaled by 10^9
};

export type ConfidencePlan = {
  stored: number;
  picks: ConfidencePick[];
  noCallCount: number;
  unreadable: string[];
};

type Pair = { home: number; away: number };

const MAX_NAME_SHOWN = 60;
const MAX_LEAGUE_SHOWN = 60;
const MAX_MESSAGE_CHARS = 3500;

// Measured on the TRAINING_ROWS past matches (the cut points were fitted on
// the same matches, so new matches may do worse). Update these if the
// calibration is ever refreshed.
const PAST_UNDER35 = { percent: 81, matches: 123 };
const PAST_OVER25 = { percent: 72, matches: 293 };
const PAST_DOUBLE = { percent: 85, matches: 137 };
const PAST_HIGH_TOTAL = { percent: 76, matches: 135 };
const PAST_HIGH_WEAKER = { percent: 79, matches: 109 };
const PAST_HIGH_BOTH = { percent: 66, matches: 91 };

// Exact decimal helpers: a plain decimal string becomes an integer scaled by
// 10^9 (no BigInt literals, so it compiles on any TS target).
let SCALE = BigInt(1);
for (let i = 0; i < 9; i++) SCALE = SCALE * BigInt(10);
const HIGH_TOTAL_SUM = BigInt(76) * (SCALE / BigInt(10)); // 7.6 = total 3.8
const HIGH_WEAKER_SUM = BigInt(36) * (SCALE / BigInt(10)); // 3.6 = weaker side 1.8
const OVER35_SUM = BigInt(80) * (SCALE / BigInt(10)); // 8.0 = total 4.0
const TWO = BigInt(2);
const ZERO_BIG = BigInt(0);
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

// hundredths of a goal, rounded DOWN, from a scaled sum of two or four averages / 2
function hundredthsText(sumScaled: bigint): string {
  const h = (sumScaled * HUNDRED) / (TWO * SCALE);
  const whole = h / HUNDRED;
  const frac = (h % HUNDRED).toString();
  return whole.toString() + '.' + (frac.length < 2 ? '0' + frac : frac);
}

// ── The rules (pure, testable over every score pair) ──────────────────────
export function confidenceKind(p: Pair, e: Pair): ConfidenceKind | null {
  function both(test: (h: number, a: number) => boolean): boolean {
    return test(p.home, p.away) && test(e.home, e.away);
  }
  if (both(function (h, a) { return h === 0 && a === 0; })) return 'under35';
  if (both(function (h, a) { return h >= 2 && a >= 2; })) return 'over25';
  if (both(function (h, a) { return a === 0 && h >= 3; })) return 'double_home';
  if (both(function (h, a) { return h === 0 && a >= 3; })) return 'double_away';
  return null;
}

function shorten(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 3).trim() + '...';
}

// Stored data lines have 4 values (a1,a2,b1,b2) or 6 (form,form,a1,a2,b1,b2).
function kindForRow(
  row: ConfidenceRow
): { ok: boolean; kind: ConfidenceKind | null; nums: string[] } {
  const parts = row.data_line.split(',').map(function (s) { return s.trim(); });
  let nums: string[];
  if (parts.length === 4) nums = parts;
  else if (parts.length === 6) nums = parts.slice(2);
  else return { ok: false, kind: null, nums: [] };

  const cs = calibratedScores(nums[0], nums[1], nums[2], nums[3]);
  if (!cs) return { ok: false, kind: null, nums: [] };
  return { ok: true, kind: confidenceKind(cs.prod, cs.exp), nums: nums };
}

// ── The plan ──────────────────────────────────────────────────────────────
export function planConfidence(rows: ConfidenceRow[]): ConfidencePlan {
  const picks: ConfidencePick[] = [];
  const unreadable: string[] = [];
  let noCallCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = kindForRow(rows[i]);
    if (!r.ok) {
      unreadable.push(rows[i].name);
    } else if (r.kind === null) {
      noCallCount++;
    } else {
      let high: HighKind | null = null;
      let highOver35 = false;
      let sum4 = ZERO_BIG;
      let weaker2 = ZERO_BIG;
      const a1 = toScaled(r.nums[0]);
      const a2 = toScaled(r.nums[1]);
      const b1 = toScaled(r.nums[2]);
      const b2 = toScaled(r.nums[3]);
      if (a1 !== null && a2 !== null && b1 !== null && b2 !== null) {
        sum4 = a1 + a2 + b1 + b2;
        const homeSide = a1 + b2;
        const awaySide = b1 + a2;
        weaker2 = homeSide < awaySide ? homeSide : awaySide;
        if (r.kind === 'over25') {
          const t = sum4 >= HIGH_TOTAL_SUM;
          const w = weaker2 >= HIGH_WEAKER_SUM;
          high = t && w ? 'both' : t ? 'total' : w ? 'weaker' : null;
          highOver35 = sum4 >= OVER35_SUM;
        }
      }
      picks.push({
        name: rows[i].name,
        league: rows[i].league,
        kind: r.kind,
        high: high,
        highOver35: highOver35,
        sum4: sum4,
        weaker2: weaker2,
      });
    }
  }

  return { stored: rows.length, picks: picks, noCallCount: noCallCount, unreadable: unreadable };
}

// ── Output ────────────────────────────────────────────────────────────────
function entryText(n: number, pick: ConfidencePick): string {
  const lines: string[] = [];
  lines.push(n + ') ' + shorten(pick.name, MAX_NAME_SHOWN));
  if (pick.league) lines.push(shorten(pick.league, MAX_LEAGUE_SHOWN));
  if (pick.kind === 'double_home') lines.push('1X');
  if (pick.kind === 'double_away') lines.push('X2');
  return lines.join('\n');
}

function footerText(plan: ConfidencePlan): string {
  let under = 0;
  let over = 0;
  let dh = 0;
  let da = 0;
  for (let i = 0; i < plan.picks.length; i++) {
    const k = plan.picks[i].kind;
    if (k === 'under35') under++;
    else if (k === 'over25') over++;
    else if (k === 'double_home') dh++;
    else da++;
  }

  const lines: string[] = [];
  lines.push(
    plan.picks.length + ' of ' + plan.stored + ' stored matches qualify: ' +
      under + ' Under 3.5, ' + over + ' Over 2.5, ' + (dh + da) +
      ' Double Chance (' + dh + ' 1X, ' + da + ' X2).'
  );
  if (plan.noCallCount > 0) {
    lines.push(plan.noCallCount + ' stored match' + (plan.noCallCount === 1 ? '' : 'es') + ' did not fit any of the three rules.');
  }
  if (plan.unreadable.length > 0) {
    lines.push('Could not be read: ' + plan.unreadable.join('; ') + '.');
  }
  let hBoth = 0;
  let hTotal = 0;
  let hWeaker = 0;
  for (let i = 0; i < plan.picks.length; i++) {
    const hk = plan.picks[i].high;
    if (hk === 'both') hBoth++;
    else if (hk === 'total') hTotal++;
    else if (hk === 'weaker') hWeaker++;
  }
  if (hBoth + hTotal + hWeaker > 0) {
    lines.push(
      'High confidence: ' + hBoth + ' BTTS Yes + Over 2.5, ' + hTotal + ' Over 2.5, ' +
        hWeaker + ' BTTS Yes. In ' + TRAINING_ROWS + ' past matches, total 3.8 or more won Over 2.5 about ' +
        PAST_HIGH_TOTAL.percent + '% (' + PAST_HIGH_TOTAL.matches + ' matches), weaker side 1.8 or more won BTTS Yes about ' +
        PAST_HIGH_WEAKER.percent + '% (' + PAST_HIGH_WEAKER.matches + '), both won BTTS Yes + Over 2.5 about ' +
        PAST_HIGH_BOTH.percent + '% (' + PAST_HIGH_BOTH.matches + ').'
    );
  }
  lines.push(
    'In ' + TRAINING_ROWS + ' past matches these rules hit: Under 3.5 about ' + PAST_UNDER35.percent +
      '% (' + PAST_UNDER35.matches + ' matches), Over 2.5 about ' + PAST_OVER25.percent +
      '% (' + PAST_OVER25.matches + '), Double Chance about ' + PAST_DOUBLE.percent +
      '% (' + PAST_DOUBLE.matches + '). The cut points were fitted on those same matches, so new matches may do worse. No result is recorded.'
  );
  return lines.join('\n');
}

// Returns the messages to send (each under about 3,500 characters). The
// storage is not touched.
export function formatConfidence(plan: ConfidencePlan): string[] {
  const sections: { title: string; kinds: ConfidenceKind[] }[] = [
    { title: 'UNDER 3.5 (both formulas 0:0)', kinds: ['under35'] },
    { title: 'OVER 2.5 (both formulas: both teams 2 or more)', kinds: ['over25'] },
    {
      title: 'DOUBLE CHANCE (both formulas 3:0 or better, or 0:3 or better)',
      kinds: ['double_home', 'double_away'],
    },
  ];

  const footer = footerText(plan);

  if (plan.picks.length === 0) {
    return ['No stored match fits the three Confidence rules.\n\n' + footer];
  }

  // blocks: a section title is glued to its first entry
  const blocks: string[] = [];
  let first = true;
  for (let s = 0; s < sections.length; s++) {
    let n = 0;
    let titleNeeded = true;
    for (let i = 0; i < plan.picks.length; i++) {
      const pick = plan.picks[i];
      if (sections[s].kinds.indexOf(pick.kind) === -1) continue;
      n++;
      let block = entryText(n, pick);
      if (titleNeeded) {
        block = (first ? 'CONFIDENCE\n\n' : '') + sections[s].title + '\n\n' + block;
        titleNeeded = false;
        first = false;
      }
      blocks.push(block);
    }
  }

  // HIGH CONFIDENCE section (taken from the Over 2.5 group)
  const high: { pick: ConfidencePick; idx: number }[] = [];
  for (let i = 0; i < plan.picks.length; i++) {
    if (plan.picks[i].high !== null) high.push({ pick: plan.picks[i], idx: i });
  }
  function groupRank(h: HighKind | null): number {
    return h === 'both' ? 0 : h === 'total' ? 1 : 2;
  }
  high.sort(function (x, y) {
    const gx = groupRank(x.pick.high);
    const gy = groupRank(y.pick.high);
    if (gx !== gy) return gx - gy;
    const kx = gx === 2 ? x.pick.weaker2 : x.pick.sum4;
    const ky = gx === 2 ? y.pick.weaker2 : y.pick.sum4;
    if (kx !== ky) return kx < ky ? 1 : -1;
    return x.idx - y.idx;
  });
  for (let i = 0; i < high.length; i++) {
    const p = high[i].pick;
    const lines: string[] = [];
    lines.push((i + 1) + ') ' + shorten(p.name, MAX_NAME_SHOWN));
    if (p.league) lines.push(shorten(p.league, MAX_LEAGUE_SHOWN));
    lines.push(
      p.high === 'both' ? 'BTTS Yes + Over 2.5' : p.high === 'total' ? 'Over 2.5' : 'BTTS Yes'
    );
    lines.push('Expected goals ' + hundredthsText(p.sum4) + ' · weaker side ' + hundredthsText(p.weaker2));
    let block = lines.join('\n');
    if (i === 0) {
      block =
        'HIGH CONFIDENCE (from the Over 2.5 group, best first)\n' +
        'Over 2.5: expected goals 3.8 or more. BTTS Yes: weaker side 1.8 or more. Both: BTTS Yes + Over 2.5.\n\n' +
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

  // footer goes in the last message if it fits, otherwise in its own message
  const last = chunks[chunks.length - 1];
  if (last.length + 2 + footer.length <= MAX_MESSAGE_CHARS) {
    chunks[chunks.length - 1] = last + '\n\n' + footer;
  } else {
    chunks.push(footer);
  }
  return chunks;
}
