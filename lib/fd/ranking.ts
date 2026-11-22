// lib/fd/ranking.ts  (REPLACES the earlier version) - Rankings. Read only. Private chat only.
// Home point = ((hs / (1 + hc)) * ac) / (1 + as)
// Away point = ((as / (1 + ac)) * hc) / (1 + hs)
// Every side gets its own point; sides go in ONE list, highest first.
//   Only the top N sides are shown, where N = the number of matches (20 matches -> top 20).
// SUPPORTING FORMULA: X = hs/hc + ac/as (Home), Y = as/ac + hc/hs (Away), D2 = |X - Y|.
//   If hs, hc, as or ac is 0 there is no supporting result (no tick, tag shows "-").
//   Exact integer maths (X = N/(hc*as), Y = N/(ac*hs), N = hs*as + ac*hc).
// RX 2+ section (after the main list, before DRAW): Home rx = Home point / Away point,
//   Away rx = Away point / Home point. A side qualifies when its rx is 2 or more
//   (exact integer maths). If the opposing point is 0 the side is eliminated.
//   A side gets a tick when D2 >= 3 (3 included).
// DRAW section (football only): a match qualifies when |Home point - Away point| (main D) is
//   between 0.0 and 0.2, both ends included (exact integer maths). Closest first. A match gets
//   a tick only when BOTH the main D and D2 are between 0 and 0.2 (included). Each match shows
//   the tag (main stronger, supporting stronger), e.g. (Home, Away).
// OVER RANKING: Score = S = X + Y, X = 2*hs*ac/(hs+ac), Y = 2*as*hc/(as+hc)
//   (a zero denominator makes that part 0). t = hs + as = total scored.
//   FOOTBALL main list: every match, highest Score first.
//   Bracket number next to each football match: the smaller of (total conceded, total scored),
//   minus 0.5, rounded half up (= whole part of that smaller total). Exact integer maths.
//   BASKETBALL main list: every match, highest Score first. Bracket number: Score - 10, floored.
// TOP 10 LISTS (football AND basketball, same rules):
//   rate = bigger / smaller of (total scored, total conceded). Matches with a zero total have no rate.
//   List 1: value = rate * Score, top 10, descending.
//   List 2: Score 2 = min(hs,ac)/(1+max(hs,ac)) + min(as,hc)/(1+max(as,hc)),
//           value 2 = rate * Score 2, top 10, descending.
//           A match that is also in list 1 gets a check mark.
// BASKETBALL (pasted matches only): the word Basketball on the first line of the paste marks
//   every match in it as basketball (the stored league starts with "Basketball"). Basketball
//   gets the same WIN ranking and RX 2+ (with the D2 tick), NO Draw, and its own Over lists.
// Part 1: one competition's stored pending matches (fd_fixtures). Football only.
// Part 2: the matches pasted into the storage (one list across all leagues).
import { createAdminClient } from '@/lib/supabase/admin';

const LIMIT = 3500;

export function homePoint(hs: number, hc: number, as: number, ac: number): number {
  return ((hs / (1 + hc)) * ac) / (1 + as);
}

export function awayPoint(hs: number, hc: number, as: number, ac: number): number {
  return ((as / (1 + ac)) * hc) / (1 + hs);
}

// Score S = X + Y, X = 2*hs*ac/(hs+ac), Y = 2*as*hc/(as+hc). A zero denominator gives 0.
export function overScore(hs: number, hc: number, as: number, ac: number): number {
  const x = hs + ac > 0 ? (2 * hs * ac) / (hs + ac) : 0;
  const y = as + hc > 0 ? (2 * as * hc) / (as + hc) : 0;
  return x + y;
}

// Score 2 = min(hs,ac)/(1+max(hs,ac)) + min(as,hc)/(1+max(as,hc)).
export function overScore2(hs: number, hc: number, as: number, ac: number): number {
  return Math.min(hs, ac) / (1 + Math.max(hs, ac)) + Math.min(as, hc) / (1 + Math.max(as, hc));
}

type Side = { team: string; point: number; line: string; extra: string; order: number };
type RxItem = { team: string; rx: number; tick: boolean; line: string; extra: string; order: number };
type DrawEntry = {
  label: string;
  home: number;
  away: number;
  diff: number;
  tick: boolean;
  tag: string;
  extra: string;
  order: number;
};
type OverItem = {
  name: string;
  tHundredths: number; // t = hs + as in hundredths, exact
  concedeH: number; // home conceded + away conceded in hundredths, exact
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

// Which side the main formula favours: Home if Home point > Away point, else Away.
// Exact: Nh/Dh > Na/Da  <=>  Nh*Da > Na*Dh.
function mainStronger(hs: number, hc: number, as: number, ac: number): 'Home' | 'Away' {
  const B = (n: number) => BigInt(n);
  const hundred = B(100);
  const nh = B(hs) * B(ac);
  const dh = (hundred + B(hc)) * (hundred + B(as));
  const na = B(as) * B(hc);
  const da = (hundred + B(ac)) * (hundred + B(hs));
  return nh * da > na * dh ? 'Home' : 'Away';
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

// Supporting formula, exact, averages in hundredths.
//   X = hs/hc + ac/as = N / (hc*as),  Y = as/ac + hc/hs = N / (ac*hs),  N = hs*as + ac*hc
//   D2 = |X - Y| = N * |ac*hs - hc*as| / (hc*as*ac*hs)
//   Returns null when hs, hc, as or ac is 0.
type Support = { small: boolean; big: boolean; stronger: 'Home' | 'Away' };
function support(hs: number, hc: number, as: number, ac: number): Support | null {
  if (hs <= 0 || hc <= 0 || as <= 0 || ac <= 0) return null;
  const B = (n: number) => BigInt(n);
  const n = B(hs) * B(as) + B(ac) * B(hc);
  const diff = B(ac) * B(hs) - B(hc) * B(as);
  const absDiff = diff < B(0) ? -diff : diff;
  const den = B(hc) * B(as) * B(ac) * B(hs);
  return {
    small: B(5) * n * absDiff <= den, // D2 <= 0.2
    big: n * absDiff >= B(3) * den, // D2 >= 3
    stronger: diff > B(0) ? 'Home' : 'Away', // X > Y <=> ac*hs > hc*as
  };
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

// The RX 2+ section: one descending list, highest rx first. Tick when D2 >= 3.
function rxMessages(title: string, items: RxItem[]): string[] {
  const header = 'RX 2+ - ' + title + ' (' + items.length + ')';
  if (items.length === 0) return [header + '\nNone'];
  const sorted = items.slice().sort((a, b) => b.rx - a.rx || a.order - b.order);
  const entries = sorted.map(
    (x, i) =>
      i + 1 + ') ' + x.team + (x.tick ? ' ✅' : '') + '   rx ' + x.rx.toFixed(3) +
      '\n' + x.line + (x.extra ? '\n' + x.extra : '')
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
      i + 1 + ') ' + d.label + (d.tick ? ' ✅' : '') + ' ' + d.tag +
      '\nHome ' + d.home.toFixed(3) + ' | Away ' + d.away.toFixed(3) +
      ' | difference ' + d.diff.toFixed(3) + (d.extra ? '\n' + d.extra : '')
  );
  return pack(header, entries, '');
}

// Football bracket number: the smaller of (total conceded, total scored), minus 0.5,
// rounded half up = whole part of that smaller total. Values are in hundredths.
function bracketOf(m: OverItem): number {
  return Math.floor(Math.min(m.concedeH, m.tHundredths) / 100);
}

// Basketball bracket number: Score - 10, floored. The tiny 1e-9 stops a Score that is
// exactly on a whole number from dropping a point through floating-point error.
function bracketBasket(m: OverItem): number {
  return Math.floor(m.score - 10 + 1e-9);
}

// The two TOP 10 lists, shared by football and basketball.
//   rate = bigger / smaller of (total scored, total conceded).
//   List 1: rate * Score. List 2: rate * Score 2 (check mark when the match is also in list 1).
function topLists(
  title: string,
  items: OverItem[],
  bracket: (m: OverItem) => number,
  prefix: string
): string[] {
  const rated: { m: OverItem; rate: number; value: number; value2: number }[] = [];
  let skipped = 0;
  items.forEach((m) => {
    const big = Math.max(m.concedeH, m.tHundredths);
    const small = Math.min(m.concedeH, m.tHundredths);
    if (small <= 0) {
      skipped++;
      return;
    }
    const rate = big / small;
    rated.push({ m, rate, value: rate * m.score, value2: rate * m.score2 });
  });
  const skipNote =
    skipped > 0 ? skipped + ' match(es) left out: total scored or total conceded is 0, so no rate.' : '';

  // List 1: rate x Score, top 10.
  const listA = rated.slice().sort((a, b) => b.value - a.value || a.m.order - b.m.order).slice(0, 10);
  const inA: Record<number, boolean> = {};
  listA.forEach((x) => {
    inA[x.m.order] = true;
  });
  const header1 = prefix + 'OVER RATE x SCORE (top 10) - ' + title + ' (' + listA.length + ')';
  let out: string[] = [];
  if (listA.length === 0) {
    out = out.concat([header1 + '\nNone']);
  } else {
    const entries1 = listA.map(
      (x, i) =>
        i + 1 + ') ' + x.m.name + ' (' + bracket(x.m) + ')' +
        '\nrate ' + x.rate.toFixed(3) + ' x Score ' + x.m.score.toFixed(3) +
        ' = ' + x.value.toFixed(3) + (x.m.extra ? '\n' + x.m.extra : '')
    );
    out = out.concat(pack(header1, entries1, skipNote));
  }

  // List 2: rate x Score 2, top 10. Check mark when the match is also in list 1.
  const listB = rated.slice().sort((a, b) => b.value2 - a.value2 || a.m.order - b.m.order).slice(0, 10);
  const header2 = prefix + 'OVER RATE x SCORE 2 (top 10) - ' + title + ' (' + listB.length + ')';
  if (listB.length === 0) return out.concat([header2 + '\nNone']);
  const entries2 = listB.map(
    (x, i) =>
      i + 1 + ') ' + x.m.name + (inA[x.m.order] ? ' ✅' : '') + ' (' + bracket(x.m) + ')' +
      '\nrate ' + x.rate.toFixed(3) + ' x Score 2 ' + x.m.score2.toFixed(3) +
      ' = ' + x.value2.toFixed(3) + (x.m.extra ? '\n' + x.m.extra : '')
  );
  return out.concat(pack(header2, entries2, skipNote));
}

// The football OVER RANKING: one single list, highest Score first, then the two top 10 lists.
function overMessages(title: string, items: OverItem[]): string[] {
  const header = 'OVER RANKING (highest score first) - ' + title + ' (' + items.length + ')';
  if (items.length === 0) return [header + '\nNone'];

  const sorted = items.slice().sort((a, b) => b.score - a.score || a.order - b.order);
  const entries = sorted.map(
    (m, i) =>
      i + 1 + ') ' + m.name + ' (' + bracketOf(m) + ')' +
      '\nt ' + (m.tHundredths / 100).toFixed(2) +
      ' | Score ' + m.score.toFixed(3) + (m.extra ? '\n' + m.extra : '')
  );
  return pack(header, entries, '').concat(topLists(title, items, bracketOf, ''));
}

// The basketball OVER RANKING: one single list, highest Score first, then the two top 10 lists.
function overBasketballMessages(title: string, items: OverItem[]): string[] {
  const header = 'BASKETBALL OVER RANKING - ' + title + ' (' + items.length + ')';
  if (items.length === 0) return [header + '\nNone'];
  const sorted = items.slice().sort((a, b) => b.score - a.score || a.order - b.order);
  const entries = sorted.map(
    (m, i) =>
      i + 1 + ') ' + m.name + ' (' + bracketBasket(m) + ')' +
      '\nScore ' + m.score.toFixed(3) + (m.extra ? '\n' + m.extra : '')
  );
  return pack(header, entries, '').concat(topLists(title, items, bracketBasket, 'BASKETBALL '));
}

// Builds the draw tag and tick for one match (averages already in hundredths).
function drawInfo(hsH: number, hcH: number, asH: number, acH: number): { tick: boolean; tag: string } {
  const sup = support(hsH, hcH, asH, acH);
  const main = mainStronger(hsH, hcH, asH, acH);
  const tick = sup !== null && sup.small && isDraw(hsH, hcH, asH, acH);
  return { tick, tag: '(' + main + ', ' + (sup ? sup.stronger : '-') + ')' };
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
      const hsH = hundredths(hs);
      const hcH = hundredths(hc);
      const asH = hundredths(as);
      const acH = hundredths(ac);
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
      const q = rxQualifies(hsH, hcH, asH, acH);
      const sup = support(hsH, hcH, asH, acH);
      const rxTick = sup !== null && sup.big;
      if (q.home) {
        rxItems.push({ team: r.home_name, rx: hp / ap, tick: rxTick, line: 'Home vs ' + r.away_name, extra: when, order: i * 2 });
      }
      if (q.away) {
        rxItems.push({ team: r.away_name, rx: ap / hp, tick: rxTick, line: 'Away at ' + r.home_name, extra: when, order: i * 2 + 1 });
      }
      if (isDraw(hsH, hcH, asH, acH)) {
        const info = drawInfo(hsH, hcH, asH, acH);
        draws.push({
          label: r.home_name + ' - ' + r.away_name,
          home: hp,
          away: ap,
          diff: Math.abs(hp - ap),
          tick: info.tick,
          tag: info.tag,
          extra: when,
          order: i,
        });
      }
      overs.push({
        name: r.home_name + ' - ' + r.away_name,
        tHundredths: hsH + asH,
        concedeH: hcH + acH,
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
      .concat(overMessages(name, overs));
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

// A stored league that starts with the word Basketball marks a basketball match.
function isBasketball(league: string | null): boolean {
  if (!league) return false;
  return league.trim().toLowerCase().indexOf('basketball') === 0;
}

// Ranks one group of pasted matches: football (basketball = false) or basketball (true).
function rankPastedGroup(rows: PastedRow[], basketball: boolean): string[] {
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
    const hsH = hundredths(hs);
    const hcH = hundredths(hc);
    const asH = hundredths(as);
    const acH = hundredths(ac);
    const teams = splitTeams(r.name);
    const homeName = teams ? teams.home : 'Home team of ' + r.name;
    const awayName = teams ? teams.away : 'Away team of ' + r.name;
    const league = r.league ? r.league.replace(/^basketball\s*\|?\s*/i, '').trim() : '';
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
    const q = rxQualifies(hsH, hcH, asH, acH);
    const sup = support(hsH, hcH, asH, acH);
    const rxTick = sup !== null && sup.big;
    if (q.home) {
      rxItems.push({ team: homeName, rx: hp / ap, tick: rxTick, line: 'Home vs ' + awayName, extra: league, order: i * 2 });
    }
    if (q.away) {
      rxItems.push({ team: awayName, rx: ap / hp, tick: rxTick, line: 'Away at ' + homeName, extra: league, order: i * 2 + 1 });
    }
    if (!basketball && isDraw(hsH, hcH, asH, acH)) {
      const info = drawInfo(hsH, hcH, asH, acH);
      draws.push({
        label: r.name,
        home: hp,
        away: ap,
        diff: Math.abs(hp - ap),
        tick: info.tick,
        tag: info.tag,
        extra: league,
        order: i,
      });
    }
    overs.push({
      name: r.name,
      tHundredths: hsH + asH,
      concedeH: hcH + acH,
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
  const label = basketball ? 'basketball pasted matches' : 'pasted matches';
  const header =
    (basketball ? 'BASKETBALL RANKING - pasted matches' : 'RANKING - pasted matches') +
    ' (top ' + top + ' of ' + sides.length + ' sides)';
  if (sides.length === 0) {
    return [header + '\n\nNo stored match could be read.\n\n' + footerParts.join('\n\n')];
  }
  let out = pack(header, rankedEntries(sides), footerParts.join('\n\n')).concat(rxMessages(label, rxItems));
  if (basketball) {
    out = out.concat(overBasketballMessages('pasted matches', overs));
  } else {
    out = out.concat(drawMessages(label, draws)).concat(overMessages(label, overs));
  }
  return out;
}

export function rankPasted(rows: PastedRow[]): string[] {
  const football = rows.filter((r) => !isBasketball(r.league));
  const basket = rows.filter((r) => isBasketball(r.league));
  let out: string[] = [];
  if (football.length > 0 || basket.length === 0) {
    out = out.concat(rankPastedGroup(football, false));
  }
  if (basket.length > 0) {
    out = out.concat(rankPastedGroup(basket, true));
  }
  return out;
}
