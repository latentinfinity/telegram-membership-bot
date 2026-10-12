// lib/fd/stats.ts
// PURE: no network, no database. Turns finished matches into per-team
// season totals and averages (same rounding as the proven reference:
// Number((total / n).toFixed(2))).

export type FdTeamRef = { id: number; name?: string };

export type FdMatch = {
  id: number;
  utcDate: string;
  status: string;
  homeTeam: FdTeamRef;
  awayTeam: FdTeamRef;
  score?: { fullTime?: { home: number | null; away: number | null } };
  competition?: { code?: string; type?: string };
};

export type TeamTotals = {
  teamId: number;
  name: string;
  played: number;
  scored: number;
  conceded: number;
};

export type TeamAverage = TeamTotals & {
  avgScored: number | null;
  avgConceded: number | null;
};

export function round2(total: number, n: number): number | null {
  if (n <= 0) return null;
  return Number((total / n).toFixed(2));
}

// A match counts only if it is FINISHED and both full-time scores exist.
function readScore(m: FdMatch): { h: number; a: number } | null {
  if (m.status !== 'FINISHED') return null;
  const h = m.score?.fullTime?.home;
  const a = m.score?.fullTime?.away;
  if (h === null || h === undefined || a === null || a === undefined) return null;
  return { h, a };
}

export function totalsByTeam(matches: FdMatch[]): Map<number, TeamTotals> {
  const map = new Map<number, TeamTotals>();
  function row(t: FdTeamRef): TeamTotals {
    let r = map.get(t.id);
    if (!r) {
      r = { teamId: t.id, name: t.name || String(t.id), played: 0, scored: 0, conceded: 0 };
      map.set(t.id, r);
    }
    return r;
  }
  for (const m of matches) {
    const s = readScore(m);
    if (!s) continue;
    const home = row(m.homeTeam);
    const away = row(m.awayTeam);
    home.played++;
    home.scored += s.h;
    home.conceded += s.a;
    away.played++;
    away.scored += s.a;
    away.conceded += s.h;
  }
  return map;
}

export function averagesByTeam(matches: FdMatch[]): Map<number, TeamAverage> {
  const out = new Map<number, TeamAverage>();
  totalsByTeam(matches).forEach(function (t, id) {
    out.set(id, {
      ...t,
      avgScored: round2(t.scored, t.played),
      avgConceded: round2(t.conceded, t.played),
    });
  });
  return out;
}

// Season bounds are dates ("2026-05-24"). The whole end day counts.
export function isWithinSeason(utcDate: string, startDate: string, endDate: string): boolean {
  const d = new Date(utcDate).getTime();
  const start = new Date(startDate).getTime();
  const endExclusive = new Date(endDate).getTime() + 24 * 60 * 60 * 1000;
  return d >= start && d < endExclusive;
}
