// ═══════════════════════════════════════════════════════════════
// PREDICT — light rule-based Home / Draw / Away picker.
// Pure functions, no DB / Telegram imports.
//
// Input per match (form is ignored for now):
//   N) [HH:MM] Home - Away
//   [form,form,]a1,a2,b1,b2
//   a1 = Home scored avg   a2 = Home concede avg
//   b1 = Away scored avg   b2 = Away concede avg
//
// RULE (owner-defined):
//   X1 = a1 / b1        X2 = (a1 + b2) / 2      X = X1 + X2
//   Y1 = b1 / b2        Y2 = (b1 + a2) / 2      Y = Y1 + Y2
//   R  = X / Y
//   R >= 2                      -> Home
//   R <= 0.5                    -> Away
//   1.09375 <= R <= 1.40625     -> Draw   (35/32 .. 45/32, inclusive)
//   otherwise                   -> no pick (not listed)
//
// Exact decimal arithmetic (BigInt fractions), so a match that sits
// exactly on 2, 0.5, 1.09375 or 1.40625 is classified correctly and
// never misses the boundary through floating-point error.
// No BigInt literals (1n) are used, so it compiles on any TS target.
// ═══════════════════════════════════════════════════════════════

export type PredictSide = 'Home' | 'Draw' | 'Away';

export type PredictRow = { num: number; name: string; side: PredictSide };

export type PredictSkip = { num: number; reason: string };

export type PredictResult = {
  checked: number; // matches that were readable and calculated
  qualified: PredictRow[];
  skipped: PredictSkip[];
};

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

// ── The rule ──────────────────────────────────────────────────────────────
const BAND_LOW = q(BigInt(35), BigInt(32)); // 1.09375
const BAND_HIGH = q(BigInt(45), BigInt(32)); // 1.40625
const TWO = qInt(2);
const HALF = q(ONE, BigInt(2));

// Returns R as an exact fraction, or null if it cannot be calculated
// (b1 = 0 makes X1 undefined; b2 = 0 makes Y1 undefined).
function ratioExact(a1: Q, a2: Q, b1: Q, b2: Q): Q | null {
  if (b1.n === ZERO || b2.n === ZERO) return null;
  const x = qAdd(qDiv(a1, b1), qDiv(qAdd(a1, b2), TWO));
  const y = qAdd(qDiv(b1, b2), qDiv(qAdd(b1, a2), TWO));
  if (y.n === ZERO) return null;
  return qDiv(x, y);
}

function sideOf(r: Q): PredictSide | null {
  if (qCmp(r, TWO) >= 0) return 'Home';
  if (qCmp(r, HALF) <= 0) return 'Away';
  if (qCmp(r, BAND_LOW) >= 0 && qCmp(r, BAND_HIGH) <= 0) return 'Draw';
  return null;
}

// Exposed for testing and future use: R as a normal number, or null.
export function ratio(a1: string, a2: string, b1: string, b2: string): number | null {
  const A1 = parseDecimal(a1);
  const A2 = parseDecimal(a2);
  const B1 = parseDecimal(b1);
  const B2 = parseDecimal(b2);
  if (!A1 || !A2 || !B1 || !B2) return null;
  const r = ratioExact(A1, A2, B1, B2);
  if (!r) return null;
  return Number(r.n) / Number(r.d);
}

// Classification of one set of four numbers.
export function classify(
  a1: string,
  a2: string,
  b1: string,
  b2: string
):
  | { ok: true; side: PredictSide | null }
  | { ok: false; reason: string } {
  const A1 = parseDecimal(a1);
  const A2 = parseDecimal(a2);
  const B1 = parseDecimal(b1);
  const B2 = parseDecimal(b2);
  if (!A1 || !A2 || !B1 || !B2) return { ok: false, reason: 'could not read the numbers' };
  if (B1.n === ZERO) return { ok: false, reason: 'away scored is 0 (cannot divide)' };
  if (B2.n === ZERO) return { ok: false, reason: 'away conceded is 0 (cannot divide)' };
  const r = ratioExact(A1, A2, B1, B2);
  if (!r) return { ok: false, reason: 'cannot calculate' };
  return { ok: true, side: sideOf(r) };
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
  const result: PredictResult = { checked: 0, qualified: [], skipped: [] };

  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(\d+)\)\s*(.*)$/);
    if (!head) continue;
    const num = parseInt(head[1], 10);
    const name = cleanName(head[2]);

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

    const c = classify(data.nums[0], data.nums[1], data.nums[2], data.nums[3]);
    if (!c.ok) {
      result.skipped.push({ num, reason: c.reason });
      continue;
    }
    result.checked++;
    if (c.side) result.qualified.push({ num, name: name || 'Match ' + num, side: c.side });
  }
  return result;
}

// ── Output ────────────────────────────────────────────────────────────────
// Returns one or more message texts (each safely under Telegram's limit).
export function formatPrediction(r: PredictResult): string[] {
  const footer: string[] = [];
  const total = r.checked + r.skipped.length;

  if (total === 0) {
    return ['No matches found.\n\n' + PREDICT_USAGE];
  }

  if (r.qualified.length === 0) {
    footer.push('No match qualified (' + r.checked + ' checked).');
  } else {
    const home = r.qualified.filter((m) => m.side === 'Home').length;
    const draw = r.qualified.filter((m) => m.side === 'Draw').length;
    const away = r.qualified.filter((m) => m.side === 'Away').length;
    footer.push(
      r.qualified.length + ' of ' + r.checked + ' matches qualified: ' +
        home + ' Home, ' + draw + ' Draw, ' + away + ' Away.'
    );
  }
  if (r.skipped.length > 0) {
    footer.push(
      'Skipped: ' + r.skipped.map((s) => '#' + s.num + ' (' + s.reason + ')').join(', ') + '.'
    );
  }

  const entries = r.qualified.map((m) => m.num + ') ' + m.name + '\n' + m.side);
  const chunks: string[] = [];
  let current = '';
  for (let i = 0; i < entries.length; i++) {
    const add = (current ? '\n\n' : '') + entries[i];
    if (current.length + add.length > 3500) {
      chunks.push(current);
      current = entries[i];
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
