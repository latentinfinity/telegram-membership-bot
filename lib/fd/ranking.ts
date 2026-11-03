// lib/fd/ranking.ts  (REPLACES the earlier version) - Rankings. Read only. Private chat only.
// Home point = ((hs / (1 + hc)) * ac) / (1 + as)
// Away point = ((as / (1 + ac)) * hc) / (1 + hs)
// Every side gets its own point (the home team its Home point, the away team its
// Away point); all sides go in ONE list, highest first. No Home/Away split.
// DRAW section (new): a match qualifies when |Home point - Away point| is between
// 0.0 and 0.2, both ends included (exact integer maths). Listed closest first.
// Part 1: one competition's stored pending matches (fd_fixtures).
// Part 2: the matches pasted into the storage (one list across all leagues).
import { createAdminClient } from '@/lib/supabase/admin';

const LIMIT = 3500;

export function homePoint(hs: number, hc: number, as: number, ac: number): number {
  return ((hs / (1 + hc)) * ac) / (1 + as);
}

export function awayPoint(hs: number, hc: number, as: number, ac: number): number {
  return ((as / (1 + ac)) * hc) / (1 + hs);
}

type Side = { team: string; point: number; line: string; extra: string; order: number };
type DrawEntry = {
  label: string;
  home: number;
  away: number;
  diff: number;
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

function rankedEntries(sides: Side[]): string[] {
  const sorted = sides.slice().sort((a, b) => b.point - a.point || a.order - b.order);
  return sorted.map(
    (s, i) => i + 1 + ') ' + s.team + '   ' + s.point.toFixed(3) + '\n' + s.line + (s.extra ? '\n' + s.extra : '')
  );
}

// The DRAW section: closest first (smallest difference on top).
function drawMessages(title: string, draws: DrawEntry[]): string[] {
  const header = 'DRAW - ' + title + ' (' + draws.length + ')';
  if (draws.length === 0) return [header + '\nNone'];
  const sorted = draws.slice().sort((a, b) => a.diff - b.diff || a.order - b.order);
  const entries = sorted.map(
    (d, i) =>
      i + 1 + ') ' + d.label + '\nHome ' + d.home.toFixed(3) + ' | Away ' + d.away.toFixed(3) +
      ' | difference ' + d.diff.toFixed(3) + (d.extra ? '\n' + d.extra : '')
  );
  return pack(header, entries, '');
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
    const draws: DrawEntry[] = [];
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
      if (isDraw(hundredths(hs), hundredths(hc), hundredths(as), hundredths(ac))) {
        draws.push({
          label: r.home_name + ' - ' + r.away_name,
          home: hp,
          away: ap,
          diff: Math.abs(hp - ap),
          extra: when,
          order: i,
        });
      }
    });

    const footerParts: string[] = [];
    if (notRanked.length > 0) footerParts.push('NOT RANKED:\n' + notRanked.join('\n'));
    footerParts.push('Rule-based order from the formula. No accuracy is promised.');
    const header = 'RANKING - ' + name + ' (' + sides.length + ' sides)';
    if (sides.length === 0) {
      return { ok: true, messages: [header + '\n\nNo stored match has averages yet.\n\n' + footerParts.join('\n\n')] };
    }
    const messages = pack(header, rankedEntries(sides), footerParts.join('\n\n')).concat(
      drawMessages(name, draws)
    );
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
  const draws: DrawEntry[] = [];
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
    if (isDraw(hundredths(hs), hundredths(hc), hundredths(as), hundredths(ac))) {
      draws.push({
        label: r.name,
        home: hp,
        away: ap,
        diff: Math.abs(hp - ap),
        extra: league,
        order: i,
      });
    }
  });

  const footerParts: string[] = [];
  if (unreadable.length > 0) footerParts.push('Could not read: ' + unreadable.join(', '));
  footerParts.push('Rule-based order from the formula. No accuracy is promised.');
  const header = 'RANKING - pasted matches (' + sides.length + ' sides)';
  if (sides.length === 0) {
    return [header + '\n\nNo stored match could be read.\n\n' + footerParts.join('\n\n')];
  }
  return pack(header, rankedEntries(sides), footerParts.join('\n\n')).concat(
    drawMessages('pasted matches', draws)
  );
}
