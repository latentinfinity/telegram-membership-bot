// lib/fd/ranking.ts  (REPLACES the earlier version) - Rankings. Read only. Private chat only.
// Home point = ((hs / (1 + hc)) * ac) / (1 + as)
// Away point = ((as / (1 + ac)) * hc) / (1 + hs)
// Every side gets its own point; sides go in ONE list, highest first.
//   Only the top N sides are shown, where N = the number of matches (20 matches -> top 20).
// RX 2+ section (after the main list, before DRAW): Home rx = Home point / Away point,
//   Away rx = Away point / Home point. A side qualifies when its rx is 2 or more
//   (exact integer maths). If the opposing point is 0 the side is eliminated.
// DRAW section: a match qualifies when |Home point - Away point| is between 0.0 and 0.2,
//   both ends included (exact integer maths). Closest first. A match also gets a tick
//   when BOTH correct-score formulas (Formula 1 and Formula 2) predict a draw
//   (an equal score below 5; 5+ against 5+ is not counted as a draw).
// OVER RANKING section: r = ac/(1+hs) + hc/(1+as), t = hs + as, Score = r.
//   Groups are by t, compared EXACTLY (no rounding up). Each match is in ONE group only:
//   5+ (t >= 5), 4+ (4 <= t < 5), 3+ (3 <= t < 4). Below 3 is not listed (2+ removed).
//   Inside a group the order is by Score, highest first (not by t).
// OVER RANKING 2 section (after OVER RANKING): q = (ac/(1+hs)) / (hc/(1+as)),
//   Score = r + q (q = 0 when hc = 0). Same groups, but only the top 20 of each group.
// Part 1: one competition's stored pending matches (fd_fixtures).
// Part 2: the matches pasted into the storage (one list across all leagues).
import { createAdminClient } from '@/lib/supabase/admin';
import { calibratedScores } from '@/lib/correctScore';

const LIMIT = 3500;
const OVER2_TOP = 20;

export function homePoint(hs: number, hc: number, as: number, ac: number): number {
  return ((hs / (1 + hc)) * ac) / (1 + as);
}

export function awayPoint(hs: number, hc: number, as: number, ac: number): number {
  return ((as / (1 + ac)) * hc) / (1 + hs);
}

// Score = r = ac/(1+hs) + hc/(1+as).
export function overScore(hs: number, hc: number, as: number, ac: number): number {
  return ac / (1 + hs) + hc / (1 + as);
}

// Score 2 = r + q, where q = (ac/(1+hs)) / (hc/(1+as)). q = 0 when hc = 0.
export function overScore2(hs: number, hc: number, as: number, ac: number): number {
  const r = overScore(hs, hc, as, ac);
  const bottom = hc / (1 + as);
  const q = bottom > 0 ? ac / (1 + hs) / bottom : 0;
  return r + q;
}

type Side = { team: string; point: number; line: string; extra: string; order: number };
type RxItem = { team: string; rx: number; line: string; extra: string; order: number };
type DrawEntry = {
  label: string;
  home: number;
  away: number;
  diff: number;
  tick: boolean;
  extra: string;
  order: number;
};
type OverItem = {
  name: string;
  tHundredths: number; // t = hs + as in hundredths, exact
  score: number;
  score2: number;
  extra: string;
  order: number;
};

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function hundredths(n: number): number {
  return Math.round(round2(n) * 100);
}

// Exact test of |Home point - Away point| <= 0.2, with the four averages in hundredths.
//   Home point = hs*ac / ((100+hc)*(100+as))
//   Away point = as*hc / ((100+ac)*(100+hs))
//   |Nh/Dh - Na/Da| <= 1/5  <=>  5 * |Nh*Da - Na*Dh| <= Dh*Da
function isDraw(hs: number, hc: number, as: number, ac: number): boolean {
  const B = (n: number) => BigInt(n);
  const hundred = B(100);
  const nh = B(hs) * B(ac);
  const dh = (hundred + B(hc)) * (hundred + B(as));
  const na = B(as) * B(hc);
  const da = (hundred + B(ac)) * (hundred + B(hs));
  let cross = nh * da - na * dh;
  if (cross < B(0)) cross = -cross;
  return B(5) * cross <= dh * da;
}

// Exact RX test with the four averages in hundredths.
//   Home rx = Hp / Ap >= 2  <=>  Nh*Da >= 2*Na*Dh, and needs Ap > 0 (Na > 0)
//   Away rx = Ap / Hp >= 2  <=>  Na*Dh >= 2*Nh*Da, and needs Hp > 0 (Nh > 0)
function rxQualifies(hs: number, hc: number, as: number, ac: number): { home: boolean; away: boolean } {
  const B = (n: number) => BigInt(n);
  const zero = B(0);
  const two = B(2);
  const hundred = B(100);
  const nh = B(hs) * B(ac);
  const dh = (hundred + B(hc)) * (hundred + B(as));
  const na = B(as) * B(hc);
  const da = (hundred + B(ac)) * (hundred + B(hs));
  return {
    home: na > zero && nh * da >= two * na * dh,
    away: nh > zero && na * dh >= two * nh * da,
  };
}

// True when BOTH correct-score formulas predict a draw (equal score below 5).
function bothFormulasDraw(hs: number, hc: number, as: number, ac: number): boolean {
  const s = calibratedScores(hs.toFixed(2), hc.toFixed(2), as.toFixed(2), ac.toFixed(2));
  if (!s) return false;
  const prodDraw = s.prod.home === s.prod.away && s.prod.home < 5;
  const expDraw = s.exp.home === s.exp.away && s.exp.home < 5;
  return prodDraw && expDraw;
}

function kickoff(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
  });
}

function pack(header: string, entries: string[], footer: string): string[] {
  const messages: string[] = [];
  let current = header + '\n';
  entries.forEach((entry) => {
    const piece = '\n' + entry + '\n';
    if (current.length + piece.length > LIMIT && current.length > header.length + 2) {
      messages.push(current);
      current = header + ' (continued)\n';
    }
    current += piece;
  });
  if (footer) {
    if (current.length + footer.length + 2 > LIMIT) {
      messages.push(current);
      current = header + ' (continued)\n';
    }
    current += '\n' + footer;
  }
  messages.push(current);
  return messages;
}

// Highest sides first. Only the top N are returned, N = the number of matches (sides / 2).
function rankedEntries(sides: Side[]): string[] {
  const top = Math.floor(sides.length / 2);
  const sorted = sides
    .slice()
    .sort((a, b) => b.point - a.point || a.order - b.order)
    .slice(0, top);
  return sorted.map(
    (s, i) => i + 1 + ') ' + s.team + '   ' + s.point.toFixed(3) + '\n' + s.line + (s.extra ? '\n' + s.extra : '')
  );
}

// The RX 2+ section: one descending list, highest rx first.
function rxMessages(title: string, items: RxItem[]): string[] {
  const header = 'RX 2+ - ' + title + ' (' + items.length + ')';
  if (items.length === 0) return [header + '\nNone'];
  const sorted = items.slice().sort((a, b) => b.rx - a.rx || a.order - b.order);
  const entries = sorted.map(
    (x, i) => i + 1 + ') ' + x.team + '   rx ' + x.rx.toFixed(3) + '\n' + x.line + (x.extra ? '\n' + x.extra : '')
  );
  return pack(header, entries, '');
}

// The DRAW section: closest first (smallest difference on top).
function drawMessages(title: string, draws: DrawEntry[]): string[] {
  const header = 'DRAW - ' + title + ' (' + draws.length + ')';
  if (draws.length === 0) return [header + '\nNone'];
  const sorted = draws.slice().sort((a, b) => a.diff - b.diff || a.order - b.order);
  const entries = sorted.map(
    (d, i) =>
      i + 1 + ') ' + d.label + (d.tick ? ' ✅' : '') +
      '\nHome ' + d.home.toFixed(3) + ' | Away ' + d.away.toFixed(3) +
      ' | difference ' + d.diff.toFixed(3) + (d.extra ? '\n' + d.extra : '')
  );
  return pack(header, entries, '');
}

// The OVER RANKING sections: one group per t band (5+, 4+, 3+), ordered by Score inside a group.
//   plus = false: the normal rank (Score = r), every match listed.
//   plus = true:  the second rank (Score = r + q), top 20 of each group only.
function overMessages(title: string, items: OverItem[], plus: boolean): string[] {
  const bands: { label: string; min: number; max: number }[] = [
    { label: '5+', min: 500, max: Infinity },
    { label: '4+', min: 400, max: 500 },
    { label: '3+', min: 300, max: 400 },
  ];
  const entries: string[] = [];
  let shown = 0;
  let inGroups = 0;
  bands.forEach((b) => {
    const all = items
      .filter((x) => x.tHundredths >= b.min && x.tHundredths < b.max)
      .sort((a, c) =>
        plus ? c.score2 - a.score2 || a.order - c.order : c.score - a.score || a.order - c.order
      );
    inGroups += all.length;
    const inBand = plus ? all.slice(0, OVER2_TOP) : all;
    shown += inBand.length;
    if (inBand.length === 0) {
      entries.push(b.label + ' (0)\nNone');
      return;
    }
    const count = plus && all.length > inBand.length ? inBand.length + ' of ' + all.length : String(inBand.length);
    inBand.forEach((m, i) => {
      const value = plus ? m.score2 : m.score;
      const line =
        i + 1 + ') ' + m.name + '\nt ' + (m.tHundredths / 100).toFixed(2) +
        ' | Score ' + value.toFixed(3) + (m.extra ? '\n' + m.extra : '');
      entries.push(i === 0 ? b.label + ' (' + count + ')\n' + line : line);
    });
  });
  const below = items.length - inGroups;
  const footer = !plus && below > 0 ? below + ' match(es) with t below 3.00 are not listed.' : '';
  const head = plus ? 'OVER RANKING 2 (r + q, top 20 per group) - ' : 'OVER RANKING - ';
  return pack(head + title + ' (' + shown + ')', entries, footer);
}

// ── Part 1: football-data competitions ────────────────────────────────────
export type RankComp = { code: string; name: string; count: number };

export async function listRankComps(): Promise<
  { ok: true; comps: RankComp[] } | { ok: false; error: string }
> {
  try {
    const supabase = createAdminClient();
    const fx = await supabase.from('fd_fixtures').select('comp_code').eq('status', 'pending').limit(2000);
    if (fx.error) return { ok: false, error: 'could not read the fixtures' };
    const counts: Record<string, number> = {};
    ((fx.data ?? []) as unknown as { comp_code: string }[]).forEach((r) => {
      counts[r.comp_code] = (counts[r.comp_code] ?? 0) + 1;
    });

    const cp = await supabase.from('fd_competitions').select('code, name, in_season');
    if (cp.error) return { ok: false, error: 'could not read the competitions' };
    const comps: RankComp[] = [];
    ((cp.data ?? []) as unknown as { code: string; name: string; in_season: boolean }[]).forEach((c) => {
      if (c.in_season === true && counts[c.code]) {
        comps.push({ code: c.code, name: c.name, count: counts[c.code] });
      }
    });
    comps.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, comps };
  } catch (e) {
    console.error('rank comps failed');
    return { ok: false, error: 'something went wrong' };
  }
}

type FxRow = {
  fd_match_id: number;
  match_date: string;
  home_name: string;
  away_name: string;
  hs: number | string | null;
  hc: number | string | null;
  asc_: number | string | null;
  ac: number | string | null;
  skip_reason: string | null;
};

export async function rankCompetition(
  code: string
): Promise<{ ok: true; messages: string[] } | { ok: false; error: string }> {
  try {
    const supabase = createAdminClient();
    const cp = await supabase.from('fd_competitions').select('name').eq('code', code).maybeSingle();
    const name = cp.data && typeof (cp.data as { name?: string }).name === 'string'
      ? (cp.data as { name: string }).name
      : code;

    const fx = await supabase
      .from('fd_fixtures')
      .select('fd_match_id, match_date, home_name, away_name, hs, hc, asc_, ac, skip_reason')
      .eq('comp_code', code)
      .eq('status', 'pending')
      .order('match_date', { ascending: true })
      .limit(200);
    if (fx.error) return { ok: false, error: 'could not read the fixtures' };
    const rows = (fx.data ?? []) as unknown as FxRow[];

    const sides: Side[] = [];
    const rxItems: RxItem[] = [];
    const draws: DrawEntry[] = [];
    const overs: OverItem[] = [];
    const notRanked: string[] = [];
    rows.forEach((r, i) => {
      if (r.hs === null || r.hc === null || r.asc_ === null || r.ac === null) {
        notRanked.push(r.home_name + ' - ' + r.away_name + ': ' + (r.skip_reason ? r.skip_reason : 'no averages stored yet'));
        return;
      }
      const hs = round2(Number(r.hs));
      const hc = round2(Number(r.hc));
      const as = round2(Number(r.asc_));
      const ac = round2(Number(r.ac));
      if (![hs, hc, as, ac].every((n) => isFinite(n))) {
        notRanked.push(r.home_name + ' - ' + r.away_name + ': unreadable averages');
        return;
      }
      const when = kickoff(r.match_date);
      const hp = homePoint(hs, hc, as, ac);
      const ap = awayPoint(hs, hc, as, ac);
      sides.push({
        team: r.home_name,
        point: hp,
        line: 'Home vs ' + r.away_name,
        extra: when,
        order: i * 2,
      });
      sides.push({
        team: r.away_name,
        point: ap,
        line: 'Away at ' + r.home_name,
        extra: when,
        order: i * 2 + 1,
      });
      const q = rxQualifies(hundredths(hs), hundredths(hc), hundredths(as), hundredths(ac));
      if (q.home) {
        rxItems.push({ team: r.home_name, rx: hp / ap, line: 'Home vs ' + r.away_name, extra: when, order: i * 2 });
      }
      if (q.away) {
        rxItems.push({ team: r.away_name, rx: ap / hp, line: 'Away at ' + r.home_name, extra: when, order: i * 2 + 1 });
      }
      if (isDraw(hundredths(hs), hundredths(hc), hundredths(as), hundredths(ac))) {
        draws.push({
          label: r.home_name + ' - ' + r.away_name,
          home: hp,
          away: ap,
          diff: Math.abs(hp - ap),
          tick: bothFormulasDraw(hs, hc, as, ac),
          extra: when,
          order: i,
        });
      }
      overs.push({
        name: r.home_name + ' - ' + r.away_name,
        tHundredths: hundredths(hs) + hundredths(as),
        score: overScore(hs, hc, as, ac),
        score2: overScore2(hs, hc, as, ac),
        extra: when,
        order: i,
      });
    });

    const footerParts: string[] = [];
    if (notRanked.length > 0) footerParts.push('NOT RANKED:\n' + notRanked.join('\n'));
    footerParts.push('Rule-based order from the formula. No accuracy is promised.');
    const top = Math.floor(sides.length / 2);
    const header = 'RANKING - ' + name + ' (top ' + top + ' of ' + sides.length + ' sides)';
    if (sides.length === 0) {
      return { ok: true, messages: [header + '\n\nNo stored match has averages yet.\n\n' + footerParts.join('\n\n')] };
    }
    const messages = pack(header, rankedEntries(sides), footerParts.join('\n\n'))
      .concat(rxMessages(name, rxItems))
      .concat(drawMessages(name, draws))
      .concat(overMessages(name, overs, false))
      .concat(overMessages(name, overs, true));
    return { ok: true, messages };
  } catch (e) {
    console.error('rank competition failed');
    return { ok: false, error: 'something went wrong' };
  }
}

// ── Part 2: the matches pasted into the storage ───────────────────────────
export type PastedRow = { name: string; dataLine: string; league: string | null };

function splitTeams(name: string): { home: string; away: string } | null {
  const seps = [' - ', ' vs ', ' v '];
  for (const sep of seps) {
    const at = name.toLowerCase().indexOf(sep);
    if (at > 0) return { home: name.slice(0, at).trim(), away: name.slice(at + sep.length).trim() };
  }
  return null;
}

export function rankPasted(rows: PastedRow[]): string[] {
  const sides: Side[] = [];
  const rxItems: RxItem[] = [];
  const draws: DrawEntry[] = [];
  const overs: OverItem[] = [];
  const unreadable: string[] = [];
  rows.forEach((r, i) => {
    const parts = r.dataLine.split(',').map((x) => x.trim());
    if (parts.length !== 4 && parts.length !== 6) {
      unreadable.push(r.name);
      return;
    }
    const nums = parts.slice(parts.length - 4).map((x) => Number(x));
    if (nums.some((n) => !isFinite(n) || n < 0)) {
      unreadable.push(r.name);
      return;
    }
    const [hs, hc, as, ac] = nums.map(round2);
    const teams = splitTeams(r.name);
    const homeName = teams ? teams.home : 'Home team of ' + r.name;
    const awayName = teams ? teams.away : 'Away team of ' + r.name;
    const league = r.league ? r.league : '';
    const hp = homePoint(hs, hc, as, ac);
    const ap = awayPoint(hs, hc, as, ac);
    sides.push({
      team: homeName,
      point: hp,
      line: 'Home vs ' + awayName,
      extra: league,
      order: i * 2,
    });
    sides.push({
      team: awayName,
      point: ap,
      line: 'Away at ' + homeName,
      extra: league,
      order: i * 2 + 1,
    });
    const q = rxQualifies(hundredths(hs), hundredths(hc), hundredths(as), hundredths(ac));
    if (q.home) {
      rxItems.push({ team: homeName, rx: hp / ap, line: 'Home vs ' + awayName, extra: league, order: i * 2 });
    }
    if (q.away) {
      rxItems.push({ team: awayName, rx: ap / hp, line: 'Away at ' + homeName, extra: league, order: i * 2 + 1 });
    }
    if (isDraw(hundredths(hs), hundredths(hc), hundredths(as), hundredths(ac))) {
      draws.push({
        label: r.name,
        home: hp,
        away: ap,
        diff: Math.abs(hp - ap),
        tick: bothFormulasDraw(hs, hc, as, ac),
        extra: league,
        order: i,
      });
    }
    overs.push({
      name: r.name,
      tHundredths: hundredths(hs) + hundredths(as),
      score: overScore(hs, hc, as, ac),
      score2: overScore2(hs, hc, as, ac),
      extra: league,
      order: i,
    });
  });

  const footerParts: string[] = [];
  if (unreadable.length > 0) footerParts.push('Could not read: ' + unreadable.join(', '));
  footerParts.push('Rule-based order from the formula. No accuracy is promised.');
  const top = Math.floor(sides.length / 2);
  const header = 'RANKING - pasted matches (top ' + top + ' of ' + sides.length + ' sides)';
  if (sides.length === 0) {
    return [header + '\n\nNo stored match could be read.\n\n' + footerParts.join('\n\n')];
  }
  return pack(header, rankedEntries(sides), footerParts.join('\n\n'))
    .concat(rxMessages('pasted matches', rxItems))
    .concat(drawMessages('pasted matches', draws))
    .concat(overMessages('pasted matches', overs, false))
    .concat(overMessages('pasted matches', overs, true));
}
