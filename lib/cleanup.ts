// lib/cleanup.ts  (REPLACES the earlier version) - once a day, deletes data older than 30 days:
// log rows in fb_comment_log, fb_teaser_log, fd_run_log, fd_post_log,
// and old matches in fd_fixtures (by kickoff date, no summary kept).
// Does NOT touch fd_team_stats. Never throws.
import { createAdminClient } from '@/lib/supabase/admin';

const DAYS = 30;
const AFTER_UTC_HOUR = 2;

const TARGETS: { table: string;column: string } [] = [
  { table: 'fb_comment_log', column: 'created_at' },
  { table: 'fb_teaser_log', column: 'created_at' },
  { table: 'fd_run_log', column: 'ran_at' },
  { table: 'fd_post_log', column: 'created_at' },
  { table: 'fd_fixtures', column: 'match_date' },
];

export type CleanupResult = { ran: boolean;note: string };

export async function runCleanup(): Promise < CleanupResult > {
  try {
    const now = new Date();
    if (now.getUTCHours() < AFTER_UTC_HOUR) return { ran: false, note: 'not time yet' };
    const today = now.toISOString().slice(0, 10);
    
    const supabase = createAdminClient();
    // Claim today first, so two overlapping runs cannot both clean.
    const { data: claimed } = await supabase
      .from('fb_settings')
      .update({ last_cleanup_date: today })
      .eq('id', 1)
      .or('last_cleanup_date.is.null,last_cleanup_date.neq.' + today)
      .select('id');
    if (!claimed || claimed.length === 0) return { ran: false, note: 'already done today' };
    
    const cutoff = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000).toISOString();
    const parts: string[] = [];
    for (const t of TARGETS) {
      try {
        const { error, count } = await supabase
          .from(t.table)
          .delete({ count: 'exact' })
          .lt(t.column, cutoff);
        parts.push(t.table + ': ' + (error ? 'error' : String(count ?? 0)));
      } catch (e) {
        parts.push(t.table + ': error');
      }
    }
    
    const note = 'deleted ' + parts.join(', ');
    await supabase
      .from('fb_settings')
      .update({ last_event: ('cleanup: ' + note).slice(0, 300), last_event_at: now.toISOString() })
      .eq('id', 1);
    return { ran: true, note };
  } catch (e) {
    console.error('cleanup error', e);
    return { ran: false, note: 'error' };
  }
}
