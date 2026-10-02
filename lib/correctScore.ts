// ═══════════════════════════════════════════════════════════════
// CORRECT SCORE — calibrated goal prediction from two formulas.
// Pure functions, no DB / Telegram imports.
//
// Inputs (four averages):
//   home scored, home conceded, away scored, away conceded
//
// Each formula turns a side's two averages (A, B) into a number s:
//   Home: A = home scored,  B = away conceded
//   Away: A = away scored,  B = home conceded
//
//   FORMULA 1 (prod):
//     big = max(A, B)   small = min(A, B)
//     r = 0.5 + 0.5 * (small / big)
//     weighted = 0.7 * big + 0.3 * small
//     s = weighted * r          (both inputs 0 -> s = 0)
//   FORMULA 2 (exp):
//     s = (A + B) / 2
//
// Each s is turned into a goal count with cut points T0..T4 that were
// precomputed from TRAINING_ROWS past matches (separately for home and
// away, separately for each formula):
//   goals = 0 if s <= T0,  1 if s <= T1,  2 if s <= T2,
//           3 if s <= T3,  4 if s <= T4,  otherwise 5 (meaning "5+")
// A value exactly on a cut point goes to the LOWER count.
//
// The cut points match the goal frequencies of the training matches by
// construction (in-sample). They are NOT a measured accuracy. The
// Formula 1 cut points are rounded to 4 decimals, so a match within
// 0.00005 of one could land in the neighbouring bucket compared with the
// calibration run. The Formula 2 cut points are exact.
//
// Exact decimal arithmetic (BigInt fractions) is used for s and for every
// comparison with a cut point, so a value sitting exactly on a cut point
// is classified correctly. No BigInt literals (1n), so it compiles on any
// TS target.
// To refresh the calibration later, replace the CUTS block and
// TRAINING_ROWS below. Nothing else needs to change.
// ═══════════════════════════════════════════════════════════════

export const TRAINING_ROWS = 1770;

const CUTS = {
  prod: {
    home: ['1.0489', '1.3560', '1.6030', '1.8336', '2.0765'],
    away: ['1.1613', '1.4788', '1.7541', '1.9909', '2.2425'],
  },
  exp: {
    home: ['1.1750', '1.5000', '1.7500', '2.0000', '2.2700'],
    away: ['1.2800', '1.6100', '1.9200', '2.1700', '2.4700'],
  },
};

// A predicted score for one formula. 5 means "5 or more".
export type CalibratedScore = { home: number; away: number };

export type CalibratedScores = {
  prod: CalibratedScore; // Formula 1
  exp: CalibratedScore; // Formula 2
};

export function goalsLabel(n: number): string {
  return n >= 5 ? '5+' : String(n);
}

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
// compare a and b (denominators are always positive after q())
function qCmp(a: Q, b: Q): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
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

const HALF = q(ONE, BigInt(2));
const SEVEN_TENTHS = q(BigInt(7), BigInt(10));
const THREE_TENTHS = q(BigInt(3), BigInt(10));

function cutsToQ(list: string[]): Q[] {
  return list.map(function (t) {
    const v = parseDecimal(t);
    if (!v) throw new Error('bad cut point: ' + t);
    return v;
  });
}

const CUTS_Q = {
  prod: { home: cutsToQ(CUTS.prod.home), away: cutsToQ(CUTS.prod.away) },
  exp: { home: cutsToQ(CUTS.exp.home), away: cutsToQ(CUTS.exp.away) },
};

// ── The two formulas ──────────────────────────────────────────────────────
function sProd(a: Q, b: Q): Q {
  const big = qCmp(a, b) >= 0 ? a : b;
  const small = qCmp(a, b) >= 0 ? b : a;
  if (big.n === ZERO) return q(ZERO, ONE);
  const weighted = qAdd(qMul(SEVEN_TENTHS, big), qMul(THREE_TENTHS, small));
  const r = qAdd(HALF, qMul(HALF, qDiv(small, big)));
  return qMul(weighted, r);
}

function sExp(a: Q, b: Q): Q {
  return qDiv(qAdd(a, b), q(BigInt(2), ONE));
}

function bucket(s: Q, cuts: Q[]): number {
  for (let i = 0; i < cuts.length; i++) {
    if (qCmp(s, cuts[i]) <= 0) return i;
  }
  return cuts.length; // 5 = "5+"
}

// ── Main entry ────────────────────────────────────────────────────────────
// Takes the four averages as text (the same strings Predict already uses).
// Returns null if any of them cannot be read.
export function calibratedScores(
  homeScored: string,
  homeConceded: string,
  awayScored: string,
  awayConceded: string
): CalibratedScores | null {
  const hs = parseDecimal(homeScored);
  const hc = parseDecimal(homeConceded);
  const aw = parseDecimal(awayScored);
  const ac = parseDecimal(awayConceded);
  if (!hs || !hc || !aw || !ac) return null;

  return {
    prod: {
      home: bucket(sProd(hs, ac), CUTS_Q.prod.home),
      away: bucket(sProd(aw, hc), CUTS_Q.prod.away),
    },
    exp: {
      home: bucket(sExp(hs, ac), CUTS_Q.exp.home),
      away: bucket(sExp(aw, hc), CUTS_Q.exp.away),
    },
  };
}
