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
  over25: Pick[]; over35: Pick[]; teamO15: Pick[]; teamO05: Pick[]; btts: Pick[];
  premium: { over25: Pick[]; over35: Pick[]; teamO25: Pick[]; teamO15: Pick[]; teamO05: Pick[]; btts: Pick[] };
};
export type Skipped = { id: number; reason: string };

export const MODERATE = 50;
export const HIGH = 65;

export function buildLists(fixtures: FixtureIn[]): { lists: Lists; skipped: Skipped[] } {
  const L: Lists = {
    over25: [], over35: [], teamO15: [], teamO05: [], btts: [],
    premium: { over25: [], over35: [], teamO25: [], teamO15: [], teamO05: [], btts: [] },
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

    const inO15 = (v: { goals: number; lam: number }) => v.goals >= 2 && pctAtLeast(2, v.lam) >= MODERATE;
    const inO05 = (v: { goals: number; lam: number }) =>
      !inO15(v) && v.goals >= 1 && pctAtLeast(1, v.lam) >= MODERATE;
    const bttsTeam = (v: { goals: number; lam: number }) =>
      inO15(v) || (v.goals === 1 && pctAtLeast(1, v.lam) >= HIGH);

    const o25 = H.goals >= 2 && A.goals >= 2;
    const o35 = (H.goals >= 3 && A.goals >= 2) || (A.goals >= 3 && H.goals >= 2);
    const bt = bttsTeam(H) && bttsTeam(A);
    if (o25) L.over25.push({ fixture: f });
    if (o35) L.over35.push({ fixture: f });
    if (bt) L.btts.push({ fixture: f });

    const sides: ['home' | 'away', typeof H][] = [['home', H], ['away', A]];
    for (const [side, v] of sides) {
      const n15 = inO15(v), n05 = inO05(v);
      if (n15) L.teamO15.push({ fixture: f, team: side });
      else if (n05) L.teamO05.push({ fixture: f, team: side });
      if (hasScores && (n15 || n05)) {
        const g = side === 'home' ? Math.min(f.f1h!, f.f2h!) : Math.min(f.f1a!, f.f2a!);
        if (g >= 4) L.premium.teamO25.push({ fixture: f, team: side });
        else if (g >= 3) L.premium.teamO15.push({ fixture: f, team: side });
        else if (g >= 2) L.premium.teamO05.push({ fixture: f, team: side });
      }
    }
    if (hasScores) {
      const t1 = f.f1h! + f.f1a!, t2 = f.f2h! + f.f2a!;
      if (o25 && t1 >= 5 && t2 >= 5) L.premium.over25.push({ fixture: f });
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
