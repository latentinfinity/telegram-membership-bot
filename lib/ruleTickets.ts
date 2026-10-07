// ═══════════════════════════════════════════════════════════════
// RULE TICKETS — tickets built from the two correct-score formulas.
// Pure functions, no DB / Telegram imports. Only ./correctScore.
//
// Each stored match gets calibrated scores from both formulas
// (prod = Formula 1, exp = Formula 2; 5 means "5+"). EVERY condition
// below must hold in BOTH formulas.
//
//   Home      : away 0, home 2+ (2:0 or better)   -> played as 1X
//   Away      : home 0, away 2+                    -> played as X2
//   1X        : both are home wins, exactly one is 2:0 or better
//   X2        : both are away wins, exactly one is 0:2 or better
//   Over 3.5  : both teams 2+, total 5+            -> played as Over 2.5
//   Over 2.5  : both teams 1+, total 4+, and not Over 3.5
//                                                   -> played as Over 1.5
//   Over 1.5  : total exactly 3
//   BTTS Yes  : both teams 2+
//   Under 3.5 : score is 0:0, 1:0 or 0:1
//   Team Over 1.5 : that team 3+
//
// One match can carry several legs. A ticket holds at most ONE leg per
// match. Every leg is used at most once across all tickets.
//
// No percentages are used anywhere. The rules were fitted on past
// matches (see TRAINING_ROWS) and no accuracy is promised.
// ═══════════════════════════════════════════════════════════════

import { calibratedScores, TRAINING_ROWS } from './correctScore';

// ── Quick-change constants ────────────────────────────────────────────────
export const MIN_PER_TICKET = 5;
export const MAX_PER_TICKET = 15;
export const BUFFER_PERCENT = 20; // longest ticket = (100 - this)% of M
export const TOP_OVER35_COUNT = 5;
const MAX_NAME_SHOWN = 60;
const MAX_LEAGUE_SHOWN = 60;
const MAX_TEAM_SHOWN = 40;

// ── Types ─────────────────────────────────────────────────────────────────
export type RuleRow = {
  name: string;
  data_line: string;
  league: string | null;
};

export type ScorePair = { home: number; away: number };

export type CallKind =
  | 'home'
  | 'away'
  | 'x1'
  | 'x2'
  | 'over35'
  | 'over25'
  | 'over15'
  | 'btts'
  | 'under35'
  | 'home_t15'
  | 'away_t15';

export type Leg = { label: string; group: string };

export type Analysed = {
  name: string;
  league: string | null;
  calls: CallKind[];
  legs: Leg[];
  isOver35: boolean;
  rankTotal: number; // sum of the four averages (ranking only)
};

export type RulePlan = {
  stored: number;
  unreadable: string[];
  withCalls: Analysed[];
  noCallCount: number;
  matchCount: number; // M
  legCount: number;
  cap: number;
  canBuild: boolean;
  reason: string | null;
  top35: Analysed[];
};

export type DealtLeg = { matchIndex: number; leg: Leg };

export type DealResult = {
  tickets: DealtLeg[][];
  leftovers: DealtLeg[];
};

// ── The rules (pure, testable over every score pair) ──────────────────────
export function callsFromScores(p: ScorePair, e: ScorePair): CallKind[] {
  function both(test: (h: number, a: number) => boolean): boolean {
    return test(p.home, p.away) && test(e.home, e.away);
  }
  function homeBig(s: ScorePair): boolean {
    return s.away === 0 && s.home >= 2;
  }
  function awayBig(s: ScorePair): boolean {
    return s.home === 0 && s.away >= 2;
  }

  const out: CallKind[] = [];

  if (both(function (h, a) { return a === 0 && h >= 2; })) out.push('home');
  if (both(function (h, a) { return h === 0 && a >= 2; })) out.push('away');

  const homeBigCount = (homeBig(p) ? 1 : 0) + (homeBig(e) ? 1 : 0);
  const awayBigCount = (awayBig(p) ? 1 : 0) + (awayBig(e) ? 1 : 0);
  if (both(function (h, a) { return h > a; }) && homeBigCount === 1) out.push('x1');
  if (both(function (h, a) { return a > h; }) && awayBigCount === 1) out.push('x2');

  const isOver35 = both(function (h, a) { return h >= 2 && a >= 2 && h + a >= 5; });
  if (isOver35) out.push('over35');
  if (
    !isOver35 &&
    both(function (h, a) { return h >= 1 && a >= 1 && h + a >= 4; })
  ) {
    out.push('over25');
  }
  if (both(function (h, a) { return h + a === 3; })) out.push('over15');

  if (both(function (h, a) { return h >= 2 && a >= 2; })) out.push('btts');

  if (
    both(function (h, a) {
      return (h === 0 && a === 0) || (h === 1 && a === 0) || (h === 0 && a === 1);
    })
  ) {
    out.push('under35');
  }

  if (both(function (h) { return h >= 3; })) out.push('home_t15');
  if (both(function (h, a) { return a >= 3; })) out.push('away_t15');

  return out;
}

// ── Names ─────────────────────────────────────────────────────────────────
function shorten(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 3).trim() + '...';
}

export function splitTeams(name: string): { home: string; away: string } {
  const lower = name.toLowerCase();
  const seps = [' - ', ' vs ', ' v '];
  let bestIdx = -1;
  let bestLen = 0;
  for (let k = 0; k < seps.length; k++) {
    const i = lower.indexOf(seps[k]);
    if (i > 0 && (bestIdx === -1 || i < bestIdx)) {
      bestIdx = i;
      bestLen = seps[k].length;
    }
  }
  if (bestIdx !== -1) {
    const h = name.slice(0, bestIdx).trim();
    const a = name.slice(bestIdx + bestLen).trim();
    if (h.length > 0 && a.length > 0) return { home: h, away: a };
  }
  return { home: 'Home team of ' + name, away: 'Away team of ' + name };
}

function legFor(kind: CallKind, teams: { home: string; away: string }): Leg {
  switch (kind) {
    case 'home':
    case 'x1':
      return { label: '1X', group: '1X' };
    case 'away':
    case 'x2':
      return { label: 'X2', group: 'X2' };
    case 'over35':
      return { label: 'Over 2.5', group: 'Over 2.5' };
    case 'over25':
    case 'over15':
      return { label: 'Over 1.5', group: 'Over 1.5' };
    case 'btts':
      return { label: 'BTTS Yes', group: 'BTTS Yes' };
    case 'under35':
      return { label: 'Under 3.5', group: 'Under 3.5' };
    case 'home_t15':
      return { label: shorten(teams.home, MAX_TEAM_SHOWN) + ' Over 1.5', group: 'Team Over 1.5' };
    default:
      return { label: shorten(teams.away, MAX_TEAM_SHOWN) + ' Over 1.5', group: 'Team Over 1.5' };
  }
}

// ── One stored match -> its calls and legs ────────────────────────────────
// Stored data lines have 4 values (a1,a2,b1,b2) or 6 (form,form,a1,a2,b1,b2).
// Returns null if the line cannot be read.
export function analyseMatch(row: RuleRow): Analysed | null {
  const parts = row.data_line.split(',').map(function (s) { return s.trim(); });
  let nums: string[];
  if (parts.length === 4) nums = parts;
  else if (parts.length === 6) nums = parts.slice(2);
  else return null;

  const cs = calibratedScores(nums[0], nums[1], nums[2], nums[3]);
  if (!cs) return null;

  const calls = callsFromScores(cs.prod, cs.exp);
  const teams = splitTeams(row.name);

  // one leg per label per match (a match cannot carry the same bet twice)
  const legs: Leg[] = [];
  const seen: { [label: string]: boolean } = {};
  for (let i = 0; i < calls.length; i++) {
    const leg = legFor(calls[i], teams);
    if (!seen[leg.label]) {
      seen[leg.label] = true;
      legs.push(leg);
    }
  }

  const total =
    parseFloat(nums[0]) + parseFloat(nums[1]) + parseFloat(nums[2]) + parseFloat(nums[3]);

  return {
    name: row.name,
    league: row.league,
    calls: calls,
    legs: legs,
    isOver35: calls.indexOf('over35') !== -1,
    rankTotal: total,
  };
}

// ── The plan: who has calls, how long tickets may be ──────────────────────
export function planRules(rows: RuleRow[]): RulePlan {
  const withCalls: Analysed[] = [];
  const unreadable: string[] = [];
  let noCallCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const a = analyseMatch(rows[i]);
    if (!a) {
      unreadable.push(rows[i].name);
    } else if (a.legs.length === 0) {
      noCallCount++;
    } else {
      withCalls.push(a);
    }
  }

  const m = withCalls.length;
  let legCount = 0;
  for (let i = 0; i < m; i++) legCount += withCalls[i].legs.length;

  const cap = Math.min(MAX_PER_TICKET, Math.floor((m * (100 - BUFFER_PERCENT)) / 100));
  const canBuild = cap >= MIN_PER_TICKET;

  let reason: string | null = null;
  if (!canBuild) {
    reason =
      'Only ' + m + ' stored match' + (m === 1 ? ' has' : 'es have') +
      ' a call. At least 7 are needed (a ticket needs ' + MIN_PER_TICKET +
      ' legs and the longest allowed is ' + (100 - BUFFER_PERCENT) + '% of the matches with a call).';
  }

  // Top Over 3.5: matches that meet the Over 3.5 rule, highest expected goals first.
  const over: { a: Analysed; idx: number }[] = [];
  for (let i = 0; i < m; i++) {
    if (withCalls[i].isOver35) over.push({ a: withCalls[i], idx: i });
  }
  over.sort(function (x, y) {
    if (y.a.rankTotal !== x.a.rankTotal) return y.a.rankTotal - x.a.rankTotal;
    return x.idx - y.idx;
  });
  const top35 = over.slice(0, TOP_OVER35_COUNT).map(function (o) { return o.a; });

  return {
    stored: rows.length,
    unreadable: unreadable,
    withCalls: withCalls,
    noCallCount: noCallCount,
    matchCount: m,
    legCount: legCount,
    cap: cap,
    canBuild: canBuild,
    reason: reason,
    top35: top35,
  };
}

// ── Dealing the tickets ───────────────────────────────────────────────────
// Each ticket: matches not yet used in any ticket first, then matches with
// the most legs left, ties random. Up to `cap` matches, one random leg of
// each. Stops when fewer than MIN_PER_TICKET different matches have a leg
// left; the rest are returned as leftovers (never dropped silently).
export function dealTickets(plan: RulePlan, rnd?: () => number): DealResult {
  const random = rnd || Math.random;
  const m = plan.withCalls.length;
  const left: Leg[][] = [];
  const used: boolean[] = [];
  for (let i = 0; i < m; i++) {
    left.push(plan.withCalls[i].legs.slice());
    used.push(false);
  }

  const tickets: DealtLeg[][] = [];
  if (!plan.canBuild) return { tickets: tickets, leftovers: collectLeft(left) };

  while (true) {
    const avail: { idx: number; r: number }[] = [];
    for (let i = 0; i < m; i++) {
      if (left[i].length > 0) avail.push({ idx: i, r: random() });
    }
    if (avail.length < MIN_PER_TICKET) break;

    avail.sort(function (x, y) {
      const ux = used[x.idx] ? 1 : 0;
      const uy = used[y.idx] ? 1 : 0;
      if (ux !== uy) return ux - uy;
      const lx = left[x.idx].length;
      const ly = left[y.idx].length;
      if (lx !== ly) return ly - lx;
      return x.r - y.r;
    });

    const take = Math.min(plan.cap, avail.length);
    const picked: number[] = [];
    for (let k = 0; k < take; k++) picked.push(avail[k].idx);
    picked.sort(function (x, y) { return x - y; }); // keep stored order

    const ticket: DealtLeg[] = [];
    for (let k = 0; k < picked.length; k++) {
      const mi = picked[k];
      const pos = Math.min(left[mi].length - 1, Math.floor(random() * left[mi].length));
      const leg = left[mi].splice(pos, 1)[0];
      used[mi] = true;
      ticket.push({ matchIndex: mi, leg: leg });
    }
    tickets.push(ticket);
  }

  return { tickets: tickets, leftovers: collectLeft(left) };
}

function collectLeft(left: Leg[][]): DealtLeg[] {
  const out: DealtLeg[] = [];
  for (let i = 0; i < left.length; i++) {
    for (let k = 0; k < left[i].length; k++) out.push({ matchIndex: i, leg: left[i][k] });
  }
  return out;
}

// ── Confirmation text (before creating) ───────────────────────────────────
export function describePlan(plan: RulePlan): string {
  const lines: string[] = [];
  if (!plan.canBuild) {
    lines.push('No tickets can be made. Nothing changed.');
    lines.push('');
    lines.push('Stored matches: ' + plan.stored);
    lines.push('With at least one call: ' + plan.matchCount);
    if (plan.reason) lines.push(plan.reason);
    return lines.join('\n');
  }
  lines.push('Create tickets now?');
  lines.push('');
  lines.push('Stored matches: ' + plan.stored);
  lines.push('With at least one call: ' + plan.matchCount + ' (' + plan.legCount + ' legs)');
  lines.push('No call, left out: ' + plan.noCallCount);
  lines.push(
    'Ticket length: ' + MIN_PER_TICKET + ' to ' + plan.cap + ' matches (' +
      (100 - BUFFER_PERCENT) + '% of ' + plan.matchCount + ', never above ' + MAX_PER_TICKET + ')'
  );
  lines.push('Top Over 3.5 list after the tickets: ' + plan.top35.length + ' match' + (plan.top35.length === 1 ? '' : 'es'));
  lines.push('');
  lines.push('The number of tickets depends on how the legs are dealt when you confirm.');
  lines.push('The storage is emptied when the tickets are created. If sending fails, your matches are put back.');
  return lines.join('\n');
}

// ── Output messages ───────────────────────────────────────────────────────
const GROUP_ORDER = [
  '1X',
  'X2',
  'Over 2.5',
  'Over 1.5',
  'BTTS Yes',
  'Under 3.5',
  'Team Over 1.5',
];

export function formatTicketMessages(plan: RulePlan, deal: DealResult): string[] {
  const total = deal.tickets.length;
  const out: string[] = [];
  for (let t = 0; t < total; t++) {
    const ticket = deal.tickets[t];
    const lines: string[] = [];
    lines.push('TICKET ' + (t + 1) + ' of ' + total + ' (' + ticket.length + ' matches)');
    lines.push('');
    for (let k = 0; k < ticket.length; k++) {
      const a = plan.withCalls[ticket[k].matchIndex];
      lines.push((k + 1) + ') ' + shorten(a.name, MAX_NAME_SHOWN));
      if (a.league) lines.push(shorten(a.league, MAX_LEAGUE_SHOWN));
      lines.push(ticket[k].leg.label);
      lines.push('');
    }
    out.push(lines.join('\n').trim());
  }
  return out;
}

export function formatSummary(plan: RulePlan, deal: DealResult): string {
  const lines: string[] = [];
  let dealt = 0;
  const counts: { [group: string]: number } = {};
  for (let t = 0; t < deal.tickets.length; t++) {
    for (let k = 0; k < deal.tickets[t].length; k++) {
      dealt++;
      const g = deal.tickets[t][k].leg.group;
      counts[g] = (counts[g] || 0) + 1;
    }
  }

  lines.push(
    deal.tickets.length + ' ticket' + (deal.tickets.length === 1 ? '' : 's') +
      ' from ' + plan.matchCount + ' matches with a call (' + dealt + ' of ' + plan.legCount + ' legs used).'
  );
  lines.push(
    'Ticket length allowed: ' + MIN_PER_TICKET + ' to ' + plan.cap + ' (' +
      (100 - BUFFER_PERCENT) + '% of ' + plan.matchCount + ', never above ' + MAX_PER_TICKET + ').'
  );

  const parts: string[] = [];
  for (let i = 0; i < GROUP_ORDER.length; i++) {
    const n = counts[GROUP_ORDER[i]] || 0;
    if (n > 0) parts.push(n + ' ' + GROUP_ORDER[i]);
  }
  if (parts.length > 0) lines.push('In the tickets: ' + parts.join(', ') + '.');

  if (deal.leftovers.length > 0) {
    const names: string[] = [];
    for (let i = 0; i < deal.leftovers.length; i++) {
      const l = deal.leftovers[i];
      names.push(shorten(plan.withCalls[l.matchIndex].name, MAX_NAME_SHOWN) + ' (' + l.leg.label + ')');
    }
    lines.push('Not used, fewer than ' + MIN_PER_TICKET + ' different matches were left: ' + names.join('; ') + '.');
  }
  if (plan.noCallCount > 0) {
    lines.push(plan.noCallCount + ' stored match' + (plan.noCallCount === 1 ? '' : 'es') + ' had no call and ' + (plan.noCallCount === 1 ? 'was' : 'were') + ' left out.');
  }
  if (plan.unreadable.length > 0) {
    lines.push('Could not be read: ' + plan.unreadable.join('; ') + '.');
  }

  lines.push('');
  lines.push('Played as: Over 3.5 as Over 2.5, Over 2.5 as Over 1.5, Home as 1X, Away as X2.');
  lines.push('A match sits in one ticket per leg it has, so one bad result can sink several tickets.');
  lines.push('The rules were fitted on ' + TRAINING_ROWS + ' past matches. No accuracy is promised and no result is recorded.');
  return lines.join('\n');
}

export function formatTopOver35(plan: RulePlan, deal: DealResult): string {
  const lines: string[] = [];
  lines.push('TOP OVER 3.5 (highest expected goals first)');
  lines.push('Rule: both formulas give both teams 2 or more and 5 or more goals in total.');
  lines.push('');
  if (plan.top35.length === 0) {
    lines.push('No match meets the Over 3.5 rule this time.');
    return lines.join('\n');
  }

  for (let i = 0; i < plan.top35.length; i++) {
    const a = plan.top35[i];
    const idx = plan.withCalls.indexOf(a);
    let inTickets = false;
    for (let t = 0; t < deal.tickets.length && !inTickets; t++) {
      for (let k = 0; k < deal.tickets[t].length; k++) {
        const d = deal.tickets[t][k];
        if (d.matchIndex === idx && d.leg.label === 'Over 2.5') inTickets = true;
      }
    }
    lines.push((i + 1) + ') ' + shorten(a.name, MAX_NAME_SHOWN));
    if (a.league) lines.push(shorten(a.league, MAX_LEAGUE_SHOWN));
    lines.push(
      'Over 3.5 ' +
        (inTickets
          ? '(in the tickets as Over 2.5)'
          : '(its Over 2.5 leg was not used in the tickets)')
    );
    lines.push('');
  }
  lines.push(
    'On ' + TRAINING_ROWS + ' past matches this rule hit Over 3.5 about 52% of the time. The cut points were fitted on those same matches, so new matches may do worse.'
  );
  return lines.join('\n');
}
