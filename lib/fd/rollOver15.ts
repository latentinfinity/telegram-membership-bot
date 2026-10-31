// lib/fd/rollOver15.ts  (NEW) - Over 1.5 list. Pure, read only, no random steps.
// Filter 1: BOTH correct-score formulas give one of 2:1, 1:2, 3:1, 1:3
//           (the two formulas may give different scores from this set).
// Filter 2: opposite lean: one side scored > conceded and the other side
//           conceded > scored (a tie on either side eliminates the match).
// Filter 3: Y = home scored + away scored, Z = home conceded + away conceded;
//           keep only if Y > Z (strictly; Y = Z eliminates).
// Option: Over 1.5 for every match left. Exact integer maths (BigInt).
import { calibratedScores } from '../correctScore';

export type O15Row = { name: string;dataLine: string;league: string | null };

export type O15Plan = {
  total: number;
  unreadable: string[];
  afterScores: number;
  afterLean: number;
  kept: O15Row[];
};

const DECIMALS = 9;
const SET = ['2:1', '1:2', '3:1', '1:3'];

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

export function planOver15(rows: O15Row[]): O15Plan {
  const unreadable: string[] = [];
  const kept: O15Row[] = [];
  let afterScores = 0;
  let afterLean = 0;
  
  for (const row of rows) {
    const nums = lastFour(row.dataLine);
    if (!nums) {
      unreadable.push(row.name);
      continue;
    }
    const scores = calibratedScores(nums[0], nums[1], nums[2], nums[3]);
    if (!scores) {
      unreadable.push(row.name);
      continue;
    }
    
    // Filter 1
    const prodKey = scores.prod.home + ':' + scores.prod.away;
    const expKey = scores.exp.home + ':' + scores.exp.away;
    if (SET.indexOf(prodKey) === -1 || SET.indexOf(expKey) === -1) continue;
    afterScores++;
    
    // Filter 2
    const hs = scaled(nums[0]);
    const hc = scaled(nums[1]);
    const as = scaled(nums[2]);
    const ac = scaled(nums[3]);
    const homeScoring = hs > hc;
    const homeConceding = hc > hs;
    const awayScoring = as > ac;
    const awayConceding = ac > as;
    const opposite =
      (homeScoring && awayConceding) || (homeConceding && awayScoring);
    if (!opposite) continue;
    afterLean++;
    
    // Filter 3
    const y = hs + as;
    const z = hc + ac;
    if (y > z) kept.push(row);
  }
  
  return { total: rows.length, unreadable, afterScores, afterLean, kept };
}

const LIMIT = 3500;

export function formatO15(plan: O15Plan): string[] {
  const title = 'OVER 1.5 LIST';
  
  const s: string[] = [];
  s.push('Stored matches: ' + plan.total + (plan.unreadable.length > 0 ? ' (could not read: ' + plan.unreadable.join(', ') + ')' : ''));
  s.push('Both formulas in 2:1 / 1:2 / 3:1 / 1:3: ' + plan.afterScores + '.');
  s.push('After the opposite-lean filter: ' + plan.afterLean + '.');
  s.push('After scored bigger than conceded: ' + plan.kept.length + '.');
  s.push('No accuracy is promised. These are rule-based picks.');
  const footer = s.join('\n');
  
  if (plan.kept.length === 0) {
    return [title + '\n\nNo stored match passed all three filters.\n\n' + footer];
  }
  
  const messages: string[] = [];
  let current = title + ' (' + plan.kept.length + ' matches)\n';
  plan.kept.forEach((m, i) => {
    const entry =
      '\n' + (i + 1) + ') ' + m.name + (m.league ? '\n' + m.league : '') + '\nOver 1.5\n';
    if (current.length + entry.length > LIMIT) {
      messages.push(current);
      current = title + ' (continued)\n';
    }
    current += entry;
  });
  
  if (current.length + footer.length + 2 > LIMIT) {
    messages.push(current);
    current = title + ' (continued)\n';
  }
  current += '\n' + footer;
  messages.push(current);
  return messages;
}
