// lib/fd/rollOver2.ts  (NEW) - Roll Over list 2, pure, read only.
// Filter 1: total goals 3+ in BOTH correct-score formulas (5+ counts as 5).
// Filter 2: one side scored > conceded and the other side conceded > scored.
//           A tie on either side means no lean, so the match is eliminated.
import { calibratedScores } from '../correctScore';

export type RollRow = { name: string;dataLine: string;league: string | null };

export type RollPlan = {
  kept: RollRow[];
  total: number;
  failedTotal: number;
  failedAvg: number;
  unreadable: string[];
};

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
  const kept: RollRow[] = [];
  const unreadable: string[] = [];
  let failedTotal = 0;
  let failedAvg = 0;
  
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
    
    const prodTotal = goalsTotal(scores.prod.home, scores.prod.away);
    const expTotal = goalsTotal(scores.exp.home, scores.exp.away);
    if (prodTotal < 3 || expTotal < 3) {
      failedTotal++;
      continue;
    }
    
    const homeScored = parseFloat(nums[0]);
    const homeConceded = parseFloat(nums[1]);
    const awayScored = parseFloat(nums[2]);
    const awayConceded = parseFloat(nums[3]);
    
    const homeScoring = homeScored > homeConceded;
    const homeConceding = homeConceded > homeScored;
    const awayScoring = awayScored > awayConceded;
    const awayConceding = awayConceded > awayScored;
    
    const opposite =
      (homeScoring && awayConceding) || (homeConceding && awayScoring);
    if (!opposite) {
      failedAvg++;
      continue;
    }
    
    kept.push(row);
  }
  
  return { kept, total: rows.length, failedTotal, failedAvg, unreadable };
}

const LIMIT = 3500;

export function formatRollOver2(plan: RollPlan): string[] {
  const title = 'ROLL OVER LIST 2';
  const footerLines: string[] = [];
  footerLines.push(
    plan.kept.length + ' of ' + plan.total + ' stored matches kept.'
  );
  footerLines.push(
    'Eliminated: ' +
    plan.failedTotal +
    ' by the correct-score total (3+ goals in both formulas), ' +
    plan.failedAvg +
    ' by the averages check.'
  );
  if (plan.unreadable.length > 0) {
    footerLines.push('Could not read: ' + plan.unreadable.join(', ') + '.');
  }
  footerLines.push('No accuracy is promised. These are rule-based picks.');
  const footer = footerLines.join('\n');
  
  if (plan.kept.length === 0) {
    return [title + '\n\nNo stored match passed both filters.\n\n' + footer];
  }
  
  const messages: string[] = [];
  let current = title + '\n';
  plan.kept.forEach((row, i) => {
    const entry =
      '\n' + (i + 1) + ') ' + row.name + (row.league ? '\n' + row.league : '') + '\n';
    if (current.length + entry.length > LIMIT) {
      messages.push(current);
      current = title + ' (continued)\n';
    }
    current += entry;
  });
  
  if (current.length + footer.length + 2 > LIMIT) {
    messages.push(current);
    current = '';
  }
  current += '\n' + footer;
  messages.push(current);
  return messages;
}
