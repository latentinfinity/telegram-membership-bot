// lib/fd/ranking.ts  (REPLACES the earlier version) - Rankings. Read only. Private chat only.
// Home point = ((hs / (1 + hc)) * ac) / (1 + as)
// Away point = ((as / (1 + ac)) * hc) / (1 + hs)
// Every side gets its own point; sides go in ONE list, highest first.
//   Only the top N sides are shown, where N = the number of matches (20 matches -> top N).
// SUPPORTING FORMULA: X = hs/hc + ac/as (Home), Y = as/ac + hc/hs (Away), D2 = |X - Y|.
//   If hs, hc, as or ac is 0 there is no supporting result (no tick, tag shows "-").
//   Exact integer maths (X = N/(hc*as), Y = N/(ac*hs), N = hs*as + ac*hc).
// RX 2+ section (after the main list, before DRAW): Home rx = Home point / Away point,
//   Away rx = Away point / Home point. A side qualifies when its rx is 2 or more
//   (exact integer maths). If the opposing point is 0 the side is eliminated.
//   A side gets a check mark when D2 >= 3 (3 included).
//   A side gets a star when its own X:Y number (score 2 x average scored, rounded half up)
//   is bigger than its opponent's. A tie gets no star.
//   A side gets a heart only when its T (TRUST, below) is 60 or more (60 included).
//   The heart rate no longer decides the heart.
//   TRUST (T): every RX 2+ side that has a heart rate (see HEART FORMULA) shows T in brackets,
//   and the heart when T is 60 or more. a = rx, b = heart rate, a >= 0, b >= 0, a + b > 0:
//   D = |a - b| / (a + b), T = 100 * D (0 to 100).
//   A side with no heart result (a zero average) shows no T and no heart.
// HEART FORMULA (one single formula, exact integer maths, averages in hundredths):
//   Home = 1/((27/40)*hc) + (9/40)*ac + 1/((3/40)*as) + (1/40)*hs
//   Away = 1/((27/40)*ac) + (9/40)*hc + 1/((3/40)*hs) + (1/40)*as
//   The predicted side is the RX side. Home side: rate = Home / Away. Away side: rate = Away / Home.
//   The rate is the b value used by T. If hs, hc, as or ac is 0 there is no result.
// DRAW section (football only): a match qualifies when |Home point - Away point| (main D) is
//   between 0.0 and 0.2, both ends included (exact integer maths). Closest first. A match gets
//   a tick only when BOTH the main D and D2 are between 0 and 0.2 (included). Each match shows
//   the tag (main stronger, supporting stronger), e.g. (Home, Away).
// SCORE 2 = min(hs,ac)/(1+max(hs,ac)) + min(as,hc)/(1+max(as,hc)). Its home part and away part
//   give X:Y: X = home part * hs, Y = away part * as, each rounded half up (0.5 up).
// f = Score 2 * total scored (t = hs + as), rounded to 2 decimals.
// NEW SCORE = Home + Away, Home = (1/4)*max(hs,ac) + (3/4)*min(hs,ac),
//   Away = (1/4)*max(as,hc) + (3/4)*min(as,hc).
// P = 100 * sqrt(A*B) / (1 + sqrt(A*B)), A = f (2 decimals), B = NEW SCORE.
// h = f * g, g = smaller conceded / bigger conceded (home conceded vs away conceded; both 0 = no g),
//   h rounded to 2 decimals (hHundredths).
// FOOTBALL OVER RANKING (main list): every match with f of 2.00 or more, ranked by f, highest first.
//   The brackets are (f)(P), P with 1 decimal. Matches with f below 2.00 are removed.
//   A match gets a star when: f from 3.00 to 3.99 and P 80 or more, or f from 4.00 to 4.99 and
//   P 80 or more, or f 5.00 or more and P 83 or more (83 included). One star at most.
// BASKETBALL main list: every match, highest Score (X + Y) first. Bracket number: Score - 10, floored.
// There are no top 10 lists any more.
// FOOTBALL h LIST (after the main list): matches with f 3.00 or more and h 3.00 or more.
//   Ranked by h, highest first (descending). The number in brackets is h.
// BASKETBALL h LIST (after the basketball main list): ALL matches (no 3+ cut), ranked by h,
//   highest first. A match with both conceded averages 0 has no g and is left out.
// BASKETBALL (pasted matches only): the word Basketball on the first line of the paste marks
//   every match in it as basketball (the stored league starts with "Basketball"). Basketball
//   gets the same WIN ranking and RX 2+ (with the D2 tick, the X:Y star and the heart), NO Draw,
//   and its Over lists.
// Part 1: one competition's stored pending matches (fd_fixtures). Football only.
// Part 2: the matches pasted into the storage (one list across all leagues).
// Exported for lib/fd/track.ts and lib/fd/scoreXY.ts: isDraw, rxQualifies, overRate, the score
// functions, fHundredths, hHundredths, heartRates and score2Xy.
import { createAdminClient } from '@/lib/supabase/admin';

const LIMIT = 3500;

export function homePoint(hs: number, hc: number, as: number, ac: number): number {
  return ((hs / (1 + hc)) * ac) / (1 + as);
}

export function awayPoint(hs: number, hc: number, as: number, ac: number): number {
  return ((as / (1 + ac)) * hc) / (1 + hs);
}

// Score S = X + Y, X = 2*hs*ac/(hs+ac), Y = 2*as*hc/(as+hc). A zero denominator gives 0.
export function overScore(hs: number, hc: number, as: number, ac: number): number {
  const x = hs + ac > 0 ? (2 * hs * ac) / (hs + ac) : 0;
  const y = as + hc > 0 ? (2 * as * hc) / (as + hc) : 0;
  return x + y;
}

// Score 2 = min(hs,ac)/(1+max(hs,ac)) + min(as,hc)/(1+max(as,hc)).
export function overScore2(hs: number, hc: number, as: number, ac: number): number {
  return Math.min(hs, ac) / (1 + Math.max(hs, ac)) + Math.min(as, hc) / (1 + Math.max(as, hc));
}

// f = Score 2 * total scored, in hundredths (rounded to 2 decimals as shown).
export function fHundredths(hs: number, hc: number, as: number, ac: number): number {
  return Math.round(overScore2(hs, hc, as, ac) * (hs + as) * 100);
}

// h = f * g in hundredths, rounded half up, where g = smaller conceded / bigger conceded.
// fH = f in hundredths; hcH and acH = the conceded averages in hundredths.
// null when both conceded averages are 0 (no g). Exact integer maths.
export function hHundredths(fH: number, hcH: number, acH: number): number | null {
  const big = Math.max(hcH, acH);
  const small = Math.min(hcH, acH);
  if (big <= 0) return null;
  return Math.floor((2 * fH * small + big) / (2 * big));
}

// NEW SCORE for P: Home + Away, each = (1/4)*max + (3/4)*min.
export function newScore(hs: number, hc: number, as: number, ac: number): number {
  const home = 0.25 * Math.max(hs, ac) + 0.75 * Math.min(hs, ac);
  const away = 0.25 * Math.max(as, hc) + 0.75 * Math.min(as, hc);
  return home + away;
}

// P = 100 * sqrt(A*B) / (1 + sqrt(A*B)). null when A*B is not usable.
export function pValue(a: number, b: number): number | null {
  const ab = a * b;
  if (!isFinite(ab) || ab < 0) return null;
  const s = Math.sqrt(ab);
  const p = (100 * s) / (1 + s);
  return isFinite(p) ? p : null;
}

// Star for the football main list. fH = f in hundredths.
//   f 3.00 to 4.99 and P 80+, or f 5.00+ and P 83+ (both included).
function overStar(fH: number, p: number | null): boolean {
  if (p === null) return false;
  if (fH >= 300 && fH <= 499) return p >= 80;
  if (fH >= 500) return p >= 83;
  return false;
}

// HEART FORMULA. Averages in hundredths, exact integer maths.
//   Home = 1/((27/40)*hc) + (9/40)*ac + 1/((3/40)*as) + (1/40)*hs
//   Away = 1/((27/40)*ac) + (9/40)*hc + 1/((3/40)*hs) + (1/40)*as
// With every average in hundredths the Home value is nh/dh and the Away value is na/da:
//   nh = 48,000,000*as + 729*ac*hc*as + 432,000,000*hc + 81*hs*hc*as,  dh = 324,000*hc*as
//   na = 48,000,000*hs + 729*hc*ac*hs + 432,000,000*ac + 81*as*ac*hs,  dh = 324,000*ac*hs
// home = Home/Away is 1.5 or more. away = Away/Home is 1.5 or more.
// (The ranking list no longer uses home/away for the heart: T decides it. They are kept
// because lib/fd/track.ts still reads them.)
// rateHome and rateAway are the two rates (the b value used by T).
// null when hs, hc, as or ac is 0 (a denominator would be 0).
export function heartRates(
  hs: number,
  hc: number,
  as: number,
  ac: number
): { home: boolean; away: boolean; rateHome: number; rateAway: number } | null {
  if (hs <= 0 || hc <= 0 || as <= 0 || ac <= 0) return null;
  const B = (n: number) => BigInt(n);
  const nh =
    B(48000000) * B(as) + B(729) * B(ac) * B(hc) * B(as) + B(432000000) * B(hc) + B(81) * B(hs) * B(hc) * B(as);
  const dh = B(324000) * B(hc) * B(as);
  const na =
    B(48000000) * B(hs) + B(729) * B(hc) * B(ac) * B(hs) + B(432000000) * B(ac) + B(81) * B(as) * B(ac) * B(hs);
  const da = B(324000) * B(ac) * B(hs);
  const homeTop = nh * da; // Home / Away = homeTop / awayTop
  const awayTop = na * dh;
  const two = B(2);
  const three = B(3);
  return {
    home: two * homeTop >= three * awayTop, // Home / Away >= 1.5
    away: two * awayTop >= three * homeTop, // Away / Home >= 1.5
    rateHome: Number(homeTop) / Number(awayTop),
    rateAway: Number(awayTop) / Number(homeTop),
  };
}

// TRUST. a = rx, b = heart rate, a >= 0, b >= 0, a + b > 0.
//   D = |a - b| / (a + b),  T = 100 * D (0 to 100).
// null when a or b is not usable.
export function trustT(a: number, b: number): number | null {
  if (!isFinite(a) || !isFinite(b) || a < 0 || b < 0 || a + b <= 0) return null;
  const d = Math.abs(a - b) / (a + b);
  const t = 100 * d;
  return isFinite(t) ? t : null;
}

// Rounds num/den half up (0.5 goes up), exact. num >= 0, den > 0.
function roundHalfUp(num: bigint, den: bigint): number {
  const two = BigInt(2);
  return Number((two * num + den) / (two * den));
}

// X:Y from Score 2. Averages are given in hundredths.
//   X = (min(hs,ac) / (1 + max(hs,ac))) * hs      (home part of Score 2 * home scored)
//   Y = (min(as,hc) / (1 + max(as,hc))) * as      (away part of Score 2 * away scored)
// x and y are rounded half up; rawX and rawY are the unrounded numbers.
export function score2Xy(
  hsH: number,
  hcH: number,
  asH: number,
  acH: number
): { x: number; y: number; rawX: number; rawY: number } {
  const B = (n: number) => BigInt(n);
  const hundred = B(100);
  const m1 = Math.min(hsH, acH);
  const M1 = Math.max(hsH, acH);
  const m2 = Math.min(asH, hcH);
  const M2 = Math.max(asH, hcH);
  const num1 = B(m1) * B(hsH);
  const den1 = (hundred + B(M1)) * hundred;
  const num2 = B(m2) * B(asH);
  const den2 = (hundred + B(M2)) * hundred;
  return {
    x: roundHalfUp(num1, den1),
    y: roundHalfUp(num2, den2),
    rawX: Number(num1) / Number(den1),
    rawY: Number(num2) / Number(den2),
  };
}

// Rate: bigger / smaller of (total scored, total conceded), both in hundredths.
// null when the smaller one is 0. (Used by Tracking.)
export function overRate(concedeH: number, tHundredths: number): number | null {
  const big = Math.max(concedeH, tHundredths);
  const small = Math.min(concedeH, tHundredths);
  if (small <= 0) return null;
  return big / small;
}

type Side = { team: string; point: number; line: string; extra: string; order: number };
type RxItem = {
  team: string;
  rx: number;
  tick: boolean;
  star: boolean;
  heart: boolean; // not used for the heart symbol any more (T decides it), kept as it was
  heartRate: number | null; // the heart rate (null = no heart result), the b value used by T
  line: string;
  extra: string;
  order: number;
};
type DrawEntry = {
  label: string;
  home: number;
  away: number;
  diff: number;
  tick: boolean;
  tag: string;
  extra: string;
  order: number;
};
type OverItem = {
  name: string;
  tHundredths: number; // t = hs + as in hundredths, exact
  concedeH: number; // home conceded + away conceded in hundredths, exact
  hcH: number; // home conceded in hundredths
  acH: number; // away conceded in hundredths
  score: number;
  score2: number;
  fH: number; // f = Score 2 * total scored, in hundredths
  p: number | null; // P from f and the new score (null = not usable)
  extra: string;
  order: number;
};

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function hundredths(n: number): number {
  return Math.round(round2(n) * 100);
}

// Exact test of |Home point - Away point| <= 0.2, with the four averages in hundredths.
//   Home point = hs*ac / ((100+hc)*(100+as))
//   Away point = as*hc / ((100+ac)*(100+hs))
//   |Nh/Dh - Na/Da| <= 1/5  <=>  5 * |Nh*Da - Na*Dh| <= Dh*Da
export function isDraw(hs: number, hc: number, as: number, ac: number): boolean {
  const B = (n: number) => BigInt(n);
  const hundred = B(100);
  const nh = B(hs) * B(ac);
  const dh = (hundred + B(hc)) * (hundred + B(as));
  const na = B(as) * B(hc);
  const da = (hundred + B(ac)) * (hundred + B(hs));
  let cross = nh * da - na * dh;
  if (cross < B(0)) cross = -cross;
  return B(5) * cross <= dh * da;
}

// Which side the main formula favours: Home if Home point > Away point, else Away.
// Exact: Nh/Dh > Na/Da  <=>  Nh*Da > Na*Dh.
function mainStronger(hs: number, hc: number, as: number, ac: number): 'Home' | 'Away' {
  const B = (n: number) => BigInt(n);
  const hundred = B(100);
  const nh = B(hs) * B(ac);
  const dh = (hundred + B(hc)) * (hundred + B(as));
  const na = B(as) * B(hc);
  const da = (hundred + B(ac)) * (hundred + B(hs));
  return nh * da > na * dh ? 'Home' : 'Away';
}

// Exact RX test with the four averages in hundredths.
//   Home rx = Hp / Ap >= 2  <=>  Nh*Da >= 2*Na*Dh, and needs Ap > 0 (Na > 0)
//   Away rx = Ap / Hp >= 2  <=>  Na*Dh >= 2*Nh*Da, and needs Hp > 0 (Nh > 0)
export function rxQualifies(hs: number, hc: number, as: number, ac: number): { home: boolean; away: boolean } {
  const B = (n: number) => BigInt(n);
  const zero = B(0);
  const two = B(2);
  const hundred = B(100);
  const nh = B(hs) * B(ac);
  const dh = (hundred + B(hc)) * (hundred + B(as));
  const na = B(as) * B(hc);
  const da = (hundred + B(ac)) * (hundred + B(hs));
  return {
    home: na > zero && nh * da >= two * na * dh,
    away: nh > zero && na * dh >= two * nh * da,
  };
}

// Supporting formula, exact, averages in hundredths.
//   X = hs/hc + ac/as = N / (hc*as),  Y = as/ac + hc/hs = N / (ac*hs),  N = hs*as + ac*hc
//   D2 = |X - Y| = N * |ac*hs - hc*as| / (hc*as*ac*hs)
//   Returns null when hs, hc, as or ac is 0.
type Support = { small: boolean; big: boolean; stronger: 'Home' | 'Away' };
function support(hs: number, hc: number, as: number, ac: number): Support | null {
  if (hs <= 0 || hc <= 0 || as <= 0 || ac <= 0) return null;
  const B = (n: number) => BigInt(n);
  const n = B(hs) * B(as) + B(ac) * B(hc);
  const diff = B(ac) * B(hs) - B(hc) * B(as);
  const absDiff = diff < B(0) ? -diff : diff;
  const den = B(hc) * B(as) * B(ac) * B(hs);
  return {
    small: B(5) * n * absDiff <= den, // D2 <= 0.2
    big: n * absDiff >= B(3) * den, // D2 >= 3
    stronger: diff > B(0) ? 'Home' : 'Away', // X > Y <=> ac*hs > hc*as
  };
}

function kickoff(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
  });
}

function pack(header: string, entries: string[], footer: string): string[] {
  const messages: string[] = [];
  let current = header + '\n';
  entries.forEach((entry) => {
    const piece = '\n' + entry + '\n';
    if (current.length + piece.length > LIMIT && current.length > header.length + 2) {
      messages.push(current);
      current = header + ' (continued)\n';
    }
    current += piece;
  });
  if (footer) {
    if (current.length + footer.length + 2 > LIMIT) {
      messages.push(current);
      current = header + ' (continued)\n';
    }
    current += '\n' + footer;
  }
  messages.push(current);
  return messages;
}

// Highest sides first. Only the top N are returned, N = the number of matches (sides / 2).
function rankedEntries(sides: Side[]): string[] {
  const top = Math.floor(sides.length / 2);
  const sorted = sides
    .slice()
    .sort((a, b) => b.point - a.point || a.order - b.order)
    .slice(0, top);
  return sorted.map(
    (s, i) => i + 1 + ') ' + s.team + '   ' + s.point.toFixed(3) + '\n' + s.line + (s.extra ? '\n' + s.extra : '')
  );
}

// The RX 2+ section: one descending list, highest rx first.
// Check mark when D2 >= 3. Star when the side's X:Y number is bigger than its opponent's.
// Every side with a heart rate shows T in brackets (T from rx and the heart rate), and the
// heart only when T is 60 or more (60 included). No heart result = no brackets, no heart.
function rxMessages(title: string, items: RxItem[]): string[] {
  const header = 'RX 2+ - ' + title + ' (' + items.length + ')';
  if (items.length === 0) return [header + '\nNone'];
  const sorted = items.slice().sort((a, b) => b.rx - a.rx || a.order - b.order);
  const entries = sorted.map((x, i) => {
    let heartPart = '';
    if (x.heartRate !== null) {
      const t = trustT(x.rx, x.heartRate);
      if (t !== null) {
        heartPart = (t >= 60 ? ' ❤️' : '') + ' (' + t.toFixed(1) + ')';
      }
    }
    return (
      i + 1 + ') ' + x.team + (x.tick ? ' ✅' : '') + (x.star ? ' ⭐' : '') + heartPart +
      '   rx ' + x.rx.toFixed(3) +
      '\n' + x.line + (x.extra ? '\n' + x.extra : '')
    );
  });
  return pack(header, entries, '');
}

// The DRAW section: closest first (smallest difference on top).
function drawMessages(title: string, draws: DrawEntry[]): string[] {
  const header = 'DRAW - ' + title + ' (' + draws.length + ')';
  if (draws.length === 0) return [header + '\nNone'];
  const sorted = draws.slice().sort((a, b) => a.diff - b.diff || a.order - b.order);
  const entries = sorted.map(
    (d, i) =>
      i + 1 + ') ' + d.label + (d.tick ? ' ✅' : '') + ' ' + d.tag +
      '\nHome ' + d.home.toFixed(3) + ' | Away ' + d.away.toFixed(3) +
      ' | difference ' + d.diff.toFixed(3) + (d.extra ? '\n' + d.extra : '')
  );
  return pack(header, entries, '');
}

// Basketball bracket number: Score - 10, floored. The tiny 1e-9 stops a Score that is
// exactly on a whole number from dropping a point through floating-point error.
function bracketBasket(m: OverItem): number {
  return Math.floor(m.score - 10 + 1e-9);
}

// The football h LIST, after the main list.
//   Matches with f 3.00 or more. h = f * g (g = smaller conceded / bigger conceded).
//   h below 3.00 is left out. Highest h first (descending).
function hListMessages(title: string, items: OverItem[]): string[] {
  const f3 = items.filter((m) => m.fH >= 300);
  const rows: { m: OverItem; g: number; hH: number }[] = [];
  let noG = 0;
  f3.forEach((m) => {
    const hH = hHundredths(m.fH, m.hcH, m.acH);
    if (hH === null) {
      noG++;
      return;
    }
    const big = Math.max(m.hcH, m.acH);
    const small = Math.min(m.hcH, m.acH);
    rows.push({ m, g: small / big, hH });
  });
  const kept = rows.filter((x) => x.hH >= 300).sort((a, b) => b.hH - a.hH || a.m.order - b.m.order);
  const left = f3.length - kept.length;
  const footer =
    'Matches with f 3.00 or more: ' + f3.length + '. Left out: ' + left +
    ' (h below 3.00' + (noG > 0 ? ', or no g because both conceded averages are 0' : '') + ').\n' +
    'h = f x g, g = smaller conceded / bigger conceded. Highest h first.';
  const header = 'OVER h LIST (f 3+, h 3+) - ' + title + ' (' + kept.length + ')';
  if (kept.length === 0) return [header + '\nNone\n\n' + footer];
  const entries = kept.map(
    (x, i) =>
      i + 1 + ') ' + x.m.name + ' (' + (x.hH / 100).toFixed(2) + ')' +
      '\nf ' + (x.m.fH / 100).toFixed(2) + ' x g ' + x.g.toFixed(3) + ' = h ' + (x.hH / 100).toFixed(2) +
      (x.m.extra ? '\n' + x.m.extra : '')
  );
  return pack(header, entries, footer);
}

// The basketball h LIST, after the basketball main list.
//   ALL matches (no 3+ cut), h = f * g, highest h first. No g (both conceded 0) = left out.
function hListBasketMessages(title: string, items: OverItem[]): string[] {
  const rows: { m: OverItem; g: number; hH: number }[] = [];
  let noG = 0;
  items.forEach((m) => {
    const hH = hHundredths(m.fH, m.hcH, m.acH);
    if (hH === null) {
      noG++;
      return;
    }
    const big = Math.max(m.hcH, m.acH);
    const small = Math.min(m.hcH, m.acH);
    rows.push({ m, g: small / big, hH });
  });
  rows.sort((a, b) => b.hH - a.hH || a.m.order - b.m.order);
  const header = 'BASKETBALL OVER h LIST (all matches) - ' + title + ' (' + rows.length + ')';
  const footer =
    (noG > 0 ? noG + ' match(es) left out: both conceded averages are 0, so no g.\n' : '') +
    'h = f x g, f = Score 2 x total scored, g = smaller conceded / bigger conceded. Highest h first.';
  if (rows.length === 0) return [header + '\nNone\n\n' + footer];
  const entries = rows.map(
    (x, i) =>
      i + 1 + ') ' + x.m.name + ' (' + (x.hH / 100).toFixed(2) + ')' +
      '\nf ' + (x.m.fH / 100).toFixed(2) + ' x g ' + x.g.toFixed(3) + ' = h ' + (x.hH / 100).toFixed(2) +
      (x.m.extra ? '\n' + x.m.extra : '')
  );
  return pack(header, entries, footer);
}

// The football OVER RANKING: ranked by f (Score 2 x total scored), highest first.
// Matches with f below 2.00 are removed. The brackets are (f)(P), then a star by the star rule.
// Then the h list.
function overMessages(title: string, items: OverItem[]): string[] {
  if (items.length === 0) return ['OVER RANKING (f, highest first) - ' + title + ' (0)\nNone'];

  const kept = items.filter((m) => m.fH >= 200);
  const removed = items.length - kept.length;
  const header = 'OVER RANKING (f, highest first) - ' + title + ' (' + kept.length + ')';
  const footer = removed > 0 ? removed + ' match(es) with f below 2.00 are not listed.' : '';

  let first: string[];
  if (kept.length === 0) {
    first = [header + '\nNone' + (footer ? '\n\n' + footer : '')];
  } else {
    const sorted = kept.slice().sort((a, b) => b.fH - a.fH || a.order - b.order);
    const entries = sorted.map(
      (m, i) =>
        i + 1 + ') ' + m.name + ' (' + (m.fH / 100).toFixed(2) + ')' +
        (m.p !== null ? '(' + m.p.toFixed(1) + ')' : '') +
        (overStar(m.fH, m.p) ? ' ⭐' : '') +
        '\nt ' + (m.tHundredths / 100).toFixed(2) +
        ' | Score 2 ' + m.score2.toFixed(3) + (m.extra ? '\n' + m.extra : '')
    );
    first = pack(header, entries, footer);
  }
  return first.concat(hListMessages(title, items));
}

// The basketball OVER RANKING: one single list, highest Score first, then the h list.
function overBasketballMessages(title: string, items: OverItem[]): string[] {
  const header = 'BASKETBALL OVER RANKING - ' + title + ' (' + items.length + ')';
  if (items.length === 0) return [header + '\nNone'];
  const sorted = items.slice().sort((a, b) => b.score - a.score || a.order - b.order);
  const entries = sorted.map(
    (m, i) =>
      i + 1 + ') ' + m.name + ' (' + bracketBasket(m) + ')' +
      '\nScore ' + m.score.toFixed(3) + (m.extra ? '\n' + m.extra : '')
  );
  return pack(header, entries, '').concat(hListBasketMessages(title, items));
}

// Builds the draw tag and tick for one match (averages already in hundredths).
function drawInfo(hsH: number, hcH: number, asH: number, acH: number): { tick: boolean; tag: string } {
  const sup = support(hsH, hcH, asH, acH);
  const main = mainStronger(hsH, hcH, asH, acH);
  const tick = sup !== null && sup.small && isDraw(hsH, hcH, asH, acH);
  return { tick, tag: '(' + main + ', ' + (sup ? sup.stronger : '-') + ')' };
}

// ── Part 1: football-data competitions ────────────────────────────────────
export type RankComp = { code: string; name: string; count: number };

export async function listRankComps(): Promise<
  { ok: true; comps: RankComp[] } | { ok: false; error: string }
> {
  try {
    const supabase = createAdminClient();
    const fx = await supabase.from('fd_fixtures').select('comp_code').eq('status', 'pending').limit(2000);
    if (fx.error) return { ok: false, error: 'could not read the fixtures' };
    const counts: Record<string, number> = {};
    ((fx.data ?? []) as unknown as { comp_code: string }[]).forEach((r) => {
      counts[r.comp_code] = (counts[r.comp_code] ?? 0) + 1;
    });

    const cp = await supabase.from('fd_competitions').select('code, name, in_season');
    if (cp.error) return { ok: false, error: 'could not read the competitions' };
    const comps: RankComp[] = [];
    ((cp.data ?? []) as unknown as { code: string; name: string; in_season: boolean }[]).forEach((c) => {
      if (c.in_season === true && counts[c.code]) {
        comps.push({ code: c.code, name: c.name, count: counts[c.code] });
      }
    });
    comps.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, comps };
  } catch (e) {
    console.error('rank comps failed');
    return { ok: false, error: 'something went wrong' };
  }
}

type FxRow = {
  fd_match_id: number;
  match_date: string;
  home_name: string;
  away_name: string;
  hs: number | string | null;
  hc: number | string | null;
  asc_: number | string | null;
  ac: number | string | null;
  skip_reason: string | null;
};

export async function rankCompetition(
  code: string
): Promise<{ ok: true; messages: string[] } | { ok: false; error: string }> {
  try {
    const supabase = createAdminClient();
    const cp = await supabase.from('fd_competitions').select('name').eq('code', code).maybeSingle();
    const name = cp.data && typeof (cp.data as { name?: string }).name === 'string'
      ? (cp.data as { name: string }).name
      : code;

    const fx = await supabase
      .from('fd_fixtures')
      .select('fd_match_id, match_date, home_name, away_name, hs, hc, asc_, ac, skip_reason')
      .eq('comp_code', code)
      .eq('status', 'pending')
      .order('match_date', { ascending: true })
      .limit(200);
    if (fx.error) return { ok: false, error: 'could not read the fixtures' };
    const rows = (fx.data ?? []) as unknown as FxRow[];

    const sides: Side[] = [];
    const rxItems: RxItem[] = [];
    const draws: DrawEntry[] = [];
    const overs: OverItem[] = [];
    const notRanked: string[] = [];
    rows.forEach((r, i) => {
      if (r.hs === null || r.hc === null || r.asc_ === null || r.ac === null) {
        notRanked.push(r.home_name + ' - ' + r.away_name + ': ' + (r.skip_reason ? r.skip_reason : 'no averages stored yet'));
        return;
      }
      const hs = round2(Number(r.hs));
      const hc = round2(Number(r.hc));
      const as = round2(Number(r.asc_));
      const ac = round2(Number(r.ac));
      if (![hs, hc, as, ac].every((n) => isFinite(n))) {
        notRanked.push(r.home_name + ' - ' + r.away_name + ': unreadable averages');
        return;
      }
      const hsH = hundredths(hs);
      const hcH = hundredths(hc);
      const asH = hundredths(as);
      const acH = hundredths(ac);
      const when = kickoff(r.match_date);
      const hp = homePoint(hs, hc, as, ac);
      const ap = awayPoint(hs, hc, as, ac);
      sides.push({
        team: r.home_name,
        point: hp,
        line: 'Home vs ' + r.away_name,
        extra: when,
        order: i * 2,
      });
      sides.push({
        team: r.away_name,
        point: ap,
        line: 'Away at ' + r.home_name,
        extra: when,
        order: i * 2 + 1,
      });
      const q = rxQualifies(hsH, hcH, asH, acH);
      const sup = support(hsH, hcH, asH, acH);
      const rxTick = sup !== null && sup.big;
      const xy = score2Xy(hsH, hcH, asH, acH);
      const hr = heartRates(hsH, hcH, asH, acH);
      if (q.home) {
        rxItems.push({ team: r.home_name, rx: hp / ap, tick: rxTick, star: xy.x > xy.y, heart: hr !== null && hr.home, heartRate: hr !== null ? hr.rateHome : null, line: 'Home vs ' + r.away_name, extra: when, order: i * 2 });
      }
      if (q.away) {
        rxItems.push({ team: r.away_name, rx: ap / hp, tick: rxTick, star: xy.y > xy.x, heart: hr !== null && hr.away, heartRate: hr !== null ? hr.rateAway : null, line: 'Away at ' + r.home_name, extra: when, order: i * 2 + 1 });
      }
      if (isDraw(hsH, hcH, asH, acH)) {
        const info = drawInfo(hsH, hcH, asH, acH);
        draws.push({
          label: r.home_name + ' - ' + r.away_name,
          home: hp,
          away: ap,
          diff: Math.abs(hp - ap),
          tick: info.tick,
          tag: info.tag,
          extra: when,
          order: i,
        });
      }
      const fH = fHundredths(hs, hc, as, ac);
      overs.push({
        name: r.home_name + ' - ' + r.away_name,
        tHundredths: hsH + asH,
        concedeH: hcH + acH,
        hcH,
        acH,
        score: overScore(hs, hc, as, ac),
        score2: overScore2(hs, hc, as, ac),
        fH,
        p: pValue(fH / 100, newScore(hs, hc, as, ac)),
        extra: when,
        order: i,
      });
    });

    const footerParts: string[] = [];
    if (notRanked.length > 0) footerParts.push('NOT RANKED:\n' + notRanked.join('\n'));
    footerParts.push('Rule-based order from the formula. No accuracy is promised.');
    const top = Math.floor(sides.length / 2);
    const header = 'RANKING - ' + name + ' (top ' + top + ' of ' + sides.length + ' sides)';
    if (sides.length === 0) {
      return { ok: true, messages: [header + '\n\nNo stored match has averages yet.\n\n' + footerParts.join('\n\n')] };
    }
    const messages = pack(header, rankedEntries(sides), footerParts.join('\n\n'))
      .concat(rxMessages(name, rxItems))
      .concat(drawMessages(name, draws))
      .concat(overMessages(name, overs));
    return { ok: true, messages };
  } catch (e) {
    console.error('rank competition failed');
    return { ok: false, error: 'something went wrong' };
  }
}

// ── Part 2: the matches pasted into the storage ───────────────────────────
export type PastedRow = { name: string; dataLine: string; league: string | null };

function splitTeams(name: string): { home: string; away: string } | null {
  const seps = [' - ', ' vs ', ' v '];
  for (const sep of seps) {
    const at = name.toLowerCase().indexOf(sep);
    if (at > 0) return { home: name.slice(0, at).trim(), away: name.slice(at + sep.length).trim() };
  }
  return null;
}

// A stored league that starts with the word Basketball marks a basketball match.
function isBasketball(league: string | null): boolean {
  if (!league) return false;
  return league.trim().toLowerCase().indexOf('basketball') === 0;
}

// Ranks one group of pasted matches: football (basketball = false) or basketball (true).
function rankPastedGroup(rows: PastedRow[], basketball: boolean): string[] {
  const sides: Side[] = [];
  const rxItems: RxItem[] = [];
  const draws: DrawEntry[] = [];
  const overs: OverItem[] = [];
  const unreadable: string[] = [];
  rows.forEach((r, i) => {
    const parts = r.dataLine.split(',').map((x) => x.trim());
    if (parts.length !== 4 && parts.length !== 6) {
      unreadable.push(r.name);
      return;
    }
    const nums = parts.slice(parts.length - 4).map((x) => Number(x));
    if (nums.some((n) => !isFinite(n) || n < 0)) {
      unreadable.push(r.name);
      return;
    }
    const [hs, hc, as, ac] = nums.map(round2);
    const hsH = hundredths(hs);
    const hcH = hundredths(hc);
    const asH = hundredths(as);
    const acH = hundredths(ac);
    const teams = splitTeams(r.name);
    const homeName = teams ? teams.home : 'Home team of ' + r.name;
    const awayName = teams ? teams.away : 'Away team of ' + r.name;
    const league = r.league ? r.league.replace(/^basketball\s*\|?\s*/i, '').trim() : '';
    const hp = homePoint(hs, hc, as, ac);
    const ap = awayPoint(hs, hc, as, ac);
    sides.push({
      team: homeName,
      point: hp,
      line: 'Home vs ' + awayName,
      extra: league,
      order: i * 2,
    });
    sides.push({
      team: awayName,
      point: ap,
      line: 'Away at ' + homeName,
      extra: league,
      order: i * 2 + 1,
    });
    const q = rxQualifies(hsH, hcH, asH, acH);
    const sup = support(hsH, hcH, asH, acH);
    const rxTick = sup !== null && sup.big;
    const xy = score2Xy(hsH, hcH, asH, acH);
    const hr = heartRates(hsH, hcH, asH, acH);
    if (q.home) {
      rxItems.push({ team: homeName, rx: hp / ap, tick: rxTick, star: xy.x > xy.y, heart: hr !== null && hr.home, heartRate: hr !== null ? hr.rateHome : null, line: 'Home vs ' + awayName, extra: league, order: i * 2 });
    }
    if (q.away) {
      rxItems.push({ team: awayName, rx: ap / hp, tick: rxTick, star: xy.y > xy.x, heart: hr !== null && hr.away, heartRate: hr !== null ? hr.rateAway : null, line: 'Away at ' + homeName, extra: league, order: i * 2 + 1 });
    }
    if (!basketball && isDraw(hsH, hcH, asH, acH)) {
      const info = drawInfo(hsH, hcH, asH, acH);
      draws.push({
        label: r.name,
        home: hp,
        away: ap,
        diff: Math.abs(hp - ap),
        tick: info.tick,
        tag: info.tag,
        extra: league,
        order: i,
      });
    }
    const fH = fHundredths(hs, hc, as, ac);
    overs.push({
      name: r.name,
      tHundredths: hsH + asH,
      concedeH: hcH + acH,
      hcH,
      acH,
      score: overScore(hs, hc, as, ac),
      score2: overScore2(hs, hc, as, ac),
      fH,
      p: pValue(fH / 100, newScore(hs, hc, as, ac)),
      extra: league,
      order: i,
    });
  });

  const footerParts: string[] = [];
  if (unreadable.length > 0) footerParts.push('Could not read: ' + unreadable.join(', '));
  footerParts.push('Rule-based order from the formula. No accuracy is promised.');
  const top = Math.floor(sides.length / 2);
  const label = basketball ? 'basketball pasted matches' : 'pasted matches';
  const header =
    (basketball ? 'BASKETBALL RANKING - pasted matches' : 'RANKING - pasted matches') +
    ' (top ' + top + ' of ' + sides.length + ' sides)';
  if (sides.length === 0) {
    return [header + '\n\nNo stored match could be read.\n\n' + footerParts.join('\n\n')];
  }
  let out = pack(header, rankedEntries(sides), footerParts.join('\n\n')).concat(rxMessages(label, rxItems));
  if (basketball) {
    out = out.concat(overBasketballMessages('pasted matches', overs));
  } else {
    out = out.concat(drawMessages(label, draws)).concat(overMessages(label, overs));
  }
  return out;
}

export function rankPasted(rows: PastedRow[]): string[] {
  const football = rows.filter((r) => !isBasketball(r.league));
  const basket = rows.filter((r) => isBasketball(r.league));
  let out: string[] = [];
  if (football.length > 0 || basket.length === 0) {
    out = out.concat(rankPastedGroup(football, false));
  }
  if (basket.length > 0) {
    out = out.concat(rankPastedGroup(basket, true));
  }
  return out;
}
