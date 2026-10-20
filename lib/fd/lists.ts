// PURE. Normal and premium list selection.
import { toHundredths, teamView, pctAtLeast } from './teamOver';

export type FixtureIn = {
  id: number; comp: string; compName: string; stage: string; matchDate: string;
  home: string; away: string;
  hs: number | string | null; hc: number | string | null;
  asc: number | string | null; ac: number | string | null;
  f1h: number | null; f1a: number | null; f2h: number | null; f2a: number | null;
};
export type Pick = { fixture: FixtureIn; team?: 'home' | 'away' };
export type Lists = {
  over25: Pick[]; over15: Pick[]; over35: Pick[]; teamO15: Pick[]; teamO05: Pick[]; btts: Pick[];
  premium: { over25: Pick[]; over15: Pick[]; over35: Pick[]; teamO25: Pick[]; teamO15: Pick[]; teamO05: Pick[]; btts: Pick[] };
};
export type Skipped = { id: number; reason: string };

export const MODERATE = 50;
export const HIGH = 65;
// Team Over 0.5 list: own line O0.5 and confidence of 65 or more (High)
export const O05_MIN = 65;

export function buildLists(fixtures: FixtureIn[]): { lists: Lists; skipped: Skipped[] } {
  const L: Lists = {
    over25: [], over15: [], over35: [], teamO15: [], teamO05: [], btts: [],
    premium: { over25: [], over15: [], over35: [], teamO25: [], teamO15: [], teamO05: [], btts: [] },
  };
  const skipped: Skipped[] = [];
  for (const f of sortFixtures(fixtures)) {
    const hs = toHundredths(f.hs), hc = toHundredths(f.hc), as_ = toHundredths(f.asc), ac = toHundredths(f.ac);
    if (hs === null || hc === null || as_ === null || ac === null) {
      skipped.push({ id: f.id, reason: 'averages missing' });
      continue;
    }
    const H = teamView(hs, ac); // home: own scored, away conceded
    const A = teamView(as_, hc); // away: own scored, home conceded
    const hasScores = f.f1h !== null && f.f1a !== null && f.f2h !== null && f.f2a !== null;

    type V = { goals: number; lam: number };
    // Team Over 1.5 list: line O1.5 or higher and High (65+) at 2 goals
    const teamHigh15 = (v: V) => v.goals >= 2 && pctAtLeast(2, v.lam) >= HIGH;
    // Moderate (50+) at 2 goals: used by Over 2.5, Over 3.5 and BTTS Yes
    const mod15 = (v: V) => v.goals >= 2 && pctAtLeast(2, v.lam) >= MODERATE;
    // Moderate (50+) at 3 goals, line O2.5 or higher: used by Over 3.5
    const mod25 = (v: V) => v.goals >= 3 && pctAtLeast(3, v.lam) >= MODERATE;
    // Team Over 0.5 list: the team's OWN line is O0.5 and 65+ (High) at 1 goal. No other team ever lands here.
    const team05 = (v: V) => v.goals === 1 && pctAtLeast(1, v.lam) >= O05_MIN;

    // Over 2.5: both teams have a line of O1.5 or higher (no confidence check)
    const o25 = H.goals >= 2 && A.goals >= 2;
    // Over 1.5: one team is Team Over 1.5 (list rule), the other is Team Over 0.5 (list rule)
    const o15 = (teamHigh15(H) && team05(A)) || (teamHigh15(A) && team05(H));
    const o35 = (mod25(H) && mod15(A)) || (mod25(A) && mod15(H));
    const bt = (mod15(H) || team05(H)) && (mod15(A) || team05(A));
    if (o25) L.over25.push({ fixture: f });
    if (o15) L.over15.push({ fixture: f });
    if (o35) L.over35.push({ fixture: f });
    if (bt) L.btts.push({ fixture: f });

    const sides: ['home' | 'away', typeof H][] = [['home', H], ['away', A]];
    for (const [side, v] of sides) {
      const n15 = teamHigh15(v), n05 = team05(v);
      if (n15) L.teamO15.push({ fixture: f, team: side });
      else if (n05) L.teamO05.push({ fixture: f, team: side });
      // premium only FILTERS the normal list the team is already in (never re-files it)
      if (hasScores) {
        const g = side === 'home' ? Math.min(f.f1h!, f.f2h!) : Math.min(f.f1a!, f.f2a!);
        if (n15 && g >= 3) L.premium.teamO15.push({ fixture: f, team: side });
        else if (n05 && g >= 2) L.premium.teamO05.push({ fixture: f, team: side });
      }
    }
    if (hasScores) {
      const t1 = f.f1h! + f.f1a!, t2 = f.f2h! + f.f2a!;
      if (o25 && t1 >= 4 && t2 >= 4) L.premium.over25.push({ fixture: f });
      if (o15 && t1 >= 3 && t2 >= 3) L.premium.over15.push({ fixture: f });
      if (o35 && t1 >= 6 && t2 >= 6) L.premium.over35.push({ fixture: f });
      if (bt && Math.min(f.f1h!, f.f1a!, f.f2h!, f.f2a!) >= 2) L.premium.btts.push({ fixture: f });
    }
  }
  return { lists: L, skipped };
}

// competition (earliest kickoff first), then kickoff, then id (home before away is handled by push order)
export function sortFixtures(fx: FixtureIn[]): FixtureIn[] {
  const first: Record<string, number> = {};
  for (const f of fx) {
    const t = Date.parse(f.matchDate);
    if (first[f.comp] === undefined || t < first[f.comp]) first[f.comp] = t;
  }
  return [...fx].sort((a, b) =>
    first[a.comp] - first[b.comp] ||
    (a.comp < b.comp ? -1 : a.comp > b.comp ? 1 : 0) ||
    Date.parse(a.matchDate) - Date.parse(b.matchDate) ||
    a.id - b.id);
}
