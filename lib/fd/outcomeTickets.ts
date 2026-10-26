// lib/fd/outcomeTickets.ts  (NEW) - Outcome Tickets. Pure, read only, random on every run.
// SIDE A: the third correct score (lib/fd/scoreNew.ts)
//   remove 0:0, 1:0, 0:1, 2:1, 1:2 and all draws; the rest is Home or Away;
//   random 3-way split (straight / double chance / win either half), the
//   remainder is removed; then 20% removed at random.
// SIDE B: Roll Over List 2, Section 3
//   random 2-way split (Over 2.5 / Over 1.5); then 20% removed at random.
// MERGE: a match on both sides keeps one side at random; the matches are dealt
//   at random into Ticket 1 and Ticket 2 (equal size, one removed if odd).
import { newScore } from './scoreNew';
import { planRollOver2 } from './rollOver2';
import type { RollRow } from './rollOver2';

type Option = 'HOME' | 'AWAY' | '1X' | 'X2' | 'HWEH' | 'AWEH' | 'O25' | 'O15';

const LABEL: Record<Option, string> = {
  HOME: 'Home',
  AWAY: 'Away',
  '1X': 'Home/Draw (1X)',
  X2: 'Draw/Away (X2)',
  HWEH: 'HWEH',
  AWEH: 'AWEH',
  O25: 'Over 2.5',
  O15: 'Over 1.5',
};

const BLOCKED = ['0:0', '1:0', '0:1', '2:1', '1:2'];
const REMOVE_PERCENT = 20;

type Entry = { idx: number; option: Option };

export type TicketLine = { name: string; league: string | null; label: string };

export type OutcomePlan = {
  total: number;
  unreadable: string[];
  a: {
    blocked: number;
    draws: number;
    outcomes: number;
    splitRemainder: number;
    randomRemoved: number;
    left: number;
  };
  b: { section3: number; randomRemoved: number; left: number };
  overlap: number;
  oddRemoved: number;
  ticket1: TicketLine[];
  ticket2: TicketLine[];
  reason: string;
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

// 20% of m, rounded to the nearest whole match (.5 rounds up).
function removalCount(m: number): number {
  return Math.floor((2 * m * REMOVE_PERCENT + 100) / 200);
}

function parseNums(dataLine: string): number[] | null {
  const parts = dataLine.split(',').map((x) => x.trim());
  if (parts.length !== 4 && parts.length !== 6) return null;
  const nums = (parts.length === 6 ? parts.slice(2) : parts).map((x) => Number(x));
  if (nums.length !== 4 || nums.some((n) => !isFinite(n) || n < 0)) return null;
  return nums;
}

function converted(outcome: 'HOME' | 'AWAY', part: number): Option {
  if (part === 0) return outcome;
  if (part === 1) return outcome === 'HOME' ? '1X' : 'X2';
  return outcome === 'HOME' ? 'HWEH' : 'AWEH';
}

export function planOutcome(rows: RollRow[]): OutcomePlan {
  const unreadable: string[] = [];

  // ── SIDE A ─────────────────────────────────────────────────────────────
  const outcomes: { idx: number; outcome: 'HOME' | 'AWAY' }[] = [];
  let blocked = 0;
  let draws = 0;
  for (let i = 0; i < rows.length; i++) {
    const nums = parseNums(rows[i].dataLine);
    if (!nums) {
      unreadable.push(rows[i].name);
      continue;
    }
    // same 2-decimal rounding as the Correct Scores button
    const h = nums.map((n) => Math.round(Number(n.toFixed(2)) * 100));
    const sc = newScore(h[0], h[1], h[2], h[3]);
    if (BLOCKED.indexOf(sc.home + ':' + sc.away) !== -1) {
      blocked++;
      continue;
    }
    if (sc.home === sc.away) {
      draws++;
      continue;
    }
    outcomes.push({ idx: i, outcome: sc.home > sc.away ? 'HOME' : 'AWAY' });
  }

  const shuffledA = shuffle(outcomes);
  const remainder = shuffledA.length % 3;
  const keptA = shuffledA.slice(0, shuffledA.length - remainder);
  const third = keptA.length / 3;
  const splitEntries: Entry[] = keptA.map((o, i) => ({
    idx: o.idx,
    option: converted(o.outcome, i < third ? 0 : i < 2 * third ? 1 : 2),
  }));
  const removeA = removalCount(splitEntries.length);
  const sideA: Entry[] = shuffle(splitEntries).slice(removeA);

  // ── SIDE B ─────────────────────────────────────────────────────────────
  const plan2 = planRollOver2(rows);
  const index = new Map<RollRow, number>();
  rows.forEach((r, i) => index.set(r, i));
  const sectionThree: number[] = [];
  plan2.both.forEach((r) => {
    const i = index.get(r);
    if (i !== undefined) sectionThree.push(i);
  });
  const shuffledB = shuffle(sectionThree);
  const half = Math.floor(shuffledB.length / 2);
  const extra = shuffledB.length % 2;
  const firstSize = half + (extra === 1 && Math.random() < 0.5 ? 1 : 0);
  const splitB: Entry[] = shuffledB.map((idx, i) => ({
    idx,
    option: i < firstSize ? 'O25' : 'O15',
  }));
  const removeB = removalCount(splitB.length);
  const sideB: Entry[] = shuffle(splitB).slice(removeB);

  // ── MERGE ──────────────────────────────────────────────────────────────
  const chosen = new Map<number, Entry>();
  sideA.forEach((e) => chosen.set(e.idx, e));
  let overlap = 0;
  sideB.forEach((e) => {
    if (chosen.has(e.idx)) {
      overlap++;
      if (Math.random() < 0.5) chosen.set(e.idx, e);
    } else {
      chosen.set(e.idx, e);
    }
  });
  const merged: Entry[] = [];
  chosen.forEach((e) => merged.push(e));
  let all = shuffle(merged);
  let oddRemoved = 0;
  if (all.length % 2 === 1) {
    all = all.slice(0, all.length - 1);
    oddRemoved = 1;
  }

  let ticket1: TicketLine[] = [];
  let ticket2: TicketLine[] = [];
  let reason = '';
  if (all.length < 2) {
    reason = 'Fewer than 2 matches were left, so no tickets could be made.';
  } else {
    const mid = all.length / 2;
    const line = (e: Entry): TicketLine => ({
      name: rows[e.idx].name,
      league: rows[e.idx].league,
      label: LABEL[e.option],
    });
    ticket1 = all.slice(0, mid).map(line);
    ticket2 = all.slice(mid).map(line);
  }

  return {
    total: rows.length,
    unreadable,
    a: {
      blocked,
      draws,
      outcomes: outcomes.length,
      splitRemainder: remainder,
      randomRemoved: removeA,
      left: sideA.length,
    },
    b: { section3: sectionThree.length, randomRemoved: removeB, left: sideB.length },
    overlap,
    oddRemoved,
    ticket1,
    ticket2,
    reason,
  };
}

const LIMIT = 3500;

function packTicket(title: string, list: TicketLine[]): string[] {
  const messages: string[] = [];
  let current = title + ' (' + list.length + ' matches)\n';
  list.forEach((m, i) => {
    const entry =
      '\n' + (i + 1) + ') ' + m.name + (m.league ? '\n' + m.league : '') + '\n' + m.label + '\n';
    if (current.length + entry.length > LIMIT) {
      messages.push(current);
      current = title + ' (continued)\n';
    }
    current += entry;
  });
  messages.push(current);
  return messages;
}

export function formatOutcome(plan: OutcomePlan): string[] {
  const s: string[] = [];
  s.push('OUTCOME TICKETS SUMMARY');
  s.push('Stored matches: ' + plan.total + (plan.unreadable.length > 0 ? ' (could not read: ' + plan.unreadable.join(', ') + ')' : ''));
  s.push(
    'Side A (third correct score): ' + plan.a.blocked + ' removed by the score list, ' +
      plan.a.draws + ' removed as draws, ' + plan.a.outcomes + ' Home/Away outcomes, ' +
      plan.a.splitRemainder + ' removed by the 3-way split, ' +
      plan.a.randomRemoved + ' removed at random (20%), ' + plan.a.left + ' left.'
  );
  s.push(
    'Side B (Roll Over List 2, Section 3): ' + plan.b.section3 + ' matches, ' +
      plan.b.randomRemoved + ' removed at random (20%), ' + plan.b.left + ' left.'
  );
  s.push('On both sides: ' + plan.overlap + ' (each kept on one side at random).');
  if (plan.oddRemoved > 0) s.push('One match was removed at random so the tickets are equal.');
  if (plan.reason) s.push(plan.reason);
  s.push('Random on every run. No accuracy is promised. These are rule-based picks.');
  const summary = s.join('\n');

  if (plan.reason) return [summary];
  return packTicket('TICKET 1', plan.ticket1)
    .concat(packTicket('TICKET 2', plan.ticket2))
    .concat([summary]);
}
