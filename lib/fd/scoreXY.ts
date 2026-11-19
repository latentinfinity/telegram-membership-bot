// lib/fd/scoreXY.ts - Correct score X:Y. Read only. Private chat only.
// X = 2*hs*ac/(hs+ac) (Home), Y = 2*as*hc/(as+hc) (Away). A zero denominator gives 0.
// Rounding: decimal part 0.65 or more rounds up, below 0.65 rounds down
// (1.67 -> 2, 2.6 -> 2, 2.65 -> 3). Exact integer maths on hundredths.
// Pasted matches whose league starts with "Basketball" are shown as basketball.
import { createAdminClient } from '@/lib/supabase/admin';

const LIMIT = 3500;

function h2(n: number): number {
  return Math.round(Number(n.toFixed(2)) * 100);
}

// a, b in hundredths. Returns the rounded goals.
function roundSide(a: number, b: number): number {
  const d = BigInt(a) + BigInt(b);
  if (d === BigInt(0)) return 0;
  const n = BigInt(2) * BigInt(a) * BigInt(b);
  return Number((n + BigInt(35) * d) / (BigInt(100) * d));
}

function rawSide(a: number, b: number): number {
  const d = a + b;
  return d === 0 ? 0 : (2 * a * b) / d / 100;
}

function pack(header: string, entries: string[]): string[] {
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
  messages.push(current);
  return messages;
}

function line(num: number, name: string, hs: number, hc: number, as: number, ac: number): string {
  const hsH = h2(hs);
  const hcH = h2(hc);
  const asH = h2(as);
  const acH = h2(ac);
  const x = roundSide(hsH, acH);
  const y = roundSide(asH, hcH);
  return (
    num + ') ' + name + '   ' + x + ' : ' + y +
    '\n(' + rawSide(hsH, acH).toFixed(2) + ' : ' + rawSide(asH, hcH).toFixed(2) + ')'
  );
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

// ── Football-data competitions ────────────────────────────────────────────
type FxRow = {
  match_date: string;
  home_name: string;
  away_name: string;
  hs: number | string | null;
  hc: number | string | null;
  asc_: number | string | null;
  ac: number | string | null;
  skip_reason: string | null;
};

export async function scoresCompetition(
  code: string
): Promise < { ok: true;messages: string[] } | { ok: false;error: string } > {
  try {
    const supabase = createAdminClient();
    const cp = await supabase.from('fd_competitions').select('name').eq('code', code).maybeSingle();
    const name =
      cp.data && typeof(cp.data as { name ? : string }).name === 'string' ?
      (cp.data as { name: string }).name :
      code;
    const fx = await supabase
      .from('fd_fixtures')
      .select('match_date, home_name, away_name, hs, hc, asc_, ac, skip_reason')
      .eq('comp_code', code)
      .eq('status', 'pending')
      .order('match_date', { ascending: true })
      .limit(200);
    if (fx.error) return { ok: false, error: 'could not read the fixtures' };
    const rows = (fx.data ?? []) as unknown as FxRow[];
    const entries: string[] = [];
    const notShown: string[] = [];
    let n = 0;
    rows.forEach((r) => {
      if (r.hs === null || r.hc === null || r.asc_ === null || r.ac === null) {
        notShown.push(r.home_name + ' - ' + r.away_name + ': ' + (r.skip_reason ? r.skip_reason : 'no averages stored yet'));
        return;
      }
      const hs = Number(r.hs);
      const hc = Number(r.hc);
      const as = Number(r.asc_);
      const ac = Number(r.ac);
      if (![hs, hc, as, ac].every((v) => isFinite(v))) {
        notShown.push(r.home_name + ' - ' + r.away_name + ': unreadable averages');
        return;
      }
      n++;
      entries.push(line(n, r.home_name + ' - ' + r.away_name, hs, hc, as, ac) + '\n' + kickoff(r.match_date));
    });
    const header = 'CORRECT SCORES (X:Y) - ' + name + ' (' + n + ')';
    if (n === 0) {
      return { ok: true, messages: [header + '\n\nNo stored match has averages yet.' + (notShown.length ? '\n\nNOT SHOWN:\n' + notShown.join('\n') : '')] };
    }
    const messages = pack(header, entries);
    const foot = 'X:Y = Home:Away, rounded up from 0.65. Rule-based, no accuracy is promised.' +
      (notShown.length ? '\n\nNOT SHOWN:\n' + notShown.join('\n') : '');
    messages[messages.length - 1] += '\n' + foot;
    return { ok: true, messages };
  } catch (e) {
    console.error('scores competition failed');
    return { ok: false, error: 'something went wrong' };
  }
}

// ── Pasted matches ────────────────────────────────────────────────────────
export type ScoreRow = { name: string;dataLine: string;league: string | null };

function isBasketball(league: string | null): boolean {
  return !!league && league.trim().toLowerCase().indexOf('basketball') === 0;
}

// "Basketball | EUROPE: Euroleague" -> "EUROPE: Euroleague"
function shownLeague(league: string | null): string {
  if (!league) return '';
  return league.replace(/^basketball\s*\|?\s*/i, '').trim();
}

function group(rows: ScoreRow[], title: string): string[] {
  const entries: string[] = [];
  const unreadable: string[] = [];
  let n = 0;
  let lastLeague: string | null = null;
  rows.forEach((r) => {
    const parts = r.dataLine.split(',').map((x) => x.trim());
    if (parts.length !== 4 && parts.length !== 6) {
      unreadable.push(r.name);
      return;
    }
    const nums = parts.slice(parts.length - 4).map((x) => Number(x));
    if (nums.some((v) => !isFinite(v) || v < 0)) {
      unreadable.push(r.name);
      return;
    }
    const lg = shownLeague(r.league);
    n++;
    let text = line(n, r.name, nums[0], nums[1], nums[2], nums[3]);
    if (lg !== lastLeague) {
      text = (lg ? lg : 'No league') + '\n' + text;
      lastLeague = lg;
    }
    entries.push(text);
  });
  const header = title + ' (' + n + ')';
  if (n === 0) {
    return [header + '\n\nNo stored match could be read.' + (unreadable.length ? '\nCould not read: ' + unreadable.join(', ') : '')];
  }
  const messages = pack(header, entries);
  messages[messages.length - 1] +=
    '\nX:Y = Home:Away, rounded up from 0.65. Rule-based, no accuracy is promised.' +
    (unreadable.length ? '\nCould not read: ' + unreadable.join(', ') : '');
  return messages;
}

export function scoresPasted(rows: ScoreRow[]): string[] {
  const football = rows.filter((r) => !isBasketball(r.league));
  const basket = rows.filter((r) => isBasketball(r.league));
  let out: string[] = [];
  if (football.length > 0 || basket.length === 0) {
    out = out.concat(group(football, 'CORRECT SCORES (X:Y) - pasted matches'));
  }
  if (basket.length > 0) {
    out = out.concat(group(basket, 'BASKETBALL CORRECT SCORES (X:Y) - pasted matches'));
  }
  return out;
}
