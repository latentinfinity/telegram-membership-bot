// lib/fd/rollOver2.ts  (REPLACES the earlier version) - pure, read only.
// One list, three sections:
//   Section 1: total goals 3+ in BOTH correct-score formulas (5+ counts as 5),
//              AND one side scored > conceded while the other conceded > scored
//              (a tie on either side eliminates the match).
//   Section 2: rh = hs*ac, ra = as*hc, t = (rh+ra)*0.67,
//              t rounded up if its decimal is 0.6 or more, else down; keep t >= 4
//              (which is exactly t >= 3.6). Does not use the correct-score formulas.
//   Section 3: matches that are in both Section 1 and Section 2.
// All comparisons use exact integer maths (decimal text scaled by 10^9, BigInt).
import { calibratedScores } from '../correctScore';

export type RollRow = { name: string;dataLine: string;league: string | null };

export type RollPlan = {
  section1: RollRow[];
  section2: RollRow[];
  both: RollRow[];
  total: number;
  unreadable: string[];
};

const DECIMALS = 9;

// "1.45" -> 1450000000 (scaled by 10^9, extra decimals cut off).
function scaled(text: string): bigint {
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  let frac = dot === -1 ? '' : text.slice(dot + 1);
  if (frac.length > DECIMALS) frac = frac.slice(0, DECIMALS);
  while (frac.length < DECIMALS) frac = frac + '0';
  return BigInt(whole + frac);
}

function lastFour(line: string): string[] | null {
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length !== 4 && parts.length !== 6) return null;
  const nums = parts.slice(parts.length - 4);
  for (const n of nums) {
    if (!/^\d+(\.\d+)?$/.test(n)) return null;
  }
  return nums;
}

function goalsTotal(home: number, away: number): number {
  return Math.min(5, home) + Math.min(5, away);
}

export function planRollOver2(rows: RollRow[]): RollPlan {
  const section1: RollRow[] = [];
  const section2: RollRow[] = [];
  const both: RollRow[] = [];
  const unreadable: string[] = [];
  
  const SCALE2 = BigInt('1000000000000000000'); // 10^18, scale of a product
  const T_MIN = BigInt(360) * SCALE2; // (rh+ra)*67 >= 360 * 10^18  <=>  t >= 3.6
  const SIXTY_SEVEN = BigInt(67);
  
  for (const row of rows) {
    const nums = lastFour(row.dataLine);
    if (!nums) {
      unreadable.push(row.name);
      continue;
    }
    
    const hs = scaled(nums[0]);
    const hc = scaled(nums[1]);
    const as = scaled(nums[2]);
    const ac = scaled(nums[3]);
    
    // Section 1
    let inOne = false;
    const scores = calibratedScores(nums[0], nums[1], nums[2], nums[3]);
    if (scores) {
      const prodTotal = goalsTotal(scores.prod.home, scores.prod.away);
      const expTotal = goalsTotal(scores.exp.home, scores.exp.away);
      if (prodTotal >= 3 && expTotal >= 3) {
        const homeScoring = hs > hc;
        const homeConceding = hc > hs;
        const awayScoring = as > ac;
        const awayConceding = ac > as;
        inOne =
          (homeScoring && awayConceding) || (homeConceding && awayScoring);
      }
    }
    
    // Section 2
    const rh = hs * ac;
    const ra = as * hc;
    const inTwo = (rh + ra) * SIXTY_SEVEN >= T_MIN;
    
    if (inOne) section1.push(row);
    if (inTwo) section2.push(row);
    if (inOne && inTwo) both.push(row);
  }
  
  return { section1, section2, both, total: rows.length, unreadable };
}

const LIMIT = 3500;

export function formatRollOver2(plan: RollPlan): string[] {
  const title = 'ROLL OVER LIST 2';
  
  const footerLines: string[] = [];
  footerLines.push(
    plan.total +
    ' stored matches checked: ' +
    plan.section1.length + ' in Section 1, ' +
    plan.section2.length + ' in Section 2, ' +
    plan.both.length + ' in both.'
  );
  if (plan.unreadable.length > 0) {
    footerLines.push('Could not read: ' + plan.unreadable.join(', ') + '.');
  }
  footerLines.push('No accuracy is promised. These are rule-based picks.');
  const footer = footerLines.join('\n');
  
  // Each block is one piece that must not be split; a section header is
  // glued to its first entry so it is never left alone at the end of a message.
  const blocks: string[] = [];
  const addSection = (header: string, list: RollRow[]) => {
    if (list.length === 0) {
      blocks.push(header + '\nNone');
      return;
    }
    list.forEach((row, i) => {
      const entry =
        i + 1 + ') ' + row.name + (row.league ? '\n' + row.league : '');
      blocks.push(i === 0 ? header + '\n' + entry : entry);
    });
  };
  
  addSection('SECTION 1 - Total 3+ and opposite lean', plan.section1);
  addSection('SECTION 2 - t rule (t 4+)', plan.section2);
  addSection('SECTION 3 - In both sections', plan.both);
  
  const messages: string[] = [];
  let current = title + '\n';
  for (const block of blocks) {
    if (current.length + block.length + 2 > LIMIT) {
      messages.push(current);
      current = title + ' (continued)\n';
    }
    current += '\n' + block + '\n';
  }
  
  if (current.length + footer.length + 2 > LIMIT) {
    messages.push(current);
    current = title + ' (continued)\n';
  }
  current += '\n' + footer;
  messages.push(current);
  return messages;
}
