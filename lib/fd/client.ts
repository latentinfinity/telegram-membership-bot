// lib/fd/client.ts
// The ONLY file that talks to football-data.org (v4).
// - token from FOOTBALL_DATA_API_TOKEN
// - every call paced 6.5 s apart (free tier: 10 calls/minute)
// - 20 s timeout per call, 429 reported clearly
// Pacing is per serverless instance, so callers must run one at a time.

import type { FdMatch } from './stats';

const API_BASE = 'https://api.football-data.org/v4';
const INTERVAL_MS = 6500;
const REQUEST_TIMEOUT_MS = 20000;

let lastRequestAt = 0;
let chain: Promise<unknown> = Promise.resolve();

function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastRequestAt + INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

export type FdReply<T> = { data: T; requestsAvailable: number | null };

export async function fdGet<T>(path: string): Promise<FdReply<T>> {
  const token = process.env.FOOTBALL_DATA_API_TOKEN;
  if (!token) throw new Error('FOOTBALL_DATA_API_TOKEN is not set');

  return paced(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(API_BASE + path, {
        headers: { 'X-Auth-Token': token },
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (res.status === 429) throw new Error('rate limit (429) on ' + path);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error('football-data ' + res.status + ' on ' + path + ': ' + body.slice(0, 200));
      }
      const hdr = res.headers.get('x-requests-available-minute');
      const data = (await res.json()) as T;
      return { data, requestsAvailable: hdr === null ? null : Number(hdr) };
    } finally {
      clearTimeout(timer);
    }
  });
}

export function toISODate(d: Date): string {
  return d.toISOString().split('T')[0];
}

// ── Typed helpers ─────────────────────────────────────────────────────────
export type FdSeason = { id: number; startDate: string; endDate: string };
export type FdCompetition = {
  id: number;
  name: string;
  code: string;
  type: string;
  currentSeason?: FdSeason | null;
  seasons?: FdSeason[];
};

export function getCompetition(code: string) {
  return fdGet<FdCompetition>('/competitions/' + code);
}

export type FdMatchList = {
  resultSet?: { count?: number; first?: string; last?: string; played?: number };
  matches?: FdMatch[];
};

// All finished matches of one season in ONE call. season = start year.
export function getFinishedSeason(code: string, seasonYear: string) {
  return fdGet<FdMatchList>(
    '/competitions/' + code + '/matches?season=' + seasonYear + '&status=FINISHED'
  );
}

export function getScheduled(code: string, from: string, to: string) {
  return fdGet<FdMatchList>(
    '/competitions/' + code + '/matches?status=SCHEDULED&dateFrom=' + from + '&dateTo=' + to
  );
}

export type FdStandingRow = {
  team: { id: number; name?: string };
  playedGames: number;
  goalsFor: number;
  goalsAgainst: number;
};
export type FdStandings = {
  standings?: { type: string; table?: FdStandingRow[] }[];
};

export function getStandings(code: string, seasonYear: string) {
  return fdGet<FdStandings>('/competitions/' + code + '/standings?season=' + seasonYear);
}

// The proven per-team method (used only to cross-check the one-call method).
export function getTeamFinished(teamId: number, from: string, to: string) {
  return fdGet<FdMatchList>(
    '/teams/' + teamId + '/matches?status=FINISHED&limit=100&dateFrom=' + from + '&dateTo=' + to
  );
}
