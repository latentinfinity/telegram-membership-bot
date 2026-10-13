// lib/fd/predictCalc.ts
// PURE: picks each team's averages (with the three fallback tiers), runs
// correctScore, and writes the stale note. No network, no database.

import { calibratedScores } from '../correctScore';
import { round2 } from './stats';

export type TierName = |
  'current_season' |
  'previous_season_same_competition' |
  'previous_season_any_league';

export type TotalsLite = { played: number;scored: number;conceded: number };
export type TeamAvg = { scored: number;conceded: number;played: number;tier: TierName };

function fromTotals(t: TotalsLite | undefined, tier: TierName): TeamAvg | null {
  if (!t || t.played <= 0) return null;
  const scored = round2(t.scored, t.played);
  const conceded = round2(t.conceded, t.played);
  if (scored === null || conceded === null) return null;
  return { scored, conceded, played: t.played, tier };
}

// Tier 1: this season in this competition, however few games (even 1).
// Tier 2: no games yet -> last season in the same competition.
// Tier 3: not there either (promoted team) -> last season in another
//         league, the row with the most games.
// null = no data anywhere (never guessed).
export function chooseAverages(
  current: TotalsLite | undefined,
  prevSame: TotalsLite | undefined,
  otherLeagues: TotalsLite[]
): TeamAvg | null {
  const t1 = fromTotals(current, 'current_season');
  if (t1) return t1;
  const t2 = fromTotals(prevSame, 'previous_season_same_competition');
  if (t2) return t2;
  let best: TotalsLite | undefined;
  for (const o of otherLeagues)
    if (o.played > 0 && (!best || o.played > best.played)) best = o;
  return fromTotals(best, 'previous_season_any_league');
}

export type MatchPrediction = {
  hs: number;
  hc: number;
  asc_: number;
  ac: number;
  home_tier: TierName;
  away_tier: TierName;
  f1_home: number;
  f1_away: number;
  f2_home: number;
  f2_away: number;
};

// The four numbers: home scored, home conceded, away scored, away conceded,
// each rounded to 2 decimals before correctScore sees them.
export function predictFromAverages(home: TeamAvg, away: TeamAvg): MatchPrediction | null {
  const cs = calibratedScores(
    home.scored.toFixed(2),
    home.conceded.toFixed(2),
    away.scored.toFixed(2),
    away.conceded.toFixed(2)
  );
  if (!cs) return null;
  return {
    hs: home.scored,
    hc: home.conceded,
    asc_: away.scored,
    ac: away.conceded,
    home_tier: home.tier,
    away_tier: away.tier,
    f1_home: cs.prod.home,
    f1_away: cs.prod.away,
    f2_home: cs.exp.home,
    f2_away: cs.exp.away,
  };
}

export type OverdueRow = {
  fd_match_id: number;
  home_id: number;
  away_id: number;
  home_name: string;
  away_name: string;
  match_date: string;
};

// A team is "behind" when one of its own matches in this competition has
// long since kicked off and the API has not resolved it yet.
export function staleNote(homeId: number, awayId: number, overdue: OverdueRow[]): string | null {
  const hits = overdue.filter(
    (o) => o.home_id === homeId || o.away_id === homeId || o.home_id === awayId || o.away_id === awayId
  );
  if (hits.length === 0) return null;
  return (
    'waiting for result: ' +
    hits
    .slice(0, 2)
    .map((o) => o.home_name + ' - ' + o.away_name + ' (' + o.match_date.slice(0, 10) + ')')
    .join('; ')
  ).slice(0, 200);
}
