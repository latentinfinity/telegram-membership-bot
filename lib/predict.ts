// ═══════════════════════════════════════════════════════════════
// PREDICT — light rule-based picker: Home / Draw / Away + Over 3.5 / 2.5.
// Pure functions, no DB / Telegram imports.
//
// Input per match (form is ignored for now):
//   N) [HH:MM] Home - Away
//   [form,form,]a1,a2,b1,b2
//   a1 = Home scored avg   a2 = Home concede avg
//   b1 = Away scored avg   b2 = Away concede avg
//
// Two scoring formulas (lib/correctScore.ts) each give a calibrated
// predicted score per match: Formula 1 (prod) and Formula 2 (exp).
// A "5" in a predicted score means "5 or more".
//
// RULE 1 — Home / Draw / Away rule (owner-defined, unchanged):
//   X1 = a1 / b1        X2 = b2        X = X1 + X2
//   Y1 = b1 / b2        Y2 = a2        Y = Y1 + Y2
//   R  = X / Y
//   R >= 2                      -> Home
//   R <= 0.5                    -> Away
//   1.09375 <= R <= 1.40625     -> Draw   (35/32 .. 45/32, inclusive)
//   otherwise                   -> no pick
//   Needs b1 > 0 and b2 > 0 (it divides by them).
//
// HOME call = Rule 1 says Home AND both formulas predict the away side
//   on 0 AND both predict home on 2 or more AND at least one of them
//   predicts home on 3 or more.  (2:0 + 2:0 is not accepted.)
// AWAY call = the mirror image.
// DRAW call = Rule 1 says Draw. Confidence is boosted when BOTH formulas
//   predict a draw (x1.25) and boosted more when BOTH predict 0:0 (x1.5).
//   A boost never creates a Draw call that Rule 1 did not make.
//   5+ : 5+ is not counted as a draw (it may not be one).
//
// CONFIDENCE of Home / Draw / Away: the model chance of that result with
//   home goals ~ Poisson(eH), away goals ~ Poisson(eA), independent:
//     eH = (a1 + b2) / 2        eA = (b1 + a2) / 2
//   Home = P(home > away), Draw = P(equal), Away = P(away > home).
//   Home and Away get no boost. Boosted Draw values are ranking scores,
//   not probabilities, and are capped at 100%.
//
// GOALS call: BOTH formulas predict a total of 4 or more with BOTH teams
//   scoring (so 4:0 never qualifies). It is "Over 3.5" when both formulas
//   have both teams on 2 or more, otherwise "Over 2.5".
//   Confidence: total goals ~ Poisson(eH + eA);
//     Over 2.5 = P(total >= 3),  Over 3.5 = P(total >= 4).
//   Estimates only.
//
// The score cut points come from past matches (in-sample). None of the
// percentages here is a measured hit rate.
//
// Exact decimal arithmetic (BigInt fractions) is used for every
// comparison, so a match sitting exactly on a boundary (R = 2, 0.5,
// 1.09375, 1.40625) is classified correctly. The Poisson chances are
// normal floating-point numbers.
// No BigInt literals (1n) are used, so it compiles on any TS target.
// ═══════════════════════════════════════════════════════════════

import { calibratedScores, TRAINING_ROWS } from './correctScore';

export type PredictSide = 'Home' | 'Draw' | 'Away';
export type GoalsLine = '3.5' | '2.5';

export type OutcomeCall = {
  num: number;
  name: string;
  side: PredictSide;
  confidence: number; // model chance (boosted for some Draws), 0..1
  boost: number; // 1 = none, 1.25 = both formulas draw, 1.5 = both 0:0
};

export type GoalsCall = {
  num: number;
  name: string;
  line: GoalsLine;
  total: number; // eH + eA, expected total goals
  confidence: number; // model chance of the line, 0..1
};

export type PredictSkip = { num: number; reason: string };

export type PredictResult = {
  checked: number; // matches that were readable and evaluated
  outcomes: OutcomeCall[]; // Home / Draw / Away calls, highest confidence first
  over35: GoalsCall[]; // Over 3.5 calls, highest confidence first
  over25: GoalsCall[]; // Over 2.5 calls, highest confidence first
  skipped: PredictSkip[]; // unreadable matches
  noSide: number[]; // Home/Draw/Away rule could not be calculated (zero in b1 or b2)
};

export const DRAW_BOOST = 1.25;
export const DRAW_BOOST_ZERO = 1.5;

export const PREDICT_USAGE =
  'Send matches like this (time and form are optional):\n' +
  '1) 20:45 Eastleigh - Southend\n' +
  'ldlwl,wdwwl,1.2,1.42,2.5,1.6\n' +
  '2) Tamworth - Sutton\n' +
  '1.7,2.8,1.42,1.5\n' +
  'The four numbers are: home scored, home conceded, away scored, away conceded (averages).';

// ── Exact rational arithmetic ─────────────────────────────────────────────
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
const qDiv = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
const qInt = (x: number): Q => q(BigInt(x), ONE);
// compare a and b (denominators are always positive after q())
function qCmp(a: Q, b: Q): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}
function qToNumber(a: Q): number {
  return Number(a.n) / Number(a.d);
}

// "1.42" -> 142/100. Only plain non-negative decimals are accepted.
function parseDecimal(text: string): Q | null {
  const t = text.trim();
  if (!/^\d{1,9}(\.\d{1,9})?$/.test(t)) return null;
  const dot = t.indexOf('.');
  if (dot === -1) return q(BigInt(t), ONE);
  const whole = t.slice(0, dot);
  const frac = t.slice(dot + 1);
  let scale = ONE;
  for (let i = 0; i < frac.length; i++) scale = scale * BigInt(10);
  return q(BigInt(whole + frac), scale);
}

// ── Rule 1: Home / Draw / Away ────────────────────────────────────────────
const BAND_LOW = q(BigInt(35), BigInt(32)); // 1.09375
const BAND_HIGH = q(BigInt(45), BigInt(32)); // 1.40625
const TWO = qInt(2);
const HALF = q(ONE, BigInt(2));

// R as an exact fraction, or null if it cannot be calculated
// (b1 = 0 makes X1 undefined; b2 = 0 makes Y1 undefined).
function ratioExact(a1: Q, a2: Q, b1: Q, b2: Q): Q | null {
  if (b1.n === ZERO || b2.n === ZERO) return null;
  const x = qAdd(qDiv(a1, b1), b2); // X1 + X2, X2 = raw opponent concede
  const y = qAdd(qDiv(b1, b2), a2); // Y1 + Y2, Y2 = raw opponent concede
  if (y.n === ZERO) return null;
  return qDiv(x, y);
}

function sideOf(r: Q): PredictSide | null {
  if (qCmp(r, TWO) >= 0) return 'Home';
  if (qCmp(r, HALF) <= 0) return 'Away';
  if (qCmp(r, BAND_LOW) >= 0 && qCmp(r, BAND_HIGH) <= 0) return 'Draw';
  return null;
}

// ── Outcome chances (Poisson, independent home and away goals) ────────────
// Up to EXACT_LIMIT expected goals per side the chances are summed exactly
// over the goal grid. Above that (absurd for football, only reachable by
// typing huge averages) a normal approximation of the goal difference is
// used, so the result is always a finite number between 0 and 1.
const EXACT_LIMIT = 200;

// Numerical Recipes erfc, fractional error below 1.2e-7 everywhere.
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? r : 2 - r;
}
function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

function poissonPmf(lambda: number): number[] {
  const kmax = Math.ceil(lambda + 12 * Math.sqrt(lambda) + 20);
  const p: number[] = [Math.exp(-lambda)];
  for (let k = 1; k <= kmax; k++) p.push((p[k - 1] * lambda) / k);
  return p;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function outcomeChances(
  eH: number,
  eA: number
): { home: number; draw: number; away: number } {
  if (eH > EXACT_LIMIT || eA > EXACT_LIMIT) {
    const mu = eH - eA;
    const sd = Math.sqrt(eH + eA);
    const homeP = 1 - normalCdf((0.5 - mu) / sd);
    const awayP = normalCdf((-0.5 - mu) / sd);
    return {
      home: clamp01(homeP),
      draw: clamp01(1 - homeP - awayP),
      away: clamp01(awayP),
    };
  }
  const ph = poissonPmf(eH);
  const pa = poissonPmf(eA);
  let cumA = 0; // P(away goals <= h - 1) at the start of each step
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let h = 0; h < ph.length; h++) {
    const pAh = h < pa.length ? pa[h] : 0;
    home += ph[h] * cumA;
    draw += ph[h] * pAh;
    cumA += pAh;
    away += ph[h] * (1 - cumA);
  }
  return { home: clamp01(home), draw: clamp01(draw), away: clamp01(away) };
}

// ── Goal-line chances: total goals ~ Poisson(t) ───────────────────────────
// P(total >= 3), the chance behind an Over 2.5 call
export function chanceOfThreePlus(t: number): number {
  const p = 1 - Math.exp(-t) * (1 + t + (t * t) / 2);
  return p < 0 ? 0 : p > 1 ? 1 : p;
}
// P(total >= 4), the chance behind an Over 3.5 call
export function chanceOfFourPlus(t: number): number {
  const p = 1 - Math.exp(-t) * (1 + t + (t * t) / 2 + (t * t * t) / 6);
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

// ── Exposed helpers (testing and future use) ──────────────────────────────
function four(a1: string, a2: string, b1: string, b2: string): Q[] | null {
  const A1 = parseDecimal(a1);
  const A2 = parseDecimal(a2);
  const B1 = parseDecimal(b1);
  const B2 = parseDecimal(b2);
  if (!A1 || !A2 || !B1 || !B2) return null;
  return [A1, A2, B1, B2];
}

// R as a normal number, or null.
export function ratio(a1: string, a2: string, b1: string, b2: string): number | null {
  const v = four(a1, a2, b1, b2);
  if (!v) return null;
  const r = ratioExact(v[0], v[1], v[2], v[3]);
  return r ? qToNumber(r) : null;
}

export type OutcomeEval = {
  side: PredictSide;
  confidence: number;
  boost: number;
};

export type GoalsEval = {
  line: GoalsLine;
  total: number;
  confidence: number;
};

export type Evaluation = {
  ruleSide: PredictSide | null; // what Rule 1 says, before the score check
  sideSkipped: boolean; // true when R could not be calculated
  outcome: OutcomeEval | null; // final Home / Draw / Away call, if any
  goals: GoalsEval | null; // final Over 3.5 / Over 2.5 call, if any
  prodScore: { home: number; away: number }; // Formula 1 predicted score
  expScore: { home: number; away: number }; // Formula 2 predicted score
};

// Runs every rule on one set of four numbers.
export function evaluate(
  a1: string,
  a2: string,
  b1: string,
  b2: string
): { ok: true; ev: Evaluation } | { ok: false; reason: string } {
  const v = four(a1, a2, b1, b2);
  const cs = calibratedScores(a1, a2, b1, b2);
  if (!v || !cs) return { ok: false, reason: 'could not read the numbers' };
  const A1 = v[0];
  const A2 = v[1];
  const B1 = v[2];
  const B2 = v[3];
  const p = cs.prod;
  const e = cs.exp;

  // Expected goals (the same numbers Formula 2 uses)
  const eH = qToNumber(qDiv(qAdd(A1, B2), TWO));
  const eA = qToNumber(qDiv(qAdd(B1, A2), TWO));

  // ── Home / Draw / Away ──
  const r = ratioExact(A1, A2, B1, B2);
  const ruleSide = r ? sideOf(r) : null;
  const sideSkipped = r === null;

  let outcome: OutcomeEval | null = null;
  if (ruleSide === 'Home') {
    const agree =
      p.away === 0 && e.away === 0 &&
      p.home >= 2 && e.home >= 2 &&
      (p.home >= 3 || e.home >= 3);
    if (agree) {
      outcome = { side: 'Home', confidence: outcomeChances(eH, eA).home, boost: 1 };
    }
  } else if (ruleSide === 'Away') {
    const agree =
      p.home === 0 && e.home === 0 &&
      p.away >= 2 && e.away >= 2 &&
      (p.away >= 3 || e.away >= 3);
    if (agree) {
      outcome = { side: 'Away', confidence: outcomeChances(eH, eA).away, boost: 1 };
    }
  } else if (ruleSide === 'Draw') {
    const base = outcomeChances(eH, eA).draw;
    const prodDraw = p.home === p.away && p.home < 5;
    const expDraw = e.home === e.away && e.home < 5;
    const bothZero = p.home === 0 && p.away === 0 && e.home === 0 && e.away === 0;
    const boost = bothZero ? DRAW_BOOST_ZERO : prodDraw && expDraw ? DRAW_BOOST : 1;
    const raw = base * boost;
    outcome = { side: 'Draw', confidence: raw > 1 ? 1 : raw, boost };
  }

  // ── Goals ──
  let goals: GoalsEval | null = null;
  const prodOk = p.home >= 1 && p.away >= 1 && p.home + p.away >= 4;
  const expOk = e.home >= 1 && e.away >= 1 && e.home + e.away >= 4;
  if (prodOk && expOk) {
    const total = eH + eA;
    const bothTwo = p.home >= 2 && p.away >= 2 && e.home >= 2 && e.away >= 2;
    goals = bothTwo
      ? { line: '3.5', total, confidence: chanceOfFourPlus(total) }
      : { line: '2.5', total, confidence: chanceOfThreePlus(total) };
  }

  return {
    ok: true,
    ev: {
      ruleSide,
      sideSkipped,
      outcome,
      goals,
      prodScore: { home: p.home, away: p.away },
      expScore: { home: e.home, away: e.away },
    },
  };
}

// ── Parsing ───────────────────────────────────────────────────────────────
// "20:45 Eastleigh - Southend" -> "Eastleigh - Southend"
function cleanName(raw: string): string {
  return raw
    .replace(/\*+$/, '')
    .trim()
    .replace(/^\d{1,2}:\d{2}\s+/, '')
    .trim();
}

// Returns the four averages (strings) or an error reason.
function readDataLine(
  line: string
): { ok: true; nums: string[] } | { ok: false; reason: string } {
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length !== 4 && parts.length !== 6) {
    return { ok: false, reason: 'expected 4 or 6 values separated by commas' };
  }
  // With 6 values the first two are the form strings: ignored for now.
  const nums = parts.length === 6 ? parts.slice(2) : parts;
  return { ok: true, nums };
}

export function runPrediction(text: string): PredictResult {
  const lines = text.split('\n').map((l) => l.trim());
  const result: PredictResult = {
    checked: 0,
    outcomes: [],
    over35: [],
    over25: [],
    skipped: [],
    noSide: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(\d+)\)\s*(.*)$/);
    if (!head) continue;
    const num = parseInt(head[1], 10);
    const name = cleanName(head[2]) || 'Match ' + num;

    let j = i + 1;
    while (j < lines.length && lines[j].length === 0) j++;
    if (j >= lines.length || /^\d+\)/.test(lines[j])) {
      result.skipped.push({ num, reason: 'no data line under it' });
      continue;
    }

    const data = readDataLine(lines[j]);
    i = j; // the data line is consumed either way
    if (!data.ok) {
      result.skipped.push({ num, reason: data.reason });
      continue;
    }

    const e = evaluate(data.nums[0], data.nums[1], data.nums[2], data.nums[3]);
    if (!e.ok) {
      result.skipped.push({ num, reason: e.reason });
      continue;
    }
    result.checked++;
    if (e.ev.sideSkipped) result.noSide.push(num);
    if (e.ev.outcome) {
      result.outcomes.push({
        num,
        name,
        side: e.ev.outcome.side,
        confidence: e.ev.outcome.confidence,
        boost: e.ev.outcome.boost,
      });
    }
    if (e.ev.goals) {
      const call: GoalsCall = {
        num,
        name,
        line: e.ev.goals.line,
        total: e.ev.goals.total,
        confidence: e.ev.goals.confidence,
      };
      if (call.line === '3.5') result.over35.push(call);
      else result.over25.push(call);
    }
  }

  // Outcome calls: highest confidence first. Ties: lower match number first.
  result.outcomes.sort(function (a, b) {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.num - b.num;
  });

  // Goals calls: highest confidence first. Ties: higher expected total
  // first, then the original match number.
  const byGoals = function (a: GoalsCall, b: GoalsCall): number {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.total !== a.total) return b.total - a.total;
    return a.num - b.num;
  };
  result.over35.sort(byGoals);
  result.over25.sort(byGoals);
  return result;
}

// ── Output ────────────────────────────────────────────────────────────────
function numList(nums: number[]): string {
  return nums.map((n) => '#' + n).join(', ');
}

// Returns one or more message texts (each safely under Telegram's limit).
// Order: Outcome section, Over 3.5, Over 2.5 (each highest confidence
// first), then a short footer.
export function formatPrediction(r: PredictResult): string[] {
  const total = r.checked + r.skipped.length;
  if (total === 0) {
    return ['No matches found.\n\n' + PREDICT_USAGE];
  }

  // Footer
  const footer: string[] = [];
  const called: Record<number, boolean> = {};
  r.outcomes.forEach(function (m) {
    called[m.num] = true;
  });
  r.over35.forEach(function (m) {
    called[m.num] = true;
  });
  r.over25.forEach(function (m) {
    called[m.num] = true;
  });
  let calledCount = 0;
  for (const k in called) {
    if (called[k]) calledCount++;
  }
  const count = (s: PredictSide) => r.outcomes.filter((m) => m.side === s).length;

  if (calledCount === 0) {
    footer.push('No match called (' + r.checked + ' checked).');
  } else {
    footer.push(
      calledCount + ' of ' + r.checked + ' matches called: ' +
        count('Home') + ' Home, ' + count('Draw') + ' Draw, ' +
        count('Away') + ' Away, ' + r.over35.length + ' Over 3.5, ' +
        r.over25.length + ' Over 2.5.'
    );
    footer.push(
      '% = model chance from expected goals (independent Poisson), an estimate, not a measured hit rate. Draws always score low. Score cut points come from ' +
        TRAINING_ROWS + ' past matches and their accuracy has not been measured.'
    );
  }
  if (r.outcomes.some((m) => m.boost > 1)) {
    footer.push(
      'Boosted Draw = both formulas predict a draw (x1.25) or both predict 0:0 (x1.5), capped at 100%. Boosted numbers are ranking scores, not probabilities.'
    );
  }
  if (r.skipped.length > 0) {
    footer.push(
      'Skipped: ' + r.skipped.map((s) => '#' + s.num + ' (' + s.reason + ')').join(', ') + '.'
    );
  }
  if (r.noSide.length > 0) {
    footer.push(
      'Home/Draw/Away not possible (away scored or conceded is 0): ' + numList(r.noSide) + '.'
    );
  }

  // Body blocks: a section header is glued to its first entry so it is
  // never left alone at the end of a message.
  const blocks: string[] = [];
  r.outcomes.forEach(function (m, i) {
    const pct = Math.round(m.confidence * 100);
    const entry =
      m.num + ') ' + m.name + '\n' + m.side + ' · ' + pct + '%' +
      (m.boost > 1 ? ' (boosted)' : '');
    blocks.push(i === 0 ? 'OUTCOME (highest confidence first)\n\n' + entry : entry);
  });
  const goalsBlocks = function (list: GoalsCall[], title: string) {
    list.forEach(function (m, i) {
      const pct = Math.round(m.confidence * 100);
      const entry = m.num + ') ' + m.name + '\n' + 'Over ' + m.line + ' · ' + pct + '%';
      blocks.push(i === 0 ? title + ' (highest confidence first)\n\n' + entry : entry);
    });
  };
  goalsBlocks(r.over35, 'OVER 3.5');
  goalsBlocks(r.over25, 'OVER 2.5');

  const chunks: string[] = [];
  let current = '';
  for (let i = 0; i < blocks.length; i++) {
    const add = (current ? '\n\n' : '') + blocks[i];
    if (current.length + add.length > 3500) {
      chunks.push(current);
      current = blocks[i];
    } else {
      current += add;
    }
  }
  if (current) chunks.push(current);

  const footerText = footer.join('\n');
  if (chunks.length === 0) return [footerText];
  const last = chunks[chunks.length - 1];
  if (last.length + footerText.length + 2 > 3900) {
    chunks.push(footerText);
  } else {
    chunks[chunks.length - 1] = last + '\n\n' + footerText;
  }
  return chunks;
}
