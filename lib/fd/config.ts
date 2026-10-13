// lib/fd/config.ts
// Settings for the football-data.org automation. Change values here only.

// The 12 free-tier competitions.
export const FREE_TIER = ['PL', 'PD', 'BL1', 'SA', 'FL1', 'CL', 'DED', 'PPL', 'ELC', 'BSA', 'WC', 'EC'];

// Tournaments have no "previous season" to fall back on.
export const NO_PREV = ['WC', 'EC'];

// Season stats older than this are refreshed.
export const DEFAULT_MAX_AGE_HOURS = 12;

// After a failed attempt, leave that competition alone for this long.
export const COOLDOWN_MINUTES = 30;

export const LOCK_NAME = 'fd-run';
export const LOCK_SECONDS = 60;

// Fixture window used by the sync step. The API allows at most 10 days
// between dateFrom and dateTo, so lookback + lookahead must stay <= 9.
export const LOOKBACK_DAYS = 4;
export const LOOKAHEAD_DAYS = 5;

// The sync step stops starting new competitions after this many ms.
export const SYNC_BUDGET_MS = 30000;

// Predictions made on stale stats are rechecked at least this often.
export const STALE_REFRESH_HOURS = 3;
