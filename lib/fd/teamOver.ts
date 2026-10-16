// PURE. Team Over line, expected goals, confidence and label.
export type Label = 'Very Low' | 'Low' | 'Moderate' | 'High' | 'Very High';

// numeric(5,2) from the database (number or string) -> integer hundredths
export function toHundredths(x: number | string | null | undefined): number | null {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// R = 0.67*own scored + 0.5*opponent conceded, in exact integer maths.
// Round up only if the decimal part is 0.6 or more.
export function teamLine(s100: number, oc100: number): number {
  const rn = 67 * s100 + 50 * oc100; // R in units of 0.0001
  const whole = Math.floor(rn / 10000);
  const dec = rn - whole * 10000;
  return dec >= 6000 ? whole + 1 : whole;
}

// expected goals = (own scored + opponent conceded) / 2
export function lambda(s100: number, oc100: number): number {
  return (s100 + oc100) / 200;
}

// chance of at least k goals, Poisson(lam), as a whole percent
export function pctAtLeast(k: number, lam: number): number {
  if (k <= 0) return 100;
  if (lam <= 0) return 0;
  let term = Math.exp(-lam);
  let sum = 0;
  for (let i = 0; i < k; i++) {
    sum += term;
    term = (term * lam) / (i + 1);
  }
  const p = Math.min(1, Math.max(0, 1 - sum));
  return Math.round(p * 100 + 1e-9);
}

export function labelOf(pct: number): Label {
  if (pct < 40) return 'Very Low';
  if (pct < 50) return 'Low';
  if (pct < 65) return 'Moderate';
  if (pct < 80) return 'High';
  return 'Very High';
}

export type TeamView = { goals: number; lam: number };
export function teamView(s100: number, oc100: number): TeamView {
  return { goals: teamLine(s100, oc100), lam: lambda(s100, oc100) };
}
