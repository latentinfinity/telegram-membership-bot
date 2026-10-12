// lib/fd/lock.ts
// One run at a time. A row in fd_job_lock with an expiry. Never throws.

import { createAdminClient } from '../supabase/admin';

async function db() {
  return await createAdminClient();
}

export type LockResult = { ok: true } | { ok: false; reason: 'busy' | 'error'; error?: string };

// Takes the lock for `seconds`. Atomic: the insert only succeeds for a new
// name, and the update only succeeds when the old lock has expired.
export async function tryLock(name: string, seconds: number): Promise<LockResult> {
  try {
    const d = await db();
    const now = new Date();
    const nowIso = now.toISOString();
    const untilIso = new Date(now.getTime() + seconds * 1000).toISOString();

    const ins = await d
      .from('fd_job_lock')
      .upsert({ name, locked_until: untilIso, locked_at: nowIso }, { onConflict: 'name', ignoreDuplicates: true })
      .select('name');
    if (ins.error) return { ok: false, reason: 'error', error: ins.error.message };
    if (ins.data && ins.data.length > 0) return { ok: true };

    const upd = await d
      .from('fd_job_lock')
      .update({ locked_until: untilIso, locked_at: nowIso })
      .eq('name', name)
      .lt('locked_until', nowIso)
      .select('name');
    if (upd.error) return { ok: false, reason: 'error', error: upd.error.message };
    if (upd.data && upd.data.length > 0) return { ok: true };
    return { ok: false, reason: 'busy' };
  } catch (e) {
    return { ok: false, reason: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

// Releases the lock by expiring it now. Safe to call even if not held.
export async function unlock(name: string): Promise<void> {
  try {
    const d = await db();
    await d.from('fd_job_lock').update({ locked_until: new Date().toISOString() }).eq('name', name);
  } catch {
    // an expired lock frees itself anyway
  }
}
