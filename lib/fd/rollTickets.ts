// lib/fd/rollTickets.ts  (NEW) - Roll Over Section 1 list. Pure, read only, random every run.
// Source: Roll Over List 2, Section 1.
// Step 1: randomly remove 20% (nearest whole match, .5 rounds up).
// Step 2: each remaining match gets Over 2.5 or Over 1.5 by an independent fair coin flip.
// Output: one single list in stored order.
import { planRollOver2 } from './rollOver2';
import type { RollRow } from './rollOver2';

const REMOVE_PERCENT = 20;

export type RollLine = { name: string; league: string | null; label: string };

export type RollS1Plan = {
  total: number;
  unreadable: string[];
  section1: number;
  removed: number;
  list: RollLine[];
  over25: number;
  over15: number;
};

function shuffle<T>(list: T[]): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function removalCount(m: number): number {
  return Math.floor((2 * m * REMOVE_PERCENT + 100) / 200);
}

export function planRollS1(rows: RollRow[]): RollS1Plan {
  const plan2 = planRollOver2(rows);
  const section1 = plan2.section1;

  const index = new Map<RollRow, number>();
  rows.forEach((r, i) => index.set(r, i));
  const positions: number[] = [];
  section1.forEach((r) => {
    const i = index.get(r);
    if (i !== undefined) positions.push(i);
  });

  const removeN = removalCount(positions.length);
  const removedSet = new Set<number>(shuffle(positions).slice(0, removeN));
  const kept = positions.filter((p) => !removedSet.has(p)); // stored order

  let over25 = 0;
  let over15 = 0;
  const list: RollLine[] = kept.map((p) => {
    const isOver25 = Math.random() < 0.5;
    if (isOver25) over25++;
    else over15++;
    return {
      name: rows[p].name,
      league: rows[p].league,
      label: isOver25 ? 'Over 2.5' : 'Over 1.5',
    };
  });

  return {
    total: rows.length,
    unreadable: plan2.unreadable,
    section1: positions.length,
    removed: removeN,
    list,
    over25,
    over15,
  };
}

const LIMIT = 3500;

export function formatRollS1(plan: RollS1Plan): string[] {
  const title = 'ROLL OVER SECTION 1 LIST';

  const s: string[] = [];
  s.push('Stored matches: ' + plan.total + (plan.unreadable.length > 0 ? ' (could not read: ' + plan.unreadable.join(', ') + ')' : ''));
  s.push('In Section 1: ' + plan.section1 + '. Removed at random (20%): ' + plan.removed + '. Left: ' + plan.list.length + '.');
  s.push('Over 2.5: ' + plan.over25 + ', Over 1.5: ' + plan.over15 + ' (chosen at random).');
  s.push('Random on every run. No accuracy is promised. These are rule-based picks.');
  const footer = s.join('\n');

  if (plan.section1 === 0) {
    return [title + '\n\nNo stored match is in Section 1.\n\n' + footer];
  }
  if (plan.list.length === 0) {
    return [title + '\n\nNo match was left after the random removal.\n\n' + footer];
  }

  const messages: string[] = [];
  let current = title + ' (' + plan.list.length + ' matches)\n';
  plan.list.forEach((m, i) => {
    const entry =
      '\n' + (i + 1) + ') ' + m.name + (m.league ? '\n' + m.league : '') + '\n' + m.label + '\n';
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
