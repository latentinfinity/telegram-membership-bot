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

import { runPrediction } from './predict';

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

// Builds the tickets. Random every call. Every rule always holds.
// (Random, but not claimed to be perfectly uniform over all valid layouts.)
export function buildTickets(
  matches: TicketMatch[],
  rand: () => number = Math.random
): TicketOption[][] {
  const sizes = ticketSizes(matches.length);
  const tickets: TicketOption[][] = sizes.map(() => []);
  if (matches.length === 0) return tickets;

  const rem = sizes.slice();
  const order = shuffle(matches, rand);

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

    const opts = optionsFor(m.call);
    const flip = rand() < 0.5;
    tickets[i].push({ matchId: m.id, line: flip ? opts[1] : opts[0] });
    tickets[j].push({ matchId: m.id, line: flip ? opts[0] : opts[1] });
  }

  return tickets.map((t) => shuffle(t, rand));
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
