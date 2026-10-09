// ═══════════════════════════════════════════════════════════════
// PAIR TICKETS — tickets from the best matches, two options each.
// Pure functions, no DB / Telegram imports. Only ./confidence.
//
// POOL: matches where BOTH formulas give BOTH teams 2 or more (the
// Confidence "Over 2.5" group). Only pool matches can earn options.
//
// Options a pool match EARNS (a1 home scored, a2 home conceded,
// b1 away scored, b2 away conceded; eH = (a1+b2)/2, eA = (b1+a2)/2):
//   Over 2.5            : total (eH + eA) >= 3.8
//   BTTS Yes            : weaker side min(eH, eA) >= 1.8
//   BTTS Yes + Over 2.5 : both of the two rules above
//   Over 3.5            : total >= 4.0
//
// A match that earns more than two options gets TWO of them, picked at
// random (no preference). A match that earns one gets one. A match that
// earns none is not used.
//
// TICKETS: 4 to 7 matches each, any size in that range with no preferred
// size. A ticket never holds the same match twice. Every leg (match +
// option) is used at most once. Which leg of a match goes into which
// ticket is random. To avoid wasting legs, 200 random layouts are drawn
// and one that leaves the fewest legs unused is kept (ties random).
// No percentages are used. No accuracy is promised.
// ═══════════════════════════════════════════════════════════════

import { planConfidence } from './confidence';
import type { ConfidencePick } from './confidence';
import { TRAINING_ROWS } from './correctScore';

// ── Quick-change constants ────────────────────────────────────────────────
export const PAIR_MIN_PER_TICKET = 4;
export const PAIR_MAX_PER_TICKET = 7;
export const OPTIONS_PER_MATCH = 2;
export const LAYOUT_TRIES = 200;
const MAX_NAME_SHOWN = 60;
const MAX_LEAGUE_SHOWN = 60;

// ── Types ─────────────────────────────────────────────────────────────────
export type PairRow = {
  name: string;
  data_line: string;
  league: string | null;
};

export type PairOption = 'over25' | 'btts' | 'combo' | 'over35';

export const PAIR_OPTION_LABEL: { [k: string]: string } = {
  over25: 'Over 2.5',
  btts: 'BTTS Yes',
  combo: 'BTTS Yes + Over 2.5',
  over35: 'Over 3.5',
};

export type PairMatch = {
  name: string;
  league: string | null;
  earned: PairOption[]; // everything the match earned (1 to 4)
};

export type PairPlan = {
  stored: number;
  unreadable: string[];
  poolCount: number; // matches in the 2+ pool
  matches: PairMatch[]; // pool matches that earned at least one option
  noOptionCount: number; // stored matches that earned nothing
  canBuild: boolean;
  reason: string | null;
};

export type PairLeg = { matchIndex: number; option: PairOption };

export type PairDeal = {
  tickets: PairLeg[][];
  leftovers: PairLeg[];
  legCount: number; // legs after picking two per match
};

// ── Which options does a pool pick earn? (pure) ───────────────────────────
export function earnedOptions(pick: ConfidencePick): PairOption[] {
  const out: PairOption[] = [];
  if (pick.kind !== 'over25') return out;
  const t = pick.high === 'both' || pick.high === 'total';
  const w = pick.high === 'both' || pick.high === 'weaker';
  if (t) out.push('over25');
  if (w) out.push('btts');
  if (t && w) out.push('combo');
  if (pick.highOver35) out.push('over35');
  return out;
}

// ── The plan ──────────────────────────────────────────────────────────────
export function planPairs(rows: PairRow[]): PairPlan {
  const conf = planConfidence(rows);
  const matches: PairMatch[] = [];
  let poolCount = 0;
  let noOption = 0;

  for (let i = 0; i < conf.picks.length; i++) {
    const p = conf.picks[i];
    if (p.kind !== 'over25') continue;
    poolCount++;
    const earned = earnedOptions(p);
    if (earned.length === 0) noOption++;
    else matches.push({ name: p.name, league: p.league, earned: earned });
  }

  const n = matches.length;
  const canBuild = n >= PAIR_MIN_PER_TICKET;
  return {
    stored: rows.length,
    unreadable: conf.unreadable,
    poolCount: poolCount,
    matches: matches,
    noOptionCount: noOption,
    canBuild: canBuild,
    reason: canBuild
      ? null
      : 'Only ' + n + ' match' + (n === 1 ? '' : 'es') + ' earned an option. At least ' +
        PAIR_MIN_PER_TICKET + ' are needed for one ticket.',
  };
}

// ── Dealing ───────────────────────────────────────────────────────────────
function shuffle<T>(list: T[], random: () => number): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// One random layout. Returns the tickets and how many legs were left.
function oneLayout(
  legs: PairOption[][],
  random: () => number
): { tickets: PairLeg[][]; left: PairOption[][]; leftCount: number } {
  const n = legs.length;
  const left: PairOption[][] = legs.map(function (l) { return l.slice(); });
  const tickets: PairLeg[][] = [];

  while (true) {
    const avail: number[] = [];
    for (let i = 0; i < n; i++) if (left[i].length > 0) avail.push(i);
    if (avail.length < PAIR_MIN_PER_TICKET) break;

    const maxSize = Math.min(PAIR_MAX_PER_TICKET, avail.length);
    const size =
      PAIR_MIN_PER_TICKET +
      Math.min(
        maxSize - PAIR_MIN_PER_TICKET,
        Math.floor(random() * (maxSize - PAIR_MIN_PER_TICKET + 1))
      );
    const picked = shuffle(avail, random).slice(0, size);
    picked.sort(function (x, y) { return x - y; }); // keep stored order

    const ticket: PairLeg[] = [];
    for (let k = 0; k < picked.length; k++) {
      const mi = picked[k];
      const pos = Math.min(left[mi].length - 1, Math.floor(random() * left[mi].length));
      const option = left[mi].splice(pos, 1)[0];
      ticket.push({ matchIndex: mi, option: option });
    }
    tickets.push(ticket);
  }

  let leftCount = 0;
  for (let i = 0; i < n; i++) leftCount += left[i].length;
  return { tickets: tickets, left: left, leftCount: leftCount };
}

export function dealPairs(plan: PairPlan, rnd?: () => number): PairDeal {
  const random = rnd || Math.random;

  // each match keeps at most OPTIONS_PER_MATCH of what it earned, at random
  const legs: PairOption[][] = plan.matches.map(function (m) {
    return shuffle(m.earned, random).slice(0, OPTIONS_PER_MATCH);
  });
  let legCount = 0;
  for (let i = 0; i < legs.length; i++) legCount += legs[i].length;

  if (!plan.canBuild) {
    const all: PairLeg[] = [];
    for (let i = 0; i < legs.length; i++) {
      for (let k = 0; k < legs[i].length; k++) all.push({ matchIndex: i, option: legs[i][k] });
    }
    return { tickets: [], leftovers: all, legCount: legCount };
  }

  let best: { tickets: PairLeg[][]; left: PairOption[][]; leftCount: number }[] = [];
  let bestLeft = -1;
  for (let t = 0; t < LAYOUT_TRIES; t++) {
    const r = oneLayout(legs, random);
    if (bestLeft === -1 || r.leftCount < bestLeft) {
      best = [r];
      bestLeft = r.leftCount;
    } else if (r.leftCount === bestLeft) {
      best.push(r);
    }
  }
  const chosen = best[Math.min(best.length - 1, Math.floor(random() * best.length))];

  const leftovers: PairLeg[] = [];
  for (let i = 0; i < chosen.left.length; i++) {
    for (let k = 0; k < chosen.left[i].length; k++) {
      leftovers.push({ matchIndex: i, option: chosen.left[i][k] });
    }
  }
  return { tickets: chosen.tickets, leftovers: leftovers, legCount: legCount };
}

// ── Text ──────────────────────────────────────────────────────────────────
function shorten(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 3).trim() + '...';
}

export function describePairPlan(plan: PairPlan): string {
  const lines: string[] = [];
  lines.push('PAIR TICKETS');
  lines.push('');
  lines.push('Stored matches: ' + plan.stored);
  lines.push('In the 2+ pool (both formulas, both teams 2 or more): ' + plan.poolCount);
  lines.push('Earned at least one option: ' + plan.matches.length);
  lines.push('Earned nothing, left out: ' + plan.noOptionCount);
  if (!plan.canBuild && plan.reason) {
    lines.push('');
    lines.push('No tickets can be made. ' + plan.reason);
  }
  return lines.join('\n');
}

export function formatPairTickets(plan: PairPlan, deal: PairDeal): string[] {
  const out: string[] = [];
  const total = deal.tickets.length;

  for (let t = 0; t < total; t++) {
    const ticket = deal.tickets[t];
    const lines: string[] = [];
    lines.push('PAIR TICKET ' + (t + 1) + ' of ' + total + ' (' + ticket.length + ' matches)');
    lines.push('');
    for (let k = 0; k < ticket.length; k++) {
      const m = plan.matches[ticket[k].matchIndex];
      lines.push((k + 1) + ') ' + shorten(m.name, MAX_NAME_SHOWN));
      if (m.league) lines.push(shorten(m.league, MAX_LEAGUE_SHOWN));
      lines.push(PAIR_OPTION_LABEL[ticket[k].option]);
      lines.push('');
    }
    out.push(lines.join('\n').trim());
  }

  // summary
  const counts: { [k: string]: number } = {};
  let dealt = 0;
  for (let t = 0; t < total; t++) {
    for (let k = 0; k < deal.tickets[t].length; k++) {
      dealt++;
      const o = deal.tickets[t][k].option;
      counts[o] = (counts[o] || 0) + 1;
    }
  }
  const summary: string[] = [];
  summary.push(
    total + ' ticket' + (total === 1 ? '' : 's') + ' from ' + plan.matches.length +
      ' matches (' + dealt + ' of ' + deal.legCount + ' legs used).'
  );
  const parts: string[] = [];
  const order = ['over25', 'btts', 'combo', 'over35'];
  for (let i = 0; i < order.length; i++) {
    const n = counts[order[i]] || 0;
    if (n > 0) parts.push(n + ' ' + PAIR_OPTION_LABEL[order[i]]);
  }
  if (parts.length > 0) summary.push('In the tickets: ' + parts.join(', ') + '.');

  if (deal.leftovers.length > 0) {
    const names: string[] = [];
    for (let i = 0; i < deal.leftovers.length; i++) {
      const l = deal.leftovers[i];
      names.push(shorten(plan.matches[l.matchIndex].name, MAX_NAME_SHOWN) + ' (' + PAIR_OPTION_LABEL[l.option] + ')');
    }
    summary.push('Not used, fewer than ' + PAIR_MIN_PER_TICKET + ' different matches were left: ' + names.join('; ') + '.');
  }
  if (plan.noOptionCount > 0) {
    summary.push(plan.noOptionCount + ' pool match' + (plan.noOptionCount === 1 ? '' : 'es') + ' earned no option and ' + (plan.noOptionCount === 1 ? 'was' : 'were') + ' left out.');
  }
  if (plan.unreadable.length > 0) {
    summary.push('Could not be read: ' + plan.unreadable.join('; ') + '.');
  }
  summary.push('');
  summary.push('Each match has the options it earned (two at most), and sits in one ticket per option, so one bad result can sink two tickets.');
  summary.push('The storage was not emptied. Tapping again gives a different random set.');
  summary.push('The rules were fitted on ' + TRAINING_ROWS + ' past matches. No accuracy is promised and no result is recorded.');
  out.push(summary.join('\n'));
  return out;
}
