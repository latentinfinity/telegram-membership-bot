// ═══════════════════════════════════════════════════════════════
// TICKETS — builds random tickets from stored matches. PURE module:
// no database, no Telegram. Uses runPrediction() from ./predict.
//
// Each stored match that Predict calls Over 3.5 or Over 2.5 gives TWO options:
//   Over 3.5 call -> Over 3.5 and Over 2.5
//   Over 2.5 call -> Over 2.5 and Over 1.5
// Rules: at most 10 matches per ticket, a match never appears twice in one
// ticket, every option is used exactly once across all tickets. Tickets are
// filled to 10 first, the remainder forms one smaller ticket. With 10 matches
// or fewer there are exactly two tickets (the two options of a match must go
// in different tickets). Which options share a ticket is random every time.
//
// Percentages: total goals ~ Poisson(eH + eA), the same model Predict uses.
// They are model estimates, not measured hit rates.
// No BigInt literals, so it compiles on any TS target.
// ═══════════════════════════════════════════════════════════════

import { runPrediction, outcomeChances } from './predict';
import { calibratedScores } from './correctScore';

export const MAX_STORED_MATCHES = 100;
export const MAX_NAME_LENGTH = 80;
export const MAX_LEAGUE_LENGTH = 80;
// Share of the matches (with an Over call) removed at random before the
// tickets are built. A one-line change if it is ever wanted differently.
export const ELIMINATE_PERCENT = 20;

export const MAX_PER_TICKET = 10;

export type TicketLine = 1.5 | 2.5 | 3.5;

export type TicketMatch = {
  id: number;
  call: 2.5 | 3.5; // the Over call Predict made for this match
};

export type TicketOption = {
  matchId: number;
  line: TicketLine;
};

// The two options a match produces.
export function optionsFor(call: 2.5 | 3.5): [TicketLine, TicketLine] {
  return call === 3.5 ? [3.5, 2.5] : [2.5, 1.5];
}

// Ticket sizes for m matches (2m options). Fill tickets to 10 first, the
// remainder forms one smaller ticket. With 10 matches or fewer, every match
// must appear in two different tickets, so there are exactly two tickets of
// m matches each.
export function ticketSizes(m: number): number[] {
  const sizes: number[] = [];
  if (m <= 0) return sizes;
  if (m <= MAX_PER_TICKET) {
    sizes.push(m);
    sizes.push(m);
    return sizes;
  }
  const total = 2 * m;
  const full = Math.floor(total / MAX_PER_TICKET);
  const rest = total - full * MAX_PER_TICKET;
  for (let i = 0; i < full; i++) sizes.push(MAX_PER_TICKET);
  if (rest > 0) sizes.push(rest);
  return sizes;
}

// A loopless multigraph with these degrees exists exactly when the sum is
// even and the largest degree is at most the sum of the others.
function isFeasible(rem: number[]): boolean {
  let sum = 0;
  let max = 0;
  for (let i = 0; i < rem.length; i++) {
    sum += rem[i];
    if (rem[i] > max) max = rem[i];
  }
  return max * 2 <= sum;
}

function pickWeighted(rem: number[], skip: number, rand: () => number): number {
  let total = 0;
  for (let i = 0; i < rem.length; i++) if (i !== skip) total += rem[i];
  let r = rand() * total;
  let last = -1;
  for (let i = 0; i < rem.length; i++) {
    if (i === skip || rem[i] <= 0) continue;
    last = i;
    if (r < rem[i]) return i;
    r -= rem[i];
  }
  return last;
}

function twoLargest(rem: number[]): [number, number] {
  let a = -1;
  let b = -1;
  for (let i = 0; i < rem.length; i++) {
    if (a === -1 || rem[i] > rem[a]) {
      b = a;
      a = i;
    } else if (b === -1 || rem[i] > rem[b]) {
      b = i;
    }
  }
  return [a, b];
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// Generic core: every item has exactly two options (a pair). Places each
// option in a ticket so that all the ticket rules hold.
type PairItem = { id: number; pair: [string, string] };
type PairPlaced = { id: number; code: string };

function buildFromPairs(items: PairItem[], rand: () => number): PairPlaced[][] {
  const sizes = ticketSizes(items.length);
  const tickets: PairPlaced[][] = sizes.map(() => []);
  if (items.length === 0) return tickets;

  const rem = sizes.slice();
  const order = shuffle(items, rand);

  for (let k = 0; k < order.length; k++) {
    const m = order[k];
    let i = -1;
    let j = -1;

    for (let attempt = 0; attempt < 25; attempt++) {
      const a = pickWeighted(rem, -1, rand);
      const b = a < 0 ? -1 : pickWeighted(rem, a, rand);
      if (a < 0 || b < 0) continue;
      rem[a] -= 1;
      rem[b] -= 1;
      if (isFeasible(rem)) {
        i = a;
        j = b;
        break;
      }
      rem[a] += 1;
      rem[b] += 1;
    }
    if (i < 0) {
      const pair = twoLargest(rem);
      i = pair[0];
      j = pair[1];
      rem[i] -= 1;
      rem[j] -= 1;
    }

    const flip = rand() < 0.5;
    tickets[i].push({ id: m.id, code: flip ? m.pair[1] : m.pair[0] });
    tickets[j].push({ id: m.id, code: flip ? m.pair[0] : m.pair[1] });
  }

  return tickets.map((t) => shuffle(t, rand));
}

// Builds the tickets. Random every call. Every rule always holds.
// (Random, but not claimed to be perfectly uniform over all valid layouts.)
export function buildTickets(
  matches: TicketMatch[],
  rand: () => number = Math.random
): TicketOption[][] {
  const placed = buildFromPairs(
    matches.map((m) => {
      const o = optionsFor(m.call);
      return { id: m.id, pair: [String(o[0]), String(o[1])] as [string, string] };
    }),
    rand
  );
  return placed.map((t) =>
    t.map((p) => ({ matchId: p.id, line: Number(p.code) as TicketLine }))
  );
}

// Chance that a Poisson total with the given mean reaches at least `need`
// goals (need 2 = Over 1.5, 3 = Over 2.5, 4 = Over 3.5).
export function chanceAtLeast(mean: number, need: number): number {
  if (!(mean > 0)) return 0;
  const e = Math.exp(-mean);
  let term = e;
  let below = 0;
  for (let k = 0; k < need; k++) {
    below += term;
    term = (term * mean) / (k + 1);
  }
  const p = 1 - below;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

export function chanceOverLine(totalMean: number, line: TicketLine): number {
  const need = line === 1.5 ? 2 : line === 2.5 ? 3 : 4;
  return chanceAtLeast(totalMean, need);
}


// ── Random removal ────────────────────────────────────────────────────────
// How many of m matches to remove: percent of m rounded to the nearest whole
// match (exact integer arithmetic), never all of them.
export function removalCount(m: number, percent: number = ELIMINATE_PERCENT): number {
  if (m <= 1) return 0;
  const n = Math.floor((2 * m * percent + 100) / 200);
  if (n < 0) return 0;
  return n > m - 1 ? m - 1 : n;
}

// Removes removalCount(items.length) items at random. Both lists keep the
// original order. Random removal does not pick out losing matches: every
// match has the same chance of being removed.
export function eliminateRandom<T>(
  items: T[],
  percent: number = ELIMINATE_PERCENT,
  rand: () => number = Math.random
): { kept: T[]; removed: T[] } {
  const n = removalCount(items.length, percent);
  const order = shuffle(
    items.map((_, i) => i),
    rand
  );
  const gone: Record<number, boolean> = {};
  for (let i = 0; i < n; i++) gone[order[i]] = true;
  const kept: T[] = [];
  const removed: T[] = [];
  items.forEach((it, i) => {
    if (gone[i]) removed.push(it);
    else kept.push(it);
  });
  return { kept, removed };
}

// ── Parsing matches to store ──────────────────────────────────────────────
export type NewMatch = {
  name: string;
  nameKey: string;
  dataLine: string;
  league: string | null; // the league line above the match, if there was one
};
export type RejectedMatch = { label: string; reason: string };
export type ParseOutcome = {
  matches: NewMatch[];
  rejected: RejectedMatch[];
  duplicatesInPaste: number;
  leaguesFound: number; // different leagues among the accepted matches
};

// "20:45 Eastleigh - Southend" -> "Eastleigh - Southend"
export function cleanMatchName(raw: string): string {
  return raw
    .replace(/\*+$/, '')
    .trim()
    .replace(/^\d{1,2}:\d{2}\s+/, '')
    .trim();
}

// Same match name (ignoring capital letters and extra spaces) = same match.
export function matchKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

// "NORWAY:   Division 2 - Group 1 " -> "NORWAY: Division 2 - Group 1"
export function cleanLeague(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LEAGUE_LENGTH);
}

// 4 or 6 comma separated values whose last four are plain numbers.
function looksLikeDataLine(line: string): boolean {
  const parts = line.split(',');
  if (parts.length !== 4 && parts.length !== 6) return false;
  const nums = parts.slice(parts.length - 4);
  for (let i = 0; i < nums.length; i++) {
    if (!/^\d{1,9}(\.\d{1,9})?$/.test(nums[i].trim())) return false;
  }
  return true;
}

// Reads pasted matches (same format as Predict). A line that is not a match
// line and not a data line is a league line: it applies to every match below
// it until the next league line. A match is accepted only if Predict itself
// can read it, so a stored match always works later.
export function parseNewMatches(text: string): ParseOutcome {
  const lines = text.split('\n').map((l) => l.trim());
  const out: ParseOutcome = {
    matches: [],
    rejected: [],
    duplicatesInPaste: 0,
    leaguesFound: 0,
  };
  const indexByKey: Record<string, number> = {};
  let league: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(\d+)\)\s*(.*)$/);
    if (!head) {
      if (lines[i].length > 0 && !looksLikeDataLine(lines[i])) {
        const lg = cleanLeague(lines[i]);
        if (lg) league = lg;
      }
      continue;
    }
    const label = '#' + head[1];
    const name = cleanMatchName(head[2]);

    let j = i + 1;
    while (j < lines.length && lines[j].length === 0) j++;
    // A line without any comma is not a data line (it may be a league line,
    // which the loop then reads on its own).
    if (j >= lines.length || /^\d+\)/.test(lines[j]) || lines[j].indexOf(',') === -1) {
      out.rejected.push({ label, reason: 'no data line under it' });
      continue;
    }
    const dataLine = lines[j];
    i = j;

    if (!name || !/[a-zA-Z\u00C0-\uFFFF]/.test(name)) {
      out.rejected.push({ label, reason: 'no match name' });
      continue;
    }
    if (name.length > MAX_NAME_LENGTH) {
      out.rejected.push({ label, reason: 'name longer than ' + MAX_NAME_LENGTH + ' characters' });
      continue;
    }
    const check = runPrediction('1) ' + name + '\n' + dataLine);
    if (check.checked !== 1) {
      const why = check.skipped.length > 0 ? check.skipped[0].reason : 'could not read the numbers';
      out.rejected.push({ label, reason: why });
      continue;
    }

    const nameKey = matchKey(name);
    const item: NewMatch = { name, nameKey, dataLine, league };
    if (indexByKey[nameKey] !== undefined) {
      out.matches[indexByKey[nameKey]] = item; // later one replaces the earlier one
      out.duplicatesInPaste++;
    } else {
      indexByKey[nameKey] = out.matches.length;
      out.matches.push(item);
    }
  }

  const seen: Record<string, boolean> = {};
  out.matches.forEach((m) => {
    if (m.league) seen[m.league] = true;
  });
  out.leaguesFound = Object.keys(seen).length;
  return out;
}

// ── Planning: which stored matches have an Over call ──────────────────────
export type StoredMatch = { name: string; dataLine: string; league?: string | null };

export type PlannedMatch = {
  id: number; // 1-based position in the stored list
  name: string;
  league: string | null;
  call: 2.5 | 3.5;
  total: number; // eH + eA
};

export type Plan = {
  stored: number;
  matches: PlannedMatch[]; // matches with an Over call
  unreadable: string[]; // names Predict could not read (should not happen)
};

export function planMatches(stored: StoredMatch[]): Plan {
  const text = stored
    .map((m, i) => i + 1 + ') ' + m.name + '\n' + m.dataLine)
    .join('\n\n');
  const res = runPrediction(text);
  const planned: PlannedMatch[] = [];
  const add = (num: number, call: 2.5 | 3.5, total: number) => {
    const s = stored[num - 1];
    if (s) planned.push({ id: num, name: s.name, league: s.league || null, call, total });
  };
  res.over35.forEach((c) => add(c.num, 3.5, c.total));
  res.over25.forEach((c) => add(c.num, 2.5, c.total));
  planned.sort((a, b) => a.id - b.id);
  const unreadable = res.skipped.map((s) => (stored[s.num - 1] ? stored[s.num - 1].name : '#' + s.num));
  return { stored: stored.length, matches: planned, unreadable };
}

// ── Output ────────────────────────────────────────────────────────────────
// One message per ticket, then a short summary message.
// planned = the matches that are in the tickets; removed = the matches taken
// out at random before building (listed in the summary).
export function formatTickets(
  tickets: TicketOption[][],
  planned: PlannedMatch[],
  storedCount: number,
  removed: PlannedMatch[] = []
): string[] {
  const byId: Record<number, PlannedMatch> = {};
  planned.forEach((m) => {
    byId[m.id] = m;
  });

  const messages: string[] = [];
  tickets.forEach((ticket, ti) => {
    const rows = ticket.map((o) => {
      const m = byId[o.matchId];
      return {
        name: m.name,
        league: m.league,
        id: o.matchId,
        line: o.line,
        chance: chanceOverLine(m.total, o.line),
      };
    });
    rows.sort((a, b) => (b.chance !== a.chance ? b.chance - a.chance : a.id - b.id));
    const body = rows
      .map(
        (r, i) =>
          i + 1 + ') ' + r.name + (r.league ? '\n' + r.league : '') +
          '\nOver ' + r.line + ' · ' + Math.round(r.chance * 100) + '%'
      )
      .join('\n\n');
    messages.push(
      'TICKET ' + (ti + 1) + ' of ' + tickets.length + ' (' + ticket.length + ' ' +
        (ticket.length === 1 ? 'match' : 'matches') + ')\n\n' + body
    );
  });

  const lines: string[] = [];
  lines.push(
    tickets.length + ' tickets from ' + planned.length + ' matches (' + planned.length * 2 + ' options).'
  );
  if (removed.length > 0) {
    lines.push(
      'Removed at random (' + ELIMINATE_PERCENT + '%): ' +
        removed.map((m) => m.name).join(', ') + '.'
    );
  }
  const left = storedCount - planned.length - removed.length;
  if (left > 0) {
    lines.push(left + ' stored ' + (left === 1 ? 'match' : 'matches') + ' had no Over call and ' + (left === 1 ? 'was' : 'were') + ' left out.');
  }
  lines.push(
    'Every match appears in two different tickets, once per option, so if it ends with few goals both tickets lose that leg.'
  );
  lines.push(
    '% = model chance from expected goals (independent Poisson), an estimate, not a measured hit rate. The tickets are random every time.'
  );
  messages.push(lines.join('\n'));
  return messages;
}

// ═══════════════════════════════════════════════════════════════
// POOL TICKETS — Outcome calls and Over calls together.
//
// Pool (a match gets ONE entry, the call with the highest confidence):
//   every Home / Away call Predict makes (Draw calls are not used)
//   every Over 3.5 call at 50% or more
//   every Over 2.5 call at 60% or more
// Percentages are compared as shown in Predict (rounded to a whole number).
//
// Two options per match:
//   Home -> Home, Home/Draw (1X)        Away -> Away, Draw/Away (X2)
//   Over 3.5 -> Over 3.5, Over 2.5      Over 2.5 -> Over 2.5, Over 1.5
// Then the same ticket rules as before (buildFromPairs).
// After the tickets: the top Over 3.5 calls (at most 5, at 50% or more).
// ═══════════════════════════════════════════════════════════════

export const MIN_OUTCOME_PERCENT = 0;
export const MIN_OVER35_PERCENT = 50;
export const MIN_OVER25_PERCENT = 60;
export const TOP_OVER35_COUNT = 5;

export type PoolKind = 'home' | 'away' | 'over35' | 'over25';
export type OptionCode = 'H' | '1X' | 'A' | 'X2' | 'O1.5' | 'O2.5' | 'O3.5';

export const OPTION_LABEL: Record<OptionCode, string> = {
  H: 'Home',
  '1X': 'Home/Draw (1X)',
  A: 'Away',
  X2: 'Draw/Away (X2)',
  'O1.5': 'Over 1.5',
  'O2.5': 'Over 2.5',
  'O3.5': 'Over 3.5',
};

export function poolOptions(kind: PoolKind): [OptionCode, OptionCode] {
  if (kind === 'home') return ['H', '1X'];
  if (kind === 'away') return ['A', 'X2'];
  if (kind === 'over35') return ['O3.5', 'O2.5'];
  return ['O2.5', 'O1.5'];
}

export type PoolMatch = {
  id: number; // 1-based position in the stored list
  name: string;
  league: string | null;
  kind: PoolKind;
  confidence: number; // chance of the main call, 0..1
  chances: Partial<Record<OptionCode, number>>; // chance of each of its two options
};

export type TopOver35 = {
  id: number;
  name: string;
  league: string | null;
  over35: number; // the Over 3.5 chance Predict shows
  over25: number; // the same match as Over 2.5
};

export type PoolPlan = {
  stored: number;
  pool: PoolMatch[];
  top: TopOver35[];
  unreadable: string[];
};

function bigGcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== BigInt(0)) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

// (x + y) / 2 for two plain decimals, calculated exactly and then turned into
// a number the same way predict.ts does it, so the result is identical.
function halfSum(x: string, y: string): number | null {
  const sx = x.trim();
  const sy = y.trim();
  const re = /^\d{1,9}(\.\d{1,9})?$/;
  if (!re.test(sx) || !re.test(sy)) return null;
  const scaled = (t: string): bigint => {
    const dot = t.indexOf('.');
    const whole = dot === -1 ? t : t.slice(0, dot);
    let frac = dot === -1 ? '' : t.slice(dot + 1);
    while (frac.length < 9) frac += '0';
    return BigInt(whole + frac);
  };
  let n = scaled(sx) + scaled(sy);
  let d = BigInt(2000000000);
  const g = bigGcd(n, d);
  if (g > BigInt(1)) {
    n = n / g;
    d = d / g;
  }
  return Number(n) / Number(d);
}

export function expectedGoals(dataLine: string): { eH: number; eA: number } | null {
  const parts = dataLine.split(',').map((p) => p.trim());
  const nums = parts.length === 6 ? parts.slice(2) : parts;
  if (nums.length !== 4) return null;
  const eH = halfSum(nums[0], nums[3]); // a1 + b2
  const eA = halfSum(nums[2], nums[1]); // b1 + a2
  if (eH === null || eA === null) return null;
  return { eH, eA };
}

const percentShown = (c: number): number => Math.round(c * 100);
const cap1 = (x: number): number => (x > 1 ? 1 : x < 0 ? 0 : x);

export function planPool(stored: StoredMatch[]): PoolPlan {
  const text = stored
    .map((m, i) => i + 1 + ') ' + m.name + '\n' + m.dataLine)
    .join('\n\n');
  const res = runPrediction(text);
  const byNum: Record<number, PoolMatch> = {};

  const offer = (cand: PoolMatch) => {
    const have = byNum[cand.id];
    if (!have || cand.confidence > have.confidence) byNum[cand.id] = cand;
  };
  const base = (num: number) => {
    const s = stored[num - 1];
    return s ? { id: num, name: s.name, league: s.league || null } : null;
  };

  res.outcomes.forEach((o) => {
    if (o.side === 'Draw') return;
    if (percentShown(o.confidence) < MIN_OUTCOME_PERCENT) return;
    const b = base(o.num);
    const eg = b ? expectedGoals(stored[o.num - 1].dataLine) : null;
    if (!b || !eg) return;
    const ch = outcomeChances(eg.eH, eg.eA);
    if (o.side === 'Home') {
      offer({ ...b, kind: 'home', confidence: o.confidence, chances: { H: o.confidence, '1X': cap1(ch.home + ch.draw) } });
    } else {
      offer({ ...b, kind: 'away', confidence: o.confidence, chances: { A: o.confidence, X2: cap1(ch.away + ch.draw) } });
    }
  });
  res.over35.forEach((o) => {
    if (percentShown(o.confidence) < MIN_OVER35_PERCENT) return;
    const b = base(o.num);
    if (!b) return;
    offer({ ...b, kind: 'over35', confidence: o.confidence, chances: { 'O3.5': o.confidence, 'O2.5': chanceOverLine(o.total, 2.5) } });
  });
  res.over25.forEach((o) => {
    if (percentShown(o.confidence) < MIN_OVER25_PERCENT) return;
    const b = base(o.num);
    if (!b) return;
    offer({ ...b, kind: 'over25', confidence: o.confidence, chances: { 'O2.5': o.confidence, 'O1.5': chanceOverLine(o.total, 1.5) } });
  });

  const pool = Object.keys(byNum)
    .map((k) => byNum[Number(k)])
    .sort((a, b) => a.id - b.id);

  const top: TopOver35[] = [];
  res.over35.forEach((o) => {
    if (top.length >= TOP_OVER35_COUNT) return;
    if (percentShown(o.confidence) < MIN_OVER35_PERCENT) return;
    const b = base(o.num);
    if (!b) return;
    top.push({ ...b, over35: o.confidence, over25: chanceOverLine(o.total, 2.5) });
  });

  const unreadable = res.skipped.map((s) => (stored[s.num - 1] ? stored[s.num - 1].name : '#' + s.num));
  return { stored: stored.length, pool, top, unreadable };
}

export type PoolTicketOption = { matchId: number; option: OptionCode };

export function buildPoolTickets(
  items: { id: number; kind: PoolKind }[],
  rand: () => number = Math.random
): PoolTicketOption[][] {
  const placed = buildFromPairs(
    items.map((m) => {
      const o = poolOptions(m.kind);
      return { id: m.id, pair: [o[0], o[1]] as [string, string] };
    }),
    rand
  );
  return placed.map((t) =>
    t.map((p) => ({ matchId: p.id, option: p.code as OptionCode }))
  );
}

export function countByKind(pool: PoolMatch[]): { home: number; away: number; over35: number; over25: number } {
  const c = { home: 0, away: 0, over35: 0, over25: 0 };
  pool.forEach((m) => {
    c[m.kind] += 1;
  });
  return c;
}

// Messages: one per ticket, then a summary, then the top Over 3.5 list.
// pool = the matches that are in the tickets; removed = taken out at random.
export function formatPoolTickets(
  tickets: PoolTicketOption[][],
  pool: PoolMatch[],
  storedCount: number,
  removed: PoolMatch[],
  top: TopOver35[]
): string[] {
  const byId: Record<number, PoolMatch> = {};
  pool.forEach((m) => {
    byId[m.id] = m;
  });

  const messages: string[] = [];
  tickets.forEach((ticket, ti) => {
    const rows = ticket.map((o) => {
      const m = byId[o.matchId];
      return { name: m.name, league: m.league, id: o.matchId, option: o.option, chance: m.chances[o.option] || 0 };
    });
    rows.sort((a, b) => (b.chance !== a.chance ? b.chance - a.chance : a.id - b.id));
    const body = rows
      .map(
        (r, i) =>
          i + 1 + ') ' + r.name + (r.league ? '\n' + r.league : '') +
          '\n' + OPTION_LABEL[r.option] + ' · ' + Math.round(r.chance * 100) + '%'
      )
      .join('\n\n');
    messages.push(
      'TICKET ' + (ti + 1) + ' of ' + tickets.length + ' (' + ticket.length + ' ' +
        (ticket.length === 1 ? 'match' : 'matches') + ')\n\n' + body
    );
  });

  const k = countByKind(pool);
  const lines: string[] = [];
  lines.push(tickets.length + ' tickets from ' + pool.length + ' matches (' + pool.length * 2 + ' options).');
  lines.push('In the tickets: ' + k.home + ' Home, ' + k.away + ' Away, ' + k.over35 + ' Over 3.5, ' + k.over25 + ' Over 2.5.');
  if (removed.length > 0) {
    lines.push('Removed at random (' + ELIMINATE_PERCENT + '%): ' + removed.map((m) => m.name).join(', ') + '.');
  }
  const left = storedCount - pool.length - removed.length;
  if (left > 0) {
    lines.push(left + ' stored ' + (left === 1 ? 'match' : 'matches') + ' did not qualify and ' + (left === 1 ? 'was' : 'were') + ' left out.');
  }
  lines.push('Every match appears in two different tickets, once per option, so if it goes wrong both tickets lose that leg.');
  lines.push('% = model chance from expected goals (independent Poisson), an estimate, not a measured hit rate. The tickets are random every time.');
  messages.push(lines.join('\n'));

  if (top.length === 0) {
    messages.push('TOP OVER 3.5\n\nNo Over 3.5 call at ' + MIN_OVER35_PERCENT + '% or more this time.');
  } else {
    const removedIds: Record<number, boolean> = {};
    removed.forEach((m) => {
      removedIds[m.id] = true;
    });
    const body = top
      .map(
        (t, i) =>
          i + 1 + ') ' + t.name + (t.league ? '\n' + t.league : '') +
          '\nOver 3.5 · ' + Math.round(t.over35 * 100) + '% (as Over 2.5: ' + Math.round(t.over25 * 100) + '%)' +
          (removedIds[t.id] ? '\n(removed at random, not in the tickets)' : '')
      )
      .join('\n\n');
    messages.push(
      'TOP OVER 3.5 (highest first)\n\n' + body +
        '\n\nThese matches are also in the tickets above. In your past results the Over 3.5 % ran about 5 points higher than what happened; the Over 2.5 % was close.'
    );
  }
  return messages;
}

// ═══════════════════════════════════════════════════════════════
// TEAM LISTS — which TEAMS are predicted to score.
//
// For every stored match and each of its two teams, look at the goals the two
// formulas predict for that team (a "5" means 5 or more):
//   both formulas 3 or more                  -> "Teams to score Over 1.5"
//   both formulas 2 or more, not both 3+     -> "Teams to score Over 0.5"
//   anything else                            -> not listed
// A team is in at most one list. The lists use ALL stored matches (the random
// removal and the Outcome / Over thresholds do not apply to them).
//
// Confidence = chance the team scores at least 2 goals (Over 1.5) or at least
// 1 goal (Over 0.5), goals ~ Poisson(the team's expected goals). An estimate,
// not a measured hit rate.
// ═══════════════════════════════════════════════════════════════

export type TeamEntry = {
  team: string;
  matchLine: string; // "A vs B"
  league: string | null;
  confidence: number; // 0..1
  order: number; // position in the stored list, home before away
};

export type TeamLists = { over15: TeamEntry[]; over05: TeamEntry[] };

// "Home - Away", "Home vs Away" or "Home v Away" -> the two team names.
export function splitTeams(name: string): { home: string; away: string } | null {
  const m = name.match(/^(.+?)\s+(?:-|vs\.?|v)\s+(.+)$/i);
  if (!m) return null;
  const home = m[1].trim();
  const away = m[2].trim();
  if (!home || !away) return null;
  return { home, away };
}

export function planTeams(stored: StoredMatch[]): TeamLists {
  const over15: TeamEntry[] = [];
  const over05: TeamEntry[] = [];

  stored.forEach((m, idx) => {
    const parts = m.dataLine.split(',').map((p) => p.trim());
    const nums = parts.length === 6 ? parts.slice(2) : parts;
    if (nums.length !== 4) return;
    const cs = calibratedScores(nums[0], nums[1], nums[2], nums[3]);
    const eg = expectedGoals(m.dataLine);
    if (!cs || !eg) return;
    const teams = splitTeams(m.name);
    const league = m.league || null;
    const sides: { side: 'home' | 'away'; lam: number; p: number; x: number }[] = [
      { side: 'home', lam: eg.eH, p: cs.prod.home, x: cs.exp.home },
      { side: 'away', lam: eg.eA, p: cs.prod.away, x: cs.exp.away },
    ];
    sides.forEach((s, k) => {
      const low = Math.min(s.p, s.x);
      if (low < 2) return;
      const team = teams
        ? s.side === 'home' ? teams.home : teams.away
        : (s.side === 'home' ? 'Home team' : 'Away team') + ' of ' + m.name;
      const entry: TeamEntry = {
        team,
        matchLine: teams ? teams.home + ' vs ' + teams.away : m.name,
        league,
        confidence: chanceAtLeast(s.lam, low >= 3 ? 2 : 1),
        order: idx * 2 + k,
      };
      if (low >= 3) over15.push(entry);
      else over05.push(entry);
    });
  });

  const byConfidence = (a: TeamEntry, b: TeamEntry): number =>
    b.confidence !== a.confidence ? b.confidence - a.confidence : a.order - b.order;
  over15.sort(byConfidence);
  over05.sort(byConfidence);
  return { over15, over05 };
}

// One list as one or more messages (each under about 3,500 characters). The
// title is glued to the first entry, the note goes at the end.
function formatTeamList(title: string, label: string, entries: TeamEntry[], note: string): string[] {
  if (entries.length === 0) {
    return [title + '\n\nNone this time.'];
  }
  const blocks = entries.map(
    (e, i) =>
      i + 1 + ') ' + e.team + ' ' + label + ' ' + Math.round(e.confidence * 100) + '%\n' +
      e.matchLine + (e.league ? ' (' + e.league + ')' : '')
  );
  const chunks: string[] = [];
  let current = title + '\n\n' + blocks[0];
  for (let i = 1; i < blocks.length; i++) {
    if (current.length + blocks[i].length + 2 > 3500) {
      chunks.push(current);
      current = blocks[i];
    } else {
      current += '\n\n' + blocks[i];
    }
  }
  if (current.length + note.length + 2 > 3900) {
    chunks.push(current);
    chunks.push(note);
  } else {
    chunks.push(current + '\n\n' + note);
  }
  return chunks;
}

export function formatTeamLists(lists: TeamLists): string[] {
  const a = formatTeamList(
    'Teams to score Over 1.5:',
    'Over 1.5',
    lists.over15,
    '% = the model chance the team scores at least 2 goals, an estimate. In your past results it was close overall, but away teams ran about 8 points higher than what happened.'
  );
  const b = formatTeamList(
    'Teams to score Over 0.5:',
    'Over 0.5',
    lists.over05,
    '% = the model chance the team scores at least 1 goal, an estimate. In your past results it ran about 4 points higher than what happened.'
  );
  return a.concat(b);
}
