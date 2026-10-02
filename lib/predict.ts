// ═══════════════════════════════════════════════════════════════
// PREDICT — light rule-based picker: Home / Draw / Away + Over 2.5.
// Pure functions, no DB / Telegram imports.
//
// Input per match (form is ignored for now):
//   N) [HH:MM] Home - Away
//   [form,form,]a1,a2,b1,b2
//   a1 = Home scored avg   a2 = Home concede avg
//   b1 = Away scored avg   b2 = Away concede avg
//
// RULE 1 — Home / Draw / Away (owner-defined):
//   X1 = a1 / b1        X2 = b2        X = X1 + X2
//   Y1 = b1 / b2        Y2 = a2        Y = Y1 + Y2
//   R  = X / Y
//   R >= 2                      -> Home
//   R <= 0.5                    -> Away
//   1.09375 <= R <= 1.40625     -> Draw   (35/32 .. 45/32, inclusive)
//   otherwise                   -> no pick
//   Needs b1 > 0 and b2 > 0 (it divides by them).
//
// CONFIDENCE of a Home / Draw / Away call:
//   The rule above decides the pick. The confidence is the model chance
//   of that same result, with home goals ~ Poisson(eH) and away goals
//   ~ Poisson(eA), independent:
//     eH = (a1 + b2) / 2        eA = (b1 + a2) / 2
//   Home = P(home goals > away goals), Draw = P(equal),
//   Away = P(away goals > home goals).
//   No boost. A Draw is rarely the single most likely result, so Draw
//   calls always show a low percentage. This is a model estimate, not a
//   measured hit rate.
//
// RULE 2 — Over 2.5, main formula (owner-defined):
//   expectedHome = (a1 + b2) / 2        expectedAway = (b1 + a2) / 2
//   factorHome   = min(b2 / a1, 1)      factorAway   = min(a2 / b1, 1)
//   T1 = expectedHome * factorHome + expectedAway * factorAway
//   label "N+" with N = floor(T1);  N >= 3 (T1 >= 3)  ->  Over 2.5 call
//   Not checked when either team's scored average (a1 or b1) is below 1.
//
// CONFIDENCE of an Over 2.5 call (owner chose option A):
//   chance = P(total goals >= 3) when total ~ Poisson(T1)
//          = 1 - e^(-T1) * (1 + T1 + T1^2 / 2)
//   If the SECOND formula also reaches 3+ (T2 >= 3): confidence = chance * 1.25
//   Capped at 100%. Boosted values are ranking scores, not probabilities.
//
// RULE 2b — second formula (supporting layer, only its 3+ gate is used):
//   factorHome2 = min(a1 / b2, 1)       factorAway2 = min(b1 / a2, 1)
//   (a zero in the denominator counts as ratio 1)
//   T2 = expectedHome * factorHome2 + expectedAway * factorAway2
//   Each side's factor uses the same two averages as that side's
//   expected goals.
//
// Exact decimal arithmetic (BigInt fractions) is used for every
// comparison, so a match sitting exactly on a boundary (R = 2, 0.5,
// 1.09375, 1.40625, T1 = 3 or T2 = 3) is classified correctly and never
// misses it through floating-point error. The Poisson chances are
// normal floating-point numbers.
// No BigInt literals (1n) are used, so it compiles on any TS target.
// ═══════════════════════════════════════════════════════════════

export type PredictSide = 'Home' | 'Draw' | 'Away';

export type OutcomeCall = {
  num: number;
  name: string;
  side: PredictSide;
  confidence: number; // model chance of that result, 0..1
};

export type OverCall = {
  num: number;
  name: string;
  label: number; // N in "N+"
  total: number; // T1, adjusted expected total goals
  chance: number; // P(>= 3 goals), 0..1
  boosted: boolean; // second formula also reached 3+
  confidence: number; // chance x 1.25 if boosted, capped at 1
};

export type PredictSkip = { num: number; reason: string };

export type PredictResult = {
  checked: number; // matches that were readable and evaluated
  outcomes: OutcomeCall[]; // Home / Draw / Away calls, highest confidence first
  overs: OverCall[]; // Over 2.5 calls, highest confidence first
  skipped: PredictSkip[]; // unreadable matches
  noSide: number[]; // Home/Draw/Away could not be calculated (zero in b1 or b2)
  noOver: number[]; // Over 2.5 not checked (a team scores below 1)
};

export const BOOST = 1.25;

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
const qMul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const qDiv = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
const qInt = (x: number): Q => q(BigInt(x), ONE);
// compare a and b (denominators are always positive after q())
function qCmp(a: Q, b: Q): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}
function qMin(a: Q, b: Q): Q {
  return qCmp(a, b) <= 0 ? a : b;
}
function qToNumber(a: Q): number {
  return Number(a.n) / Number(a.d);
}
// floor for non-negative values
function qFloor(a: Q): number {
  return Number(a.n / a.d);
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
const THREE = qInt(3);
const HALF = q(ONE, BigInt(2));
const ONEQ = qInt(1);

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

// ── Rule 2: Over 2.5 ──────────────────────────────────────────────────────
// T1, main formula. Requires a1 > 0 and b1 > 0 (callers only use it when
// both are at least 1).
function goalsTotalExact(a1: Q, a2: Q, b1: Q, b2: Q): Q {
  const expectedHome = qDiv(qAdd(a1, b2), TWO);
  const expectedAway = qDiv(qAdd(b1, a2), TWO);
  const factorHome = qMin(qDiv(b2, a1), ONEQ);
  const factorAway = qMin(qDiv(a2, b1), ONEQ);
  return qAdd(qMul(expectedHome, factorHome), qMul(expectedAway, factorAway));
}

// T2, second formula. A zero denominator counts as ratio 1.
function goalsTotal2Exact(a1: Q, a2: Q, b1: Q, b2: Q): Q {
  const expectedHome = qDiv(qAdd(a1, b2), TWO);
  const expectedAway = qDiv(qAdd(b1, a2), TWO);
  const factorHome = b2.n === ZERO ? ONEQ : qMin(qDiv(a1, b2), ONEQ);
  const factorAway = a2.n === ZERO ? ONEQ : qMin(qDiv(b1, a2), ONEQ);
  return qAdd(qMul(expectedHome, factorHome), qMul(expectedAway, factorAway));
}

// P(total goals >= 3) for total ~ Poisson(t)
export function chanceOfThreePlus(t: number): number {
  const p = 1 - Math.exp(-t) * (1 + t + (t * t) / 2);
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

// T1 as a normal number, or null (unreadable, or a scored average below 1).
export function goalsTotal(a1: string, a2: string, b1: string, b2: string): number | null {
  const v = four(a1, a2, b1, b2);
  if (!v) return null;
  if (qCmp(v[0], ONEQ) < 0 || qCmp(v[2], ONEQ) < 0) return null;
  return qToNumber(goalsTotalExact(v[0], v[1], v[2], v[3]));
}

// T2 as a normal number, or null (same conditions as goalsTotal).
export function goalsTotal2(a1: string, a2: string, b1: string, b2: string): number | null {
  const v = four(a1, a2, b1, b2);
  if (!v) return null;
  if (qCmp(v[0], ONEQ) < 0 || qCmp(v[2], ONEQ) < 0) return null;
  return qToNumber(goalsTotal2Exact(v[0], v[1], v[2], v[3]));
}

export type OverEval = {
  label: number;
  total: number;
  chance: number;
  boosted: boolean;
  confidence: number;
};

export type Evaluation = {
  side: PredictSide | null; // Home / Draw / Away pick, if any
  sideChance: number | null; // model chance of that pick, 0..1
  sideSkipped: boolean; // true when R could not be calculated
  over: OverEval | null; // Over 2.5 call, if any
  overSkipped: boolean; // true when a team's scored average is below 1
};

// Runs both rules on one set of four numbers.
export function evaluate(
  a1: string,
  a2: string,
  b1: string,
  b2: string
): { ok: true; ev: Evaluation } | { ok: false; reason: string } {
  const v = four(a1, a2, b1, b2);
  if (!v) return { ok: false, reason: 'could not read the numbers' };
  const A1 = v[0];
  const A2 = v[1];
  const B1 = v[2];
  const B2 = v[3];

  const r = ratioExact(A1, A2, B1, B2);
  const side = r ? sideOf(r) : null;
  const sideSkipped = r === null;

  let sideChance: number | null = null;
  if (side) {
    const eH = qToNumber(qDiv(qAdd(A1, B2), TWO));
    const eA = qToNumber(qDiv(qAdd(B1, A2), TWO));
    const c = outcomeChances(eH, eA);
    sideChance = side === 'Home' ? c.home : side === 'Draw' ? c.draw : c.away;
  }

  const overSkipped = qCmp(A1, ONEQ) < 0 || qCmp(B1, ONEQ) < 0;
  let over: OverEval | null = null;
  if (!overSkipped) {
    const t1 = goalsTotalExact(A1, A2, B1, B2);
    if (qCmp(t1, THREE) >= 0) {
      const total = qToNumber(t1);
      const chance = chanceOfThreePlus(total);
      const boosted = qCmp(goalsTotal2Exact(A1, A2, B1, B2), THREE) >= 0;
      const raw = boosted ? chance * BOOST : chance;
      over = {
        label: qFloor(t1),
        total,
        chance,
        boosted,
        confidence: raw > 1 ? 1 : raw,
      };
    }
  }

  return { ok: true, ev: { side, sideChance, sideSkipped, over, overSkipped } };
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
    overs: [],
    skipped: [],
    noSide: [],
    noOver: [],
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
    if (e.ev.overSkipped) result.noOver.push(num);
    if (e.ev.side && e.ev.sideChance !== null) {
      result.outcomes.push({
        num,
        name,
        side: e.ev.side,
        confidence: e.ev.sideChance,
      });
    }
    if (e.ev.over) {
      result.overs.push({
        num,
        name,
        label: e.ev.over.label,
        total: e.ev.over.total,
        chance: e.ev.over.chance,
        boosted: e.ev.over.boosted,
        confidence: e.ev.over.confidence,
      });
    }
  }

  // Outcome calls: highest confidence first. Ties: lower match number first.
  result.outcomes.sort(function (a, b) {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.num - b.num;
  });

  // Over 2.5 calls: highest confidence first. Ties (e.g. several at the
  // 100% cap): higher expected total first, then the original match number.
  result.overs.sort(function (a, b) {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.total !== a.total) return b.total - a.total;
    return a.num - b.num;
  });
  return result;
}

// ── Output ────────────────────────────────────────────────────────────────
function numList(nums: number[]): string {
  return nums.map((n) => '#' + n).join(', ');
}

// Returns one or more message texts (each safely under Telegram's limit).
// Order: Outcome section first (highest confidence first), then Over 2.5
// (highest confidence first), then a short footer.
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
  r.overs.forEach(function (m) {
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
        count('Away') + ' Away, ' + r.overs.length + ' Over 2.5.'
    );
  }
  if (r.outcomes.length > 0) {
    footer.push(
      'Outcome % = model chance of that result (independent Poisson goals), an estimate, not a measured hit rate. Draws always score low.'
    );
  }
  if (r.overs.some((m) => m.boosted)) {
    footer.push(
      'Boosted = the second formula also reached 3+ goals (x1.25, capped at 100%). Boosted numbers are ranking scores, not probabilities.'
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
  if (r.noOver.length > 0) {
    footer.push(
      'Over 2.5 not checked (a team scores below 1 on average): ' + numList(r.noOver) + '.'
    );
  }

  // Body blocks: a section header is glued to its first entry so it is
  // never left alone at the end of a message.
  const blocks: string[] = [];
  r.outcomes.forEach(function (m, i) {
    const pct = Math.round(m.confidence * 100);
    const entry = m.num + ') ' + m.name + '\n' + m.side + ' · ' + pct + '%';
    blocks.push(i === 0 ? 'OUTCOME (highest confidence first)\n\n' + entry : entry);
  });
  r.overs.forEach(function (m, i) {
    const pct = Math.round(m.confidence * 100);
    const entry =
      m.num + ') ' + m.name + '\n' + m.label + '+ · ' + pct + '%' +
      (m.boosted ? ' (boosted)' : '');
    blocks.push(i === 0 ? 'OVER 2.5 (highest confidence first)\n\n' + entry : entry);
  });

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
