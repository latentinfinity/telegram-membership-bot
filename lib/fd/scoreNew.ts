// PURE. The "new" correct score: (0.67 x own scored) x (0.5 x opponent conceded),
// mapped to goals with Formula 1's cut points (home and away). Exact integer maths.
// Used only by the manual "Correct Scores" button.

// Formula 1 cut points, in units of 0.0001 (same numbers as lib/correctScore.ts, "prod")
const CUT_HOME = [10489, 13560, 16030, 18336, 20765];
const CUT_AWAY = [11613, 14788, 17541, 19909, 22425];

// value in units of 0.0000001: 0.67 * a/100 * 0.5 * b/100 = 335 * a * b / 10^7
function goals(a100: number, b100: number, cuts: number[]): number {
  const v = 335 * a100 * b100;
  for (let i = 0; i < cuts.length; i++) if (v <= cuts[i] * 1000) return i;
  return 5; // 5 means "5 or more"
}

export function newScore(hs100: number, hc100: number, as100: number, ac100: number): { home: number; away: number } {
  return { home: goals(hs100, ac100, CUT_HOME), away: goals(as100, hc100, CUT_AWAY) };
}

export type ScoreRow = { name: string; dataLine: string; league: string | null };
export type ScoreResult = { checked: number; unreadable: string[]; messages: string[] };

const LIMIT = 3500;
const show = (g: number) => (g >= 5 ? '5+' : String(g));

export function runScores(rows: ScoreRow[]): ScoreResult {
  const unreadable: string[] = [];
  const items: { name: string; league: string; score: string }[] = [];
  for (const r of rows) {
    const parts = r.dataLine.split(',').map((x) => x.trim());
    const nums = (parts.length === 6 ? parts.slice(2) : parts).map((x) => Number(x));
    if ((parts.length !== 4 && parts.length !== 6) || nums.length !== 4 || nums.some((n) => !isFinite(n) || n < 0)) {
      unreadable.push(r.name);
      continue;
    }
    // same 2-decimal rounding as the other manual and automatic lists
    const h = nums.map((n) => Math.round(Number(n.toFixed(2)) * 100));
    const sc = newScore(h[0], h[1], h[2], h[3]);
    items.push({ name: r.name, league: r.league || '', score: `${show(sc.home)} - ${show(sc.away)}` });
  }
  // group by league in stored order (first appearance); matches with no league go last
  const order: string[] = [];
  const by: Record<string, typeof items> = {};
  for (const it of items) {
    if (by[it.league] === undefined) { by[it.league] = []; order.push(it.league); }
    by[it.league].push(it);
  }
  const named = order.filter((l) => l !== '');
  const finalOrder = by[''] ? named.concat(['']) : named;
  const onlyOne = finalOrder.length === 1 && finalOrder[0] === '';
  const lines: string[] = [];
  let n = 0;
  for (const l of finalOrder) {
    if (lines.length) lines.push('');
    if (!onlyOne) lines.push(l === '' ? 'Other matches' : l);
    for (const it of by[l]) { n++; lines.push(`${n}) ${it.name}   ${it.score}`); }
  }
  const header = 'CORRECT SCORES (0.67 x scored) x (0.5 x conceded)';
  const messages: string[] = [];
  let cur: string[] = [];
  let len = header.length;
  for (const ln of lines) {
    if (cur.length > 0 && len + ln.length + 1 > LIMIT) {
      messages.push((messages.length ? header + ' (continued)' : header) + '\n\n' + cur.join('\n'));
      cur = []; len = header.length + 12;
    }
    cur.push(ln); len += ln.length + 1;
  }
  if (cur.length) messages.push((messages.length ? header + ' (continued)' : header) + '\n\n' + cur.join('\n'));
  return { checked: items.length, unreadable, messages };
}
