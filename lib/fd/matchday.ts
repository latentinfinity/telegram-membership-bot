// lib/fd/matchday.ts
// PURE: reads one matchday (game week) of one competition and describes it.
// "Day" always means the Nigerian calendar day (UTC+1).

import type { FdMatch } from './stats';

export type MdMatch = FdMatch & {
  matchday?: number | null;
  stage?: string;
  group?: string | null;
};

// Finished, awarded, postponed or cancelled: nothing more to wait for.
export const RESOLVED = ['FINISHED', 'AWARDED', 'POSTPONED', 'CANCELLED'];

// A match this long after kickoff and still unresolved is "overdue":
// it does not hold the next matchday back.
export const OVERDUE_HOURS = 6;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function nigeriaDay(utcDate: string): string {
  const d = new Date(Date.parse(utcDate) + 3600000);
  return d.toISOString().slice(0, 10) + ' ' + WEEKDAYS[d.getUTCDay()];
}

export function isOverdue(m: MdMatch, nowMs: number): boolean {
  return RESOLVED.indexOf(m.status) === -1 && Date.parse(m.utcDate) + OVERDUE_HOURS * 3600000 < nowMs;
}

export type MatchdaySummary = {
  count: number;
  matchdays: (number | null)[];
  stages: string[];
  statuses: Record<string, number>;
  null_matchday: number;
  teams: number;
  teams_twice: string[];
  first_kickoff: string | null;
  last_kickoff: string | null;
  days: { day: string; matches: number }[];
  overdue: { id: number; match: string; kickoff: string; status: string }[];
  postponed: { id: number; match: string; kickoff: string }[];
  all_resolved: boolean;
  // last kickoff of the played matches + 6 hours: when the next matchday may start
  gate_opens_at: string | null;
};

function label(m: MdMatch): string {
  return (m.homeTeam.name || m.homeTeam.id) + ' - ' + (m.awayTeam.name || m.awayTeam.id);
}

export function summariseMatchday(matches: MdMatch[], nowMs: number): MatchdaySummary {
  const statuses: Record<string, number> = {};
  const mdSet = new Set<number | null>();
  const stageSet = new Set<string>();
  const teamCount = new Map<number, { n: number; name: string }>();
  const dayCount = new Map<string, number>();
  let nullMd = 0;
  const overdue: MatchdaySummary['overdue'] = [];
  const postponed: MatchdaySummary['postponed'] = [];
  let first = Infinity;
  let last = -Infinity;
  let lastPlayed = -Infinity;
  let allResolved = true;

  for (const m of matches) {
    statuses[m.status] = (statuses[m.status] || 0) + 1;
    const md = m.matchday === undefined ? null : m.matchday;
    if (md === null) nullMd++;
    mdSet.add(md);
    if (m.stage) stageSet.add(m.stage);
    for (const t of [m.homeTeam, m.awayTeam]) {
      const e = teamCount.get(t.id) || { n: 0, name: t.name || String(t.id) };
      e.n++;
      teamCount.set(t.id, e);
    }
    const ts = Date.parse(m.utcDate);
    if (ts < first) first = ts;
    if (ts > last) last = ts;
    const day = nigeriaDay(m.utcDate);
    dayCount.set(day, (dayCount.get(day) || 0) + 1);
    if (m.status === 'POSTPONED') postponed.push({ id: m.id, match: label(m), kickoff: m.utcDate });
    else if (ts > lastPlayed) lastPlayed = ts;
    if (RESOLVED.indexOf(m.status) === -1) allResolved = false;
    if (isOverdue(m, nowMs)) overdue.push({ id: m.id, match: label(m), kickoff: m.utcDate, status: m.status });
  }

  const twice: string[] = [];
  teamCount.forEach((e) => {
    if (e.n > 1) twice.push(e.name);
  });
  const days = Array.from(dayCount.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((e) => ({ day: e[0], matches: e[1] }));

  return {
    count: matches.length,
    matchdays: Array.from(mdSet),
    stages: Array.from(stageSet),
    statuses,
    null_matchday: nullMd,
    teams: teamCount.size,
    teams_twice: twice,
    first_kickoff: matches.length ? new Date(first).toISOString() : null,
    last_kickoff: matches.length ? new Date(last).toISOString() : null,
    days,
    overdue,
    postponed,
    all_resolved: allResolved,
    gate_opens_at: lastPlayed > -Infinity ? new Date(lastPlayed + OVERDUE_HOURS * 3600000).toISOString() : null,
  };
}
