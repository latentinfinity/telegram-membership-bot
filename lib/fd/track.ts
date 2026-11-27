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
//   TRUST: tracked on its own, not decided by the star or the heart. Every RX 2+ side that has a
//   heart rate gets T (trustT from rx and the heart rate). Reports how often the sides with
//   T of 60 or more (60 included) won.
//   DRAW: matches in the Draw list, difference |Home point - Away point|; hit = ended level.
//   OVER: Score, Score 2, Value 1, Value 2 (rate x score); hit = 3 or more goals.
//   OVER P: new score = Home + Away, Home = (1/4)*max(hs,ac) + (3/4)*min(hs,ac),
//   Away = (1/4)*max(as,hc) + (3/4)*min(as,hc). A = f (2 decimals), B = new score,
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

// New score for OVER P: Home + Away, each = (1/4)*max + (3/4)*min.
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

// Win counter for RX sides (star, heart, both, none, trust). Also used for the OVER P counters.
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
    const trustSides = newWin();
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

      // Star, heart and trust for RX 2+ sides. The heart is T of 60 or more (60 included),
      // the same rule as the ranking list. Trust is also counted on its own.
      if (q.home || q.away) {
        const xy = score2Xy(hsH, hcH, asH, acH);
        const hr = heartRates(hsH, hcH, asH, acH);
        if (q.home) {
          const t = hr !== null ? trustT(hp / ap, hr.rateHome) : null;
          const star = xy.x > xy.y;
          const heart = t !== null && t >= 60;
          addWin(star ? starSides : noStarSides, homeWon);
          addWin(heart ? heartSides : noHeartSides, homeWon);
          if (star && heart) addWin(starHeartSides, homeWon);
          if (t !== null && t >= 60) addWin(trustSides, homeWon);
        }
        if (q.away) {
          const t = hr !== null ? trustT(ap / hp, hr.rateAway) : null;
          const star = xy.y > xy.x;
          const heart = t !== null && t >= 60;
          addWin(star ? starSides : noStarSides, awayWon);
          addWin(heart ? heartSides : noHeartSides, awayWon);
          if (star && heart) addWin(starHeartSides, awayWon);
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
      const sc1 = overScore(hs, hc, as, ac);
      const sc2 = overScore2(hs, hc, as, ac);
      addTo(s1, sc1, over);
      addTo(s2, sc2, over);
      const rate = overRate(hcH + acH, hsH + asH);
      if (rate !== null) {
        addTo(v1, rate * sc1, over);
        addTo(v2, rate * sc2, over);
      }

      const fH = fHundredths(hs, hc, as, ac);

      // OVER P: A = f (2 decimals), B = new score.
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
    out.push('');
    out.push('TRUST (T, on its own: any RX 2+ side with a heart rate, with or without ⭐ or ❤️)');
    out.push('RX 2+ with T 60+: ' + trustSides.n + ' sides, won ' + fpct(trustSides.won, trustSides.n));
    out.push('');
    out.push('DRAW');
    out.push('Draw list matches: ' + drawMatches + ', ended level ' + drawHits + ' (' + (drawMatches > 0 ? Math.round((drawHits * 100) / drawMatches) + '%' : '-') + ')');
    out.push(line('Difference', drawAcc, 'draws', 'others'));
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
    out.push('OVER P (P from f and the new score)');
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
    out.push('⭐ = the side X:Y number was bigger than its opponent. ❤️ = T (trust) was 60 or more. A draw counts as not winning.');
    out.push('Over 1.5 = 2+ goals, Over 2.5 = 3+ goals, Over 3.5 = 4+ goals.');
    out.push('OVER P groups overlap: a match with P 80+ is also counted in P 70+.');
    out.push('Averages of matches that already finished. No accuracy is promised.');
    return { ok: true, messages: [out.join('\n')] };
  } catch (e) {
    console.error('track messages failed');
    return { ok: false, error: 'something went wrong' };
  }
}
