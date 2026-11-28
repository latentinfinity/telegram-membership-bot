// lib/fd/track.ts - Tracking: average ranking numbers of what came true, and the lift against the rest.
// League matches only (pasted matches have no results). Read only, except copyTracked().
//   copyTracked(): copies newly graded fd_fixtures rows into fd_track (permanent: only the
//   four averages and the real score), so the 30-day cleanup never loses them.
//   WIN: every side's main point; won = that team scored more. RX 2+ sides: rx value.
//   STAR: RX 2+ sides whose X:Y number (Score 2 x average scored, rounded half up) was bigger than
//   the opponent's. Reports how often star sides won, against RX sides without a star.
//   HEART: RX 2+ sides whose T (trust) was 60 or more (60 included), the same rule as the ranking
//   list. Reports how often heart sides won, how often sides with BOTH star and heart won, and
//   sides without a heart for comparison (including sides with no heart result).
//   BOOM (💥): RX 2+ sides whose Neo rate was 2 or more (2 included), the same rule as the
//   ranking list (boomQualifies). Home side: Neo Home / Neo Away. Away side:
//   Neo Away / Neo Home. Reports how often 💥 sides won (the accuracy), and how often
//   sides with star, heart AND 💥 together won.
//   TRUST: tracked on its own, not decided by the star or the heart. Every RX 2+ side that has a
//   heart rate gets T (trustT from rx and the heart rate). Reports how often the sides with
//   T of 60 or more (60 included) won.
//   DRAW: matches in the Draw list, difference |Home point - Away point|; hit = ended level.
//   GG + OVER 2.5: matches in the GG + Over 2.5 list of the ranking (ggOverQualifies: Neo
//   Home 1.7+, Neo Away 1.7+, NeoSum 3.5+). Hit = both teams scored (1+ goal each) AND 3 or more
//   goals. Also reports, for the same matches, how often both teams scored (GG alone) and how
//   often they went Over 2.5 alone.
//   NEOSUM 4.5+: matches with NeoSum (Neo Home + Neo Away) of 4.5 or more (4.5 included, exact
//   integer maths via neoParts400). Reports how often they produced Over 3.5 (4+ goals).
//   NEOSUM 4+: matches with NeoSum of 4 or more (4 included, exact integer maths).
//   Reports how often they produced Over 2.5 (3+ goals).
//   f 4+ AND NEOSUM 4+: matches where BOTH f is 4.00 or more (4 included) AND NeoSum is 4 or
//   more (4 included). Reports how often they produced Over 3.5 (4+ goals) and Over 2.5
//   (3+ goals).
//   C: A = (6/7)*min(ac,hc) + (1/7)*max(ac,hc), B = (6/7)*min(as,hs) + (1/7)*max(as,hs),
//   C = 100 * sqrt(A*B) / (1 + sqrt(A*B)). Exact integer maths (A and B in 1/700 units):
//   C > 60 <=> A*B > 2.25, C >= 65 <=> A*B >= 169/49.
//   C > 60 (strictly greater) and f 3+ (f 3.00 or more) -> how often Over 2.5 (3+ goals).
//   C >= 65 (65 included) and f 4+ (f 4.00 or more) -> how often Over 3.5 (4+ goals).
//   OVER: Score, Score 2, Value 1, Value 2 (rate x score); hit = 3 or more goals.
//   OVER P: Neo Home = (1/4)*max(hs,ac) + (3/4)*min(hs,ac),
//   Neo Away = (1/4)*max(as,hc) + (3/4)*min(as,hc), NeoSum = Neo Home + Neo Away.
//   A = f (2 decimals), B = NeoSum,
//   P = 100 * sqrt(A*B) / (1 + sqrt(A*B)). Tracked only.
//   P 80+ -> how often Over 3.5 (4+ goals) and how often Over 2.5 (3+ goals).
//   P 70+ -> how often Over 2.5 (3+ goals).
//   P 70+ and f 4+ (f 4.00 or more) -> how often Over 3.5 and Over 2.5.
//   Each threshold includes its own number.
//   LIFT = Main / (Main + Others) x 100, where Main = average of the ones that came true and
//   Others = average of the rest. 50 = no difference.
//   f BANDS: f = Score 2 x total scored (2 decimals). Band 3+ = 3.00 to 3.99, 4+ = 4.00 to 4.99,
//   5+ = 5.00 and above. Reports how often each band produced Over 1.5 (2+ goals),
//   Over 2.5 (3+ goals) and Over 3.5 (4+ goals).
//   h LIST: matches that made the football h list (f 3.00 or more and h 3.00 or more, h = f x g).
//   Reports how often they produced Over 2.5 (3+ goals) and Over 3.5 (4+ goals).
import { createAdminClient } from '@/lib/supabase/admin';
import {
  homePoint,
  awayPoint,
  overScore,
  overScore2,
  overRate,
  rxQualifies,
  boomQualifies,
  ggOverQualifies,
  neoParts400,
  isDraw,
  fHundredths,
  hHundredths,
  score2Xy,
  heartRates,
  trustT,
} from '@/lib/fd/ranking';

const PAGE = 1000;
const MAX_PAGES = 40;
const SMALL_SAMPLE = 30;
const COLS = 'fd_match_id, comp_code, hs, hc, asc_, ac, real_home, real_away';

function round2(n: number): number {
  return Number(n.toFixed(2));
}
function hundredths(n: number): number {
  return Math.round(round2(n) * 100);
}

// NeoSum for OVER P: Neo Home + Neo Away, each = (1/4)*max + (3/4)*min.
function newScore(hs: number, hc: number, as: number, ac: number): number {
  const home = 0.25 * Math.max(hs, ac) + 0.75 * Math.min(hs, ac);
  const away = 0.25 * Math.max(as, hc) + 0.75 * Math.min(as, hc);
  return home + away;
}

// P = 100 * sqrt(A*B) / (1 + sqrt(A*B)). null when A*B is not usable.
function pValue(a: number, b: number): number | null {
  const ab = a * b;
  if (!isFinite(ab) || ab < 0) return null;
  const s = Math.sqrt(ab);
  const p = (100 * s) / (1 + s);
  return isFinite(p) ? p : null;
}

// C: A = (6/7)*min(ac,hc) + (1/7)*max(ac,hc), B = (6/7)*min(as,hs) + (1/7)*max(as,hs).
// Returns A*7 and B*7 in hundredths (so in 1/700 units), exact integers.
//   aH7 = 6*min(acH,hcH) + max(acH,hcH),  bH7 = 6*min(asH,hsH) + max(asH,hsH).
// A*B = aH7*bH7 / 490000. C = 100*sqrt(A*B)/(1+sqrt(A*B)) is above 60 exactly when A*B > 2.25,
// that is aH7*bH7 > 1,102,500, and is 65 or more exactly when A*B >= 169/49, that is
// aH7*bH7 >= 1,690,000.
function cProduct700(hsH: number, hcH: number, asH: number, acH: number): number {
  const aH7 = 6 * Math.min(acH, hcH) + Math.max(acH, hcH);
  const bH7 = 6 * Math.min(asH, hsH) + Math.max(asH, hsH);
  return aH7 * bH7;
}

// ── Copy graded matches into the permanent table ──────────────────────────
export async function copyTracked(): Promise<{ ok: boolean; copied: number; error?: string }> {
  try {
    const supabase = createAdminClient();
    const g = await supabase
      .from('fd_fixtures')
      .select('fd_match_id, comp_code, match_date, hs, hc, asc_, ac, real_home, real_away')
      .eq('status', 'graded')
      .not('hs', 'is', null)
      .not('hc', 'is', null)
      .not('asc_', 'is', null)
      .not('ac', 'is', null)
      .not('real_home', 'is', null)
      .not('real_away', 'is', null)
      .limit(1000);
    if (g.error) return { ok: false, copied: 0, error: 'could not read graded fixtures' };
    const src = (g.data ?? []) as unknown as {
      fd_match_id: number;
      comp_code: string;
      match_date: string;
      hs: number | string;
      hc: number | string;
      asc_: number | string;
      ac: number | string;
      real_home: number;
      real_away: number;
    }[];
    if (src.length === 0) return { ok: true, copied: 0 };
    const rows = src.map((r) => ({
      fd_match_id: r.fd_match_id,
      comp_code: r.comp_code,
      match_date: r.match_date,
      hs: Number(r.hs),
      hc: Number(r.hc),
      asc_: Number(r.asc_),
      ac: Number(r.ac),
      real_home: r.real_home,
      real_away: r.real_away,
    }));
    const up = await supabase
      .from('fd_track')
      .upsert(rows, { onConflict: 'fd_match_id', ignoreDuplicates: true })
      .select('fd_match_id');
    if (up.error) return { ok: false, copied: 0, error: 'could not save the tracking rows' };
    return { ok: true, copied: (up.data ?? []).length };
  } catch (e) {
    console.error('copyTracked failed');
    return { ok: false, copied: 0, error: 'something went wrong' };
  }
}

// ── Reading ───────────────────────────────────────────────────────────────
type TrackRow = {
  fd_match_id: number;
  comp_code: string;
  hs: number | string;
  hc: number | string;
  asc_: number | string;
  ac: number | string;
  real_home: number;
  real_away: number;
};

async function fetchRows(
  code: string | null
): Promise<{ ok: true; rows: TrackRow[] } | { ok: false; error: string }> {
  try {
    const supabase = createAdminClient();
    const rows: TrackRow[] = [];
    for (let p = 0; p < MAX_PAGES; p++) {
      const from = p * PAGE;
      const res = code
        ? await supabase
            .from('fd_track')
            .select(COLS)
            .eq('comp_code', code)
            .order('fd_match_id', { ascending: true })
            .range(from, from + PAGE - 1)
        : await supabase
            .from('fd_track')
            .select(COLS)
            .order('fd_match_id', { ascending: true })
            .range(from, from + PAGE - 1);
      if (res.error) return { ok: false, error: 'could not read the tracking' };
      const part = (res.data ?? []) as unknown as TrackRow[];
      part.forEach((r) => rows.push(r));
      if (part.length < PAGE) break;
    }
    return { ok: true, rows };
  } catch (e) {
    console.error('track fetch failed');
    return { ok: false, error: 'something went wrong' };
  }
}

export type TrackComp = { code: string; name: string; count: number };

export async function listTrackComps(): Promise<
  { ok: true; comps: TrackComp[]; total: number } | { ok: false; error: string }
> {
  try {
    const supabase = createAdminClient();
    const counts: Record<string, number> = {};
    let total = 0;
    for (let p = 0; p < MAX_PAGES; p++) {
      const from = p * PAGE;
      const res = await supabase
        .from('fd_track')
        .select('comp_code')
        .order('fd_match_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (res.error) return { ok: false, error: 'could not read the tracking' };
      const part = (res.data ?? []) as unknown as { comp_code: string }[];
      part.forEach((r) => {
        counts[r.comp_code] = (counts[r.comp_code] ?? 0) + 1;
        total++;
      });
      if (part.length < PAGE) break;
    }
    const cp = await supabase.from('fd_competitions').select('code, name');
    const names: Record<string, string> = {};
    ((cp.data ?? []) as unknown as { code: string; name: string }[]).forEach((c) => {
      names[c.code] = c.name;
    });
    const comps: TrackComp[] = Object.keys(counts).map((code) => ({
      code,
      name: names[code] ? names[code] : code,
      count: counts[code],
    }));
    comps.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, comps, total };
  } catch (e) {
    console.error('track comps failed');
    return { ok: false, error: 'something went wrong' };
  }
}

// ── Averages ──────────────────────────────────────────────────────────────
type Acc = { n: number; won: number; sumWon: number; sumOther: number };
const newAcc = (): Acc => ({ n: 0, won: 0, sumWon: 0, sumOther: 0 });

function addTo(a: Acc, value: number, hit: boolean) {
  if (!isFinite(value)) return;
  a.n++;
  if (hit) {
    a.won++;
    a.sumWon += value;
  } else {
    a.sumOther += value;
  }
}
function avg(sum: number, n: number): string {
  return n > 0 ? (sum / n).toFixed(3) : '-';
}
function pct(a: Acc): string {
  return a.n > 0 ? Math.round((a.won * 100) / a.n) + '%' : '-';
}

// One line: the average of the ones that came true, and the lift against the rest.
// lift = Main / (Main + Others) x 100. 50 = no difference.
function line(label: string, a: Acc, hitWord: string, _otherWord: string): string {
  const otherN = a.n - a.won;
  let lift = '-';
  if (a.won > 0 && otherN > 0) {
    const main = a.sumWon / a.won;
    const others = a.sumOther / otherN;
    const t = main + others;
    if (t > 0) lift = ((main / t) * 100).toFixed(1);
  }
  return label + '   ' + hitWord + ' ' + avg(a.sumWon, a.won) + ' | lift ' + lift + '   (n ' + a.n + ')';
}

// f band counters: how many matches, and how many had 2+, 3+ and 4+ goals.
type FBand = { n: number; o15: number; o25: number; o35: number };
const newBand = (): FBand => ({ n: 0, o15: 0, o25: 0, o35: 0 });
function fpct(hits: number, n: number): string {
  return n > 0 ? Math.round((hits * 100) / n) + '% (' + hits + ' of ' + n + ')' : '-';
}

// Win counter for RX sides (star, heart, both, none, trust, boom). Also used for the GG, NeoSum, C and OVER P counters.
type WinCount = { n: number; won: number };
const newWin = (): WinCount => ({ n: 0, won: 0 });
function addWin(w: WinCount, won: boolean) {
  w.n++;
  if (won) w.won++;
}

export async function trackMessages(
  code: string | null
): Promise<{ ok: true; messages: string[] } | { ok: false; error: string }> {
  try {
    let name = 'All leagues';
    if (code !== null) {
      const supabase = createAdminClient();
      const cp = await supabase.from('fd_competitions').select('name').eq('code', code).maybeSingle();
      name =
        cp.data && typeof (cp.data as { name?: string }).name === 'string'
          ? (cp.data as { name: string }).name
          : code;
    }
    const got = await fetchRows(code);
    if (!got.ok) return got;
    const rows = got.rows;

    const winAcc = newAcc();
    const rxAcc = newAcc();
    const drawAcc = newAcc();
    const s1 = newAcc();
    const s2 = newAcc();
    const v1 = newAcc();
    const v2 = newAcc();
    const f3 = newBand();
    const f4 = newBand();
    const f5 = newBand();
    const hBand = newBand();
    const starSides = newWin();
    const noStarSides = newWin();
    const heartSides = newWin();
    const noHeartSides = newWin();
    const starHeartSides = newWin();
    const boomSides = newWin(); // RX 2+ sides with 💥 (Neo rate 2+)
    const starHeartBoomSides = newWin(); // RX 2+ sides with ⭐, ❤️ and 💥 together
    const trustSides = newWin();
    const ggBoth = newWin(); // GG + Over 2.5 list: both teams scored AND 3+ goals
    const ggOnly = newWin(); // same matches: both teams scored
    const ggOver25 = newWin(); // same matches: 3+ goals
    const neoSum45Over35 = newWin(); // NeoSum 4.5+ -> Over 3.5 (4+ goals)
    const neoSum4Over25 = newWin(); // NeoSum 4+ -> Over 2.5 (3+ goals)
    const fNeo4Over35 = newWin(); // f 4+ AND NeoSum 4+ -> Over 3.5 (4+ goals)
    const fNeo4Over25 = newWin(); // f 4+ AND NeoSum 4+ -> Over 2.5 (3+ goals)
    const c60f3Over25 = newWin(); // C > 60 and f 3+ -> Over 2.5 (3+ goals)
    const c65f4Over35 = newWin(); // C >= 65 and f 4+ -> Over 3.5 (4+ goals)
    const pOver35 = newWin(); // P 80+ -> Over 3.5
    const p80Over25 = newWin(); // P 80+ -> Over 2.5
    const pOver25 = newWin(); // P 70+ -> Over 2.5
    const pf4Over35 = newWin(); // P 70+ and f 4+ -> Over 3.5
    const pf4Over25 = newWin(); // P 70+ and f 4+ -> Over 2.5
    let matches = 0;
    let overCount = 0;
    let drawMatches = 0;
    let drawHits = 0;

    rows.forEach((r) => {
      const hs = round2(Number(r.hs));
      const hc = round2(Number(r.hc));
      const as = round2(Number(r.asc_));
      const ac = round2(Number(r.ac));
      if (![hs, hc, as, ac].every((n) => isFinite(n))) return;
      matches++;
      const hsH = hundredths(hs);
      const hcH = hundredths(hc);
      const asH = hundredths(as);
      const acH = hundredths(ac);
      const rh = r.real_home;
      const ra = r.real_away;
      const hp = homePoint(hs, hc, as, ac);
      const ap = awayPoint(hs, hc, as, ac);
      const homeWon = rh > ra;
      const awayWon = ra > rh;

      addTo(winAcc, hp, homeWon);
      addTo(winAcc, ap, awayWon);
      const q = rxQualifies(hsH, hcH, asH, acH);
      if (q.home) addTo(rxAcc, hp / ap, homeWon);
      if (q.away) addTo(rxAcc, ap / hp, awayWon);

      // Star, heart, 💥 and trust for RX 2+ sides. The heart is T of 60 or more (60 included),
      // the same rule as the ranking list. 💥 is the Neo rate of 2 or more (boomQualifies).
      // Trust is also counted on its own.
      if (q.home || q.away) {
        const xy = score2Xy(hsH, hcH, asH, acH);
        const hr = heartRates(hsH, hcH, asH, acH);
        const bm = boomQualifies(hsH, hcH, asH, acH);
        if (q.home) {
          const t = hr !== null ? trustT(hp / ap, hr.rateHome) : null;
          const star = xy.x > xy.y;
          const heart = t !== null && t >= 60;
          const boom = bm.home;
          addWin(star ? starSides : noStarSides, homeWon);
          addWin(heart ? heartSides : noHeartSides, homeWon);
          if (star && heart) addWin(starHeartSides, homeWon);
          if (boom) addWin(boomSides, homeWon);
          if (star && heart && boom) addWin(starHeartBoomSides, homeWon);
          if (t !== null && t >= 60) addWin(trustSides, homeWon);
        }
        if (q.away) {
          const t = hr !== null ? trustT(ap / hp, hr.rateAway) : null;
          const star = xy.y > xy.x;
          const heart = t !== null && t >= 60;
          const boom = bm.away;
          addWin(star ? starSides : noStarSides, awayWon);
          addWin(heart ? heartSides : noHeartSides, awayWon);
          if (star && heart) addWin(starHeartSides, awayWon);
          if (boom) addWin(boomSides, awayWon);
          if (star && heart && boom) addWin(starHeartBoomSides, awayWon);
          if (t !== null && t >= 60) addWin(trustSides, awayWon);
        }
      }

      if (isDraw(hsH, hcH, asH, acH)) {
        drawMatches++;
        const level = rh === ra;
        if (level) drawHits++;
        addTo(drawAcc, Math.abs(hp - ap), level);
      }

      const goals = rh + ra;
      const over = goals >= 3;
      if (over) overCount++;

      // GG + OVER 2.5: matches in the ranking's GG + Over 2.5 list.
      // Hit = both teams scored AND 3+ goals. Also counted: GG alone and Over 2.5 alone.
      if (ggOverQualifies(hsH, hcH, asH, acH)) {
        const bothScored = rh >= 1 && ra >= 1;
        addWin(ggBoth, bothScored && over);
        addWin(ggOnly, bothScored);
        addWin(ggOver25, over);
      }

      const fH = fHundredths(hs, hc, as, ac);

      // NEOSUM: NeoSum in 1/400 (exact integers). 4.5 = 1800, 4 = 1600, both included.
      // NeoSum 4.5+ -> Over 3.5 (4+ goals). NeoSum 4+ -> Over 2.5 (3+ goals).
      // f 4+ (fH 400 or more) AND NeoSum 4+ -> Over 3.5 and Over 2.5.
      const neo = neoParts400(hsH, hcH, asH, acH);
      const neoSum400 = neo.home + neo.away;
      if (neoSum400 >= 1800) {
        addWin(neoSum45Over35, goals >= 4);
      }
      if (neoSum400 >= 1600) {
        addWin(neoSum4Over25, goals >= 3);
        if (fH >= 400) {
          addWin(fNeo4Over35, goals >= 4);
          addWin(fNeo4Over25, goals >= 3);
        }
      }

      // C: C > 60 and f 3+ (fH 300 or more) -> Over 2.5. C >= 65 and f 4+ (fH 400 or more) -> Over 3.5.
      // Exact: C > 60 <=> product > 1,102,500. C >= 65 <=> product >= 1,690,000 (product = A*7 x B*7, hundredths).
      const cProd = cProduct700(hsH, hcH, asH, acH);
      if (cProd > 1102500 && fH >= 300) {
        addWin(c60f3Over25, goals >= 3);
      }
      if (cProd >= 1690000 && fH >= 400) {
        addWin(c65f4Over35, goals >= 4);
      }

      const sc1 = overScore(hs, hc, as, ac);
      const sc2 = overScore2(hs, hc, as, ac);
      addTo(s1, sc1, over);
      addTo(s2, sc2, over);
      const rate = overRate(hcH + acH, hsH + asH);
      if (rate !== null) {
        addTo(v1, rate * sc1, over);
        addTo(v2, rate * sc2, over);
      }

      // OVER P: A = f (2 decimals), B = NeoSum.
      // P 80+ -> Over 3.5 and Over 2.5. P 70+ -> Over 2.5. P 70+ and f 4+ -> Over 3.5 and Over 2.5.
      const overP = pValue(fH / 100, newScore(hs, hc, as, ac));
      if (overP !== null) {
        if (overP >= 80) {
          addWin(pOver35, goals >= 4);
          addWin(p80Over25, goals >= 3);
        }
        if (overP >= 70) {
          addWin(pOver25, goals >= 3);
          if (fH >= 400) {
            addWin(pf4Over35, goals >= 4);
            addWin(pf4Over25, goals >= 3);
          }
        }
      }

      // f bands: 5+ (5.00 and above), 4+ (4.00 to 4.99), 3+ (3.00 to 3.99).
      if (fH >= 500) {
        f5.n++;
        if (goals >= 4) f5.o35++;
      } else if (fH >= 400) {
        f4.n++;
        if (goals >= 4) f4.o35++;
        if (goals >= 3) f4.o25++;
      } else if (fH >= 300) {
        f3.n++;
        if (goals >= 3) f3.o25++;
        if (goals >= 2) f3.o15++;
      }

      // h list: f 3.00 or more and h 3.00 or more (the matches that made the football h list).
      if (fH >= 300) {
        const hH = hHundredths(fH, hcH, acH);
        if (hH !== null && hH >= 300) {
          hBand.n++;
          if (goals >= 3) hBand.o25++;
          if (goals >= 4) hBand.o35++;
        }
      }
    });

    if (matches === 0) {
      return {
        ok: true,
        messages: ['TRACKING - ' + name + '\n\nNo finished matches are tracked here yet. Matches appear after they are graded.'],
      };
    }

    const out: string[] = [];
    out.push('TRACKING - ' + name);
    out.push('Matches tracked: ' + matches + (matches < SMALL_SAMPLE ? '  (small sample, under ' + SMALL_SAMPLE + ': averages can jump)' : ''));
    out.push('');
    out.push('WIN (a side wins when its team scored more)');
    out.push('Sides: ' + winAcc.n + ', won ' + winAcc.won + ' (' + pct(winAcc) + ')');
    out.push(line('Score', winAcc, 'winners', 'others'));
    out.push('RX 2+ sides: ' + rxAcc.n + ', won ' + rxAcc.won + ' (' + pct(rxAcc) + ')');
    out.push(line('RX   ', rxAcc, 'winners', 'others'));
    out.push('RX 2+ with ⭐: ' + starSides.n + ' sides, won ' + fpct(starSides.won, starSides.n));
    out.push('RX 2+ without ⭐: ' + noStarSides.n + ' sides, won ' + fpct(noStarSides.won, noStarSides.n));
    out.push('RX 2+ with ❤️: ' + heartSides.n + ' sides, won ' + fpct(heartSides.won, heartSides.n));
    out.push('RX 2+ with ⭐ and ❤️: ' + starHeartSides.n + ' sides, won ' + fpct(starHeartSides.won, starHeartSides.n));
    out.push('RX 2+ without ❤️: ' + noHeartSides.n + ' sides, won ' + fpct(noHeartSides.won, noHeartSides.n));
    out.push('RX 2+ with 💥: ' + boomSides.n + ' sides, won ' + fpct(boomSides.won, boomSides.n));
    out.push('RX 2+ with ⭐, ❤️ and 💥: ' + starHeartBoomSides.n + ' sides, won ' + fpct(starHeartBoomSides.won, starHeartBoomSides.n));
    out.push('');
    out.push('TRUST (T, on its own: any RX 2+ side with a heart rate, with or without ⭐ or ❤️)');
    out.push('RX 2+ with T 60+: ' + trustSides.n + ' sides, won ' + fpct(trustSides.won, trustSides.n));
    out.push('');
    out.push('DRAW');
    out.push('Draw list matches: ' + drawMatches + ', ended level ' + drawHits + ' (' + (drawMatches > 0 ? Math.round((drawHits * 100) / drawMatches) + '%' : '-') + ')');
    out.push(line('Difference', drawAcc, 'draws', 'others'));
    out.push('');
    out.push('GG + OVER 2.5 (both teams scored and 3 or more goals)');
    out.push('GG + Over 2.5 list matches: ' + ggBoth.n);
    out.push('  GG + Over 2.5: ' + fpct(ggBoth.won, ggBoth.n));
    out.push('  GG alone (both scored): ' + fpct(ggOnly.won, ggOnly.n));
    out.push('  Over 2.5 alone: ' + fpct(ggOver25.won, ggOver25.n));
    out.push('');
    out.push('NEOSUM (NeoSum = Neo Home + Neo Away)');
    out.push('NeoSum 4.5+ : ' + neoSum45Over35.n + ' matches');
    out.push('  Over 3.5: ' + fpct(neoSum45Over35.won, neoSum45Over35.n));
    out.push('NeoSum 4+ : ' + neoSum4Over25.n + ' matches');
    out.push('  Over 2.5: ' + fpct(neoSum4Over25.won, neoSum4Over25.n));
    out.push('f 4+ and NeoSum 4+ (both 4 or more): ' + fNeo4Over35.n + ' matches');
    out.push('  Over 3.5: ' + fpct(fNeo4Over35.won, fNeo4Over35.n));
    out.push('  Over 2.5: ' + fpct(fNeo4Over25.won, fNeo4Over25.n));
    out.push('');
    out.push('C (from the conceded and the scored averages)');
    out.push('C above 60 and f 3+: ' + c60f3Over25.n + ' matches');
    out.push('  Over 2.5: ' + fpct(c60f3Over25.won, c60f3Over25.n));
    out.push('C 65+ and f 4+: ' + c65f4Over35.n + ' matches');
    out.push('  Over 3.5: ' + fpct(c65f4Over35.won, c65f4Over35.n));
    out.push('');
    out.push('OVER 2.5 (3 or more goals)');
    out.push('Matches: ' + matches + ', went over ' + overCount + ' (' + Math.round((overCount * 100) / matches) + '%)');
    out.push(line('Score  ', s1, 'over', 'not over'));
    out.push(line('Score 2', s2, 'over', 'not over'));
    out.push(line('Value 1', v1, 'over', 'not over'));
    out.push(line('Value 2', v2, 'over', 'not over'));
    out.push('');
    out.push('f BANDS (f = Score 2 x total scored)');
    out.push('f 3+ (3.00 to 3.99): ' + f3.n + ' matches');
    out.push('  Over 2.5: ' + fpct(f3.o25, f3.n));
    out.push('  Over 1.5: ' + fpct(f3.o15, f3.n));
    out.push('f 4+ (4.00 to 4.99): ' + f4.n + ' matches');
    out.push('  Over 3.5: ' + fpct(f4.o35, f4.n));
    out.push('  Over 2.5: ' + fpct(f4.o25, f4.n));
    out.push('f 5+ (5.00 and above): ' + f5.n + ' matches');
    out.push('  Over 3.5: ' + fpct(f5.o35, f5.n));
    out.push('');
    out.push('h LIST (matches that made the h list: f 3.00+ and h 3.00+, h = f x g)');
    out.push('Matches: ' + hBand.n);
    out.push('  Over 2.5: ' + fpct(hBand.o25, hBand.n));
    out.push('  Over 3.5: ' + fpct(hBand.o35, hBand.n));
    out.push('');
    out.push('OVER P (P from f and NeoSum)');
    out.push('P 80+ : ' + pOver35.n + ' matches');
    out.push('  Over 3.5: ' + fpct(pOver35.won, pOver35.n));
    out.push('  Over 2.5: ' + fpct(p80Over25.won, p80Over25.n));
    out.push('P 70+ : ' + pOver25.n + ' matches');
    out.push('  Over 2.5: ' + fpct(pOver25.won, pOver25.n));
    out.push('P 70+ and f 4+ (f 4.00 or more): ' + pf4Over25.n + ' matches');
    out.push('  Over 3.5: ' + fpct(pf4Over35.won, pf4Over35.n));
    out.push('  Over 2.5: ' + fpct(pf4Over25.won, pf4Over25.n));
    out.push('');
    out.push('Lift = winners avg / (winners avg + others avg) x 100. 50 = no difference. Above 60 = the winners score clearly higher than the others.');
    out.push('Draw: a draw has a SMALL difference, so a lift below 50 is the good sign there.');
    out.push('⭐ = the side X:Y number was bigger than its opponent. ❤️ = T (trust) was 60 or more. 💥 = the Neo rate (Neo Home/Neo Away for a home side, Neo Away/Neo Home for an away side) was 2 or more. A draw counts as not winning.');
    out.push('GG + Over 2.5 list = Neo Home 1.7+, Neo Away 1.7+ and NeoSum 3.5+. GG = both teams scored at least 1 goal.');
    out.push('NeoSum 4.5+ = Neo Home + Neo Away of 4.5 or more (4.5 included). NeoSum 4+ = 4 or more (4 included). f 4+ = f of 4.00 or more (4 included).');
    out.push('C: A = 6/7 x smaller conceded + 1/7 x bigger conceded, B = 6/7 x smaller scored + 1/7 x bigger scored, C = P formula on A and B. C above 60 = strictly more than 60. C 65+ = 65 included. f 3+ = f of 3.00 or more, f 4+ = f of 4.00 or more.');
    out.push('Over 1.5 = 2+ goals, Over 2.5 = 3+ goals, Over 3.5 = 4+ goals.');
    out.push('NeoSum groups overlap: a match with NeoSum 4.5+ is also counted in NeoSum 4+, and f 4+ with NeoSum 4+ is a part of NeoSum 4+. The two C groups can overlap each other and the f bands. OVER P groups overlap too: a match with P 80+ is also counted in P 70+.');
    out.push('Averages of matches that already finished. No accuracy is promised.');
    return { ok: true, messages: [out.join('\n')] };
  } catch (e) {
    console.error('track messages failed');
    return { ok: false, error: 'something went wrong' };
  }
}
