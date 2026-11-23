// lib/fd/track.ts - Tracking: average ranking numbers of what came true vs what did not.
// League matches only (pasted matches have no results). Read only, except copyTracked().
//   copyTracked(): copies newly graded fd_fixtures rows into fd_track (permanent: only the
//   four averages and the real score), so the 30-day cleanup never loses them.
//   WIN: every side's main point; won = that team scored more. RX 2+ sides: rx value.
//   DRAW: matches in the Draw list, difference |Home point - Away point|; hit = ended level.
//   OVER: Score, Score 2, Value 1, Value 2 (rate x score); hit = 3 or more goals.
import { createAdminClient } from '@/lib/supabase/admin';
import { homePoint, awayPoint, overScore, overScore2, overRate, rxQualifies, isDraw } from '@/lib/fd/ranking';

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
function line(label: string, a: Acc, hitWord: string, otherWord: string): string {
  return (
    label + '   ' + hitWord + ' ' + avg(a.sumWon, a.won) + ' | ' + otherWord + ' ' +
    avg(a.sumOther, a.n - a.won) + '   (n ' + a.n + ')'
  );
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

      if (isDraw(hsH, hcH, asH, acH)) {
        drawMatches++;
        const level = rh === ra;
        if (level) drawHits++;
        addTo(drawAcc, Math.abs(hp - ap), level);
      }

      const over = rh + ra >= 3;
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
    out.push('"Others" = sides or matches that did not win, did not end level, or did not go over.');
    out.push('Averages of matches that already finished. No accuracy is promised.');
    return { ok: true, messages: [out.join('\n')] };
  } catch (e) {
    console.error('track messages failed');
    return { ok: false, error: 'something went wrong' };
  }
}
