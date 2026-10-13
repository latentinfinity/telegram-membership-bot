// lib/fd/plan.ts
// PURE: decides which matchday group is ready to be stored, and sorts the
// matches of a group into what must be inserted and what must not.
// A group is (stage, matchday): the Champions League reuses matchday 1 and 2
// in several stages, so the number alone is not unique.

import { OVERDUE_HOURS, RESOLVED, isOverdue } from './matchday';
import type { MdMatch } from './matchday';

export const UPCOMING = ['SCHEDULED', 'TIMED'];
const HOUR = 3600000;

export function stageOf(m: MdMatch): string {
  return m.stage || 'REGULAR_SEASON';
}
export function matchdayOf(m: MdMatch): number {
  return m.matchday === null || m.matchday === undefined ? 0 : m.matchday;
}
function keyOf(m: MdMatch): string {
  return stageOf(m) + '|' + matchdayOf(m);
}
function label(m: MdMatch): string {
  return (m.homeTeam.name || m.homeTeam.id) + ' - ' + (m.awayTeam.name || m.awayTeam.id);
}

export type GroupPlan = {
  stage: string;
  matchday: number;
  windowCount: number;
  firstKickoff: string;
  unseenFuture: number;
  eligible: boolean;
  blockedBy: string[]; // matches that must finish first
  opensAfter: string | null; // latest blocker kickoff + overdue hours
};

// `window` = every match (any status) between lookback and lookahead.
// `stored` = ids already saved. A group is a candidate only if it has at
// least one new, not-yet-started match. It is eligible when no match
// outside the group, kicking off before the group starts, is still
// waiting for its result (a delayed result stops waiting after 6 hours).
export function planGroups(window: MdMatch[], stored: Set<number>, nowMs: number): GroupPlan[] {
  const groups = new Map<string, MdMatch[]>();
  for (const m of window) {
    const k = keyOf(m);
    const g = groups.get(k);
    if (g) g.push(m);
    else groups.set(k, [m]);
  }

  const plans: GroupPlan[] = [];
  groups.forEach(function (ms, key) {
    const unseen = ms.filter(
      (m) => !stored.has(m.id) && UPCOMING.indexOf(m.status) !== -1 && Date.parse(m.utcDate) > nowMs
    );
    if (unseen.length === 0) return;
    let first = Infinity;
    for (const m of ms) first = Math.min(first, Date.parse(m.utcDate));

    const blockers: MdMatch[] = [];
    for (const o of window) {
      if (keyOf(o) === key) continue;
      if (Date.parse(o.utcDate) >= first) continue;
      if (RESOLVED.indexOf(o.status) !== -1) continue;
      if (isOverdue(o, nowMs)) continue;
      blockers.push(o);
    }
    let opens = -Infinity;
    for (const b of blockers) opens = Math.max(opens, Date.parse(b.utcDate) + OVERDUE_HOURS * HOUR);

    plans.push({
      stage: stageOf(ms[0]),
      matchday: matchdayOf(ms[0]),
      windowCount: ms.length,
      firstKickoff: new Date(first).toISOString(),
      unseenFuture: unseen.length,
      eligible: blockers.length === 0,
      blockedBy: blockers.slice(0, 5).map((b) => label(b) + ' (' + b.status + ')'),
      opensAfter: blockers.length ? new Date(opens).toISOString() : null,
    });
  });
  return plans.sort((a, b) => a.firstKickoff.localeCompare(b.firstKickoff));
}

export type GroupCounts = {
  fetched: number;
  inserted: number;
  already_stored: number;
  past_ignored: number; // finished or already started
  postponed: number;
  cancelled: number;
  other: number;
};

// Sorts every match of a fully fetched group into exactly one bucket, so
// the numbers always add up to what the API returned.
export function classifyGroup(
  matches: MdMatch[],
  stored: Set<number>,
  nowMs: number
): { toInsert: MdMatch[]; counts: GroupCounts } {
  const counts: GroupCounts = {
    fetched: matches.length, inserted: 0, already_stored: 0,
    past_ignored: 0, postponed: 0, cancelled: 0, other: 0,
  };
  const toInsert: MdMatch[] = [];
  for (const m of matches) {
    if (stored.has(m.id)) counts.already_stored++;
    else if (m.status === 'POSTPONED') counts.postponed++;
    else if (m.status === 'CANCELLED') counts.cancelled++;
    else if (UPCOMING.indexOf(m.status) !== -1 && Date.parse(m.utcDate) > nowMs) {
      counts.inserted++;
      toInsert.push(m);
    } else if (m.status === 'FINISHED' || Date.parse(m.utcDate) <= nowMs) counts.past_ignored++;
    else counts.other++;
  }
  return { toInsert, counts };
}

// Leagues: every team plays once per matchday, so a full matchday has
// teams / 2 matches. Knockout stages have no fixed size.
export function expectedSize(stage: string, teams: number): number | null {
  if (teams <= 0) return null;
  if (stage === 'REGULAR_SEASON' || stage === 'LEAGUE_STAGE') return Math.floor(teams / 2);
  return null;
}
