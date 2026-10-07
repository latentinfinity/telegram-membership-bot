// ═══════════════════════════════════════════════════════════════
// CONFIDENCE — the matches in the storage that fit three strict rules.
// Pure functions, no DB / Telegram imports. Only ./correctScore.
//
// Each stored match gets calibrated scores from both formulas
// (prod = Formula 1, exp = Formula 2; 5 means "5+"). EVERY condition
// below must hold in BOTH formulas:
//
//   Under 3.5     : both formulas give 0:0
//   Over 2.5      : both formulas give both teams 2 or more
//   Double Chance : both formulas give 3:0 or better  -> 1X
//                   both formulas give 0:3 or better  -> X2
//
// The three rules cannot overlap, so a match has at most one pick.
// No percentage is calculated. The storage is only read, never changed.
// ═══════════════════════════════════════════════════════════════

import { calibratedScores, TRAINING_ROWS } from './correctScore';

// ── Types ─────────────────────────────────────────────────────────────────
export type ConfidenceRow = {
  name: string;
  data_line: string;
  league: string | null;
};

export type ConfidenceKind = 'under35' | 'over25' | 'double_home' | 'double_away';

export type ConfidencePick = {
  name: string;
  league: string | null;
  kind: ConfidenceKind;
};

export type ConfidencePlan = {
  stored: number;
  picks: ConfidencePick[];
  noCallCount: number;
  unreadable: string[];
};

type Pair = { home: number;away: number };

const MAX_NAME_SHOWN = 60;
const MAX_LEAGUE_SHOWN = 60;
const MAX_MESSAGE_CHARS = 3500;

// Measured on the TRAINING_ROWS past matches (the cut points were fitted on
// the same matches, so new matches may do worse). Update these if the
// calibration is ever refreshed.
const PAST_UNDER35 = { percent: 81, matches: 123 };
const PAST_OVER25 = { percent: 72, matches: 293 };
const PAST_DOUBLE = { percent: 85, matches: 137 };

// ── The rules (pure, testable over every score pair) ──────────────────────
export function confidenceKind(p: Pair, e: Pair): ConfidenceKind | null {
  function both(test: (h: number, a: number) => boolean): boolean {
    return test(p.home, p.away) && test(e.home, e.away);
  }
  if (both(function(h, a) { return h === 0 && a === 0; })) return 'under35';
  if (both(function(h, a) { return h >= 2 && a >= 2; })) return 'over25';
  if (both(function(h, a) { return a === 0 && h >= 3; })) return 'double_home';
  if (both(function(h, a) { return h === 0 && a >= 3; })) return 'double_away';
  return null;
}

function shorten(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 3).trim() + '...';
}

// Stored data lines have 4 values (a1,a2,b1,b2) or 6 (form,form,a1,a2,b1,b2).
function kindForRow(row: ConfidenceRow): { ok: boolean;kind: ConfidenceKind | null } {
  const parts = row.data_line.split(',').map(function(s) { return s.trim(); });
  let nums: string[];
  if (parts.length === 4) nums = parts;
  else if (parts.length === 6) nums = parts.slice(2);
  else return { ok: false, kind: null };
  
  const cs = calibratedScores(nums[0], nums[1], nums[2], nums[3]);
  if (!cs) return { ok: false, kind: null };
  return { ok: true, kind: confidenceKind(cs.prod, cs.exp) };
}

// ── The plan ──────────────────────────────────────────────────────────────
export function planConfidence(rows: ConfidenceRow[]): ConfidencePlan {
  const picks: ConfidencePick[] = [];
  const unreadable: string[] = [];
  let noCallCount = 0;
  
  for (let i = 0; i < rows.length; i++) {
    const r = kindForRow(rows[i]);
    if (!r.ok) {
      unreadable.push(rows[i].name);
    } else if (r.kind === null) {
      noCallCount++;
    } else {
      picks.push({ name: rows[i].name, league: rows[i].league, kind: r.kind });
    }
  }
  
  return { stored: rows.length, picks: picks, noCallCount: noCallCount, unreadable: unreadable };
}

// ── Output ────────────────────────────────────────────────────────────────
function entryText(n: number, pick: ConfidencePick): string {
  const lines: string[] = [];
  lines.push(n + ') ' + shorten(pick.name, MAX_NAME_SHOWN));
  if (pick.league) lines.push(shorten(pick.league, MAX_LEAGUE_SHOWN));
  if (pick.kind === 'double_home') lines.push('1X');
  if (pick.kind === 'double_away') lines.push('X2');
  return lines.join('\n');
}

function footerText(plan: ConfidencePlan): string {
  let under = 0;
  let over = 0;
  let dh = 0;
  let da = 0;
  for (let i = 0; i < plan.picks.length; i++) {
    const k = plan.picks[i].kind;
    if (k === 'under35') under++;
    else if (k === 'over25') over++;
    else if (k === 'double_home') dh++;
    else da++;
  }
  
  const lines: string[] = [];
  lines.push(
    plan.picks.length + ' of ' + plan.stored + ' stored matches qualify: ' +
    under + ' Under 3.5, ' + over + ' Over 2.5, ' + (dh + da) +
    ' Double Chance (' + dh + ' 1X, ' + da + ' X2).'
  );
  if (plan.noCallCount > 0) {
    lines.push(plan.noCallCount + ' stored match' + (plan.noCallCount === 1 ? '' : 'es') + ' did not fit any of the three rules.');
  }
  if (plan.unreadable.length > 0) {
    lines.push('Could not be read: ' + plan.unreadable.join('; ') + '.');
  }
  lines.push(
    'In ' + TRAINING_ROWS + ' past matches these rules hit: Under 3.5 about ' + PAST_UNDER35.percent +
    '% (' + PAST_UNDER35.matches + ' matches), Over 2.5 about ' + PAST_OVER25.percent +
    '% (' + PAST_OVER25.matches + '), Double Chance about ' + PAST_DOUBLE.percent +
    '% (' + PAST_DOUBLE.matches + '). The cut points were fitted on those same matches, so new matches may do worse. No result is recorded.'
  );
  return lines.join('\n');
}

// Returns the messages to send (each under about 3,500 characters). The
// storage is not touched.
export function formatConfidence(plan: ConfidencePlan): string[] {
  const sections: { title: string;kinds: ConfidenceKind[] } [] = [
    { title: 'UNDER 3.5 (both formulas 0:0)', kinds: ['under35'] },
    { title: 'OVER 2.5 (both formulas: both teams 2 or more)', kinds: ['over25'] },
    {
      title: 'DOUBLE CHANCE (both formulas 3:0 or better, or 0:3 or better)',
      kinds: ['double_home', 'double_away'],
    },
  ];
  
  const footer = footerText(plan);
  
  if (plan.picks.length === 0) {
    return ['No stored match fits the three Confidence rules.\n\n' + footer];
  }
  
  // blocks: a section title is glued to its first entry
  const blocks: string[] = [];
  let first = true;
  for (let s = 0; s < sections.length; s++) {
    let n = 0;
    let titleNeeded = true;
    for (let i = 0; i < plan.picks.length; i++) {
      const pick = plan.picks[i];
      if (sections[s].kinds.indexOf(pick.kind) === -1) continue;
      n++;
      let block = entryText(n, pick);
      if (titleNeeded) {
        block = (first ? 'CONFIDENCE\n\n' : '') + sections[s].title + '\n\n' + block;
        titleNeeded = false;
        first = false;
      }
      blocks.push(block);
    }
  }
  
  const chunks: string[] = [];
  let current = '';
  for (let i = 0; i < blocks.length; i++) {
    const add = (current ? '\n\n' : '') + blocks[i];
    if (current && current.length + add.length > MAX_MESSAGE_CHARS) {
      chunks.push(current);
      current = blocks[i];
    } else {
      current += add;
    }
  }
  if (current) chunks.push(current);
  
  // footer goes in the last message if it fits, otherwise in its own message
  const last = chunks[chunks.length - 1];
  if (last.length + 2 + footer.length <= MAX_MESSAGE_CHARS) {
    chunks[chunks.length - 1] = last + '\n\n' + footer;
  } else {
    chunks.push(footer);
  }
  return chunks;
}
