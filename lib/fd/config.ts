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
