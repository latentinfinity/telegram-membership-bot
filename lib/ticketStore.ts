// ═══════════════════════════════════════════════════════════════
// TICKET STORE — the temporary storage of matches for ticket creation.
// Table: ticket_matches (name, name_key unique, data_line, league, created_by,
// created_at). Service-role access only, like every other table.
//
// Functions never throw: they return { ok: false, error } instead.
// A match with the same name_key as a stored one replaces it.
// Storage holds at most MAX_STORED_MATCHES matches.
//
// Creating tickets uses takeAll(): the matches are removed from the table in
// ONE atomic step and handed to the caller, so a double tap cannot create two
// sets of tickets (the second tap finds nothing). If anything fails later,
// restoreRows() puts them back.
// ═══════════════════════════════════════════════════════════════

import { createAdminClient } from './supabase/admin';
import { MAX_STORED_MATCHES, NewMatch } from './tickets';

export type StoredRow = { id: string; name: string; dataLine: string; league: string | null };

type Fail = { ok: false; error: string };

function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

// All stored matches in a fixed order (oldest first).
export async function listStored(): Promise<{ ok: true; rows: StoredRow[] } | Fail> {
  try {
    const db = createAdminClient();
    const { data, error } = await db
      .from('ticket_matches')
      .select('id, name, data_line, league')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) return { ok: false, error: error.message };
    const rows = (
      (data || []) as { id: string; name: string; data_line: string; league: string | null }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      dataLine: r.data_line,
      league: r.league || null,
    }));
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export async function countStored(): Promise<{ ok: true; count: number } | Fail> {
  try {
    const db = createAdminClient();
    const { data, error } = await db.from('ticket_matches').select('id');
    if (error) return { ok: false, error: error.message };
    return { ok: true, count: ((data || []) as unknown[]).length };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Adds matches. A name already stored is replaced. If the NEW names would
// push the storage over the limit, nothing at all is added.
export async function addMatches(
  adminId: number,
  matches: NewMatch[]
): Promise<{ ok: true; added: number; replaced: number; total: number } | Fail> {
  try {
    // one row per name_key, the last one wins
    const byKey: Record<string, NewMatch> = {};
    const keys: string[] = [];
    matches.forEach((m) => {
      if (byKey[m.nameKey] === undefined) keys.push(m.nameKey);
      byKey[m.nameKey] = m;
    });
    if (keys.length === 0) return { ok: false, error: 'no matches to add' };

    const db = createAdminClient();
    const existing = await db.from('ticket_matches').select('name_key');
    if (existing.error) return { ok: false, error: existing.error.message };
    const have: Record<string, boolean> = {};
    ((existing.data || []) as { name_key: string }[]).forEach((r) => {
      have[r.name_key] = true;
    });
    const haveCount = Object.keys(have).length;

    let replaced = 0;
    let added = 0;
    keys.forEach((k) => {
      if (have[k]) replaced++;
      else added++;
    });

    if (haveCount + added > MAX_STORED_MATCHES) {
      return {
        ok: false,
        error:
          'Storage holds up to ' + MAX_STORED_MATCHES + ' matches. You have ' + haveCount +
          ' stored and this adds ' + added + ' new. Nothing was added. Clear the storage or send fewer.',
      };
    }

    const now = new Date().toISOString();
    const rows = keys.map((k) => ({
      name: byKey[k].name,
      name_key: k,
      data_line: byKey[k].dataLine,
      league: byKey[k].league,
      created_by: adminId,
      created_at: now,
    }));
    const up = await db.from('ticket_matches').upsert(rows, { onConflict: 'name_key' });
    if (up.error) return { ok: false, error: up.error.message };

    return { ok: true, added, replaced, total: haveCount + added };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Empties the whole storage (manual "Clear Matches").
export async function clearStored(): Promise<{ ok: true } | Fail> {
  try {
    const db = createAdminClient();
    const { error } = await db.from('ticket_matches').delete().not('id', 'is', null);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Removes only the given rows (used after tickets were sent, so a match added
// in the meantime is never wiped).
export async function clearRows(ids: string[]): Promise<{ ok: true } | Fail> {
  try {
    if (ids.length === 0) return { ok: true };
    const db = createAdminClient();
    const { error } = await db.from('ticket_matches').delete().in('id', ids);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// A match taken out of the storage (kept in full so it can be put back).
export type TakenRow = {
  name: string;
  nameKey: string;
  dataLine: string;
  league: string | null;
  createdBy: number;
  createdAt: string;
};

// Atomically removes ALL stored matches and returns them (oldest first).
// Whoever gets the rows owns them. A second caller gets an empty list.
export async function takeAll(): Promise<{ ok: true; rows: TakenRow[] } | Fail> {
  try {
    const db = createAdminClient();
    const { data, error } = await db
      .from('ticket_matches')
      .delete()
      .not('id', 'is', null)
      .select('name, name_key, data_line, league, created_by, created_at');
    if (error) return { ok: false, error: error.message };
    const rows = (
      (data || []) as {
        name: string;
        name_key: string;
        data_line: string;
        league: string | null;
        created_by: number;
        created_at: string;
      }[]
    ).map((r) => ({
      name: r.name,
      nameKey: r.name_key,
      dataLine: r.data_line,
      league: r.league || null,
      createdBy: Number(r.created_by),
      createdAt: r.created_at,
    }));
    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : 0;
    });
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Puts taken matches back. A match with the same name that was added in the
// meantime is kept as it is (the newer one is never overwritten).
export async function restoreRows(rows: TakenRow[]): Promise<{ ok: true } | Fail> {
  try {
    if (rows.length === 0) return { ok: true };
    const db = createAdminClient();
    const payload = rows.map((r) => ({
      name: r.name,
      name_key: r.nameKey,
      data_line: r.dataLine,
      league: r.league,
      created_by: r.createdBy,
      created_at: r.createdAt,
    }));
    const { error } = await db
      .from('ticket_matches')
      .upsert(payload, { onConflict: 'name_key', ignoreDuplicates: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}
