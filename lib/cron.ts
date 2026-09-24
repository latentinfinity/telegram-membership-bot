import { createAdminClient } from '@/lib/supabase/admin';
import { sendMessage, removeMember } from '@/lib/telegram';
import { processSuccessfulPayment } from '@/lib/processPayment';

const DAY = 86400000;
const TIME_BUDGET_MS = 50000;
const RENEW = [[{ text: 'Renew now', callback_data: 'subscribe' }]];

export type CronSummary = {
  paymentsRecovered: number;
  paymentsClosed: number;
  movedToGrace: number;
  expired: number;
  removed: number;
  removalFailed: number;
  reminders: number;
  retriesOk: number;
  retriesFailed: number;
  truncated: boolean;
};

type SubRow = {
  id: string;
  telegram_user_id: string;
  status: string;
  current_period_end: string;
  grace_ends_at: string;
  is_complimentary: boolean;
};

function isAdminId(id: number) {
  return (process.env.TELEGRAM_ADMIN_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(id));
}

function fmt(d: Date) {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

async function claimReminder(subscriptionId: string, stage: string) {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('reminder_log')
    .insert({ subscription_id: subscriptionId, stage });
  if (!error) return true;
  if (error.code !== '23505') console.error('reminder claim failed', error);
  return false;
}

export async function runDailyReconcile(): Promise<CronSummary> {
  const supabase = createAdminClient();
  const started = Date.now();
  const timeUp = () => Date.now() - started > TIME_BUDGET_MS;

  const s: CronSummary = {
    paymentsRecovered: 0,
    paymentsClosed: 0,
    movedToGrace: 0,
    expired: 0,
    removed: 0,
    removalFailed: 0,
    reminders: 0,
    retriesOk: 0,
    retriesFailed: 0,
    truncated: false,
  };

  const sevenDaysAgo = new Date(Date.now() - 7 * DAY).toISOString();

  // 1. Payment safety net: pending payments that Paystack actually settled
  const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
  const { data: pending } = await supabase
    .from('payments')
    .select('payment_reference')
    .eq('status', 'pending')
    .eq('provider', 'paystack')
    .like('payment_reference', 'TG-%')
    .lt('created_at', fiveMinAgo)
    .gt('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })
    .limit(10);

  for (const p of pending ?? []) {
    if (timeUp()) {
      s.truncated = true;
      break;
    }
    const res = await processSuccessfulPayment(p.payment_reference);
    if (res.ok && !res.alreadyProcessed) s.paymentsRecovered++;
  }

  // 2. Live subscriptions
  const { data: subs } = await supabase
    .from('subscriptions')
    .select(
      'id, telegram_user_id, status, current_period_end, grace_ends_at, is_complimentary'
    )
    .eq('is_deleted', false)
    .in('status', ['active', 'grace'])
    .order('grace_ends_at', { ascending: true })
    .limit(500);
  const rows = (subs ?? []) as SubRow[];

  const userIds = Array.from(new Set(rows.map((r) => r.telegram_user_id)));
  const userMap = new Map<string, { telegram_id: number; is_blocked: boolean }>();
  if (userIds.length > 0) {
    const { data: users } = await supabase
      .from('telegram_users')
      .select('id, telegram_id, is_blocked')
      .in('id', userIds);
    for (const u of users ?? []) {
      userMap.set(u.id, { telegram_id: u.telegram_id, is_blocked: u.is_blocked });
    }
  }

  for (const r of rows) {
    if (timeUp()) {
      s.truncated = true;
      break;
    }
    const user = userMap.get(r.telegram_user_id);
    if (!user) continue;

    const now = new Date();
    const nowIso = now.toISOString();
    const end = new Date(r.current_period_end);
    const graceEnd = new Date(r.grace_ends_at);
    const canMessage = !user.is_blocked;
    const admin = isAdminId(user.telegram_id);

    // Fully expired: conditional update so a renewal that landed mid-run wins
    if (now >= graceEnd) {
      const { data: expired } = await supabase
        .from('subscriptions')
        .update({ status: 'expired', updated_at: nowIso })
        .eq('id', r.id)
        .eq('is_deleted', false)
        .in('status', ['active', 'grace'])
        .lte('grace_ends_at', nowIso)
        .select('id');
      if (!expired || expired.length === 0) continue;
      s.expired++;

      if (!admin) {
        const removal = await removeMember(user.telegram_id);
        await supabase.from('access_events').insert({
          telegram_user_id: r.telegram_user_id,
          subscription_id: r.id,
          event_type: 'removed',
          result: removal.ok ? 'success' : 'failed',
          detail: removal.ok ? null : { error: removal.error },
        });
        if (removal.ok) s.removed++;
        else s.removalFailed++;
      }

      if (canMessage && (await claimReminder(r.id, 'grace_end'))) {
        await sendMessage(
          user.telegram_id,
          'Your membership has ended. Renew any time to get back in.',
          RENEW
        );
        s.reminders++;
      }
      continue;
    }

    // Past the paid period: move to grace
    if (now >= end) {
      if (r.status === 'active') {
        const { data: moved } = await supabase
          .from('subscriptions')
          .update({ status: 'grace', updated_at: nowIso })
          .eq('id', r.id)
          .eq('is_deleted', false)
          .eq('status', 'active')
          .lte('current_period_end', nowIso)
          .select('id');
        if (!moved || moved.length === 0) continue;
        s.movedToGrace++;
      }

      const daysLeft = Math.max(
        1,
        Math.ceil((graceEnd.getTime() - now.getTime()) / DAY)
      );
      if (canMessage && (await claimReminder(r.id, 'expiry'))) {
        await sendMessage(
          user.telegram_id,
          'Your membership has expired. You still have access for ' +
            daysLeft +
            ' more day(s). Renew now to keep it.',
          RENEW
        );
        s.reminders++;
      }

      const graceDay = Math.floor((now.getTime() - end.getTime()) / DAY) + 1;
      if (canMessage && graceDay >= 2 && (await claimReminder(r.id, 'grace_day_2'))) {
        await sendMessage(
          user.telegram_id,
          'Grace day ' +
            graceDay +
            ': your access ends on ' +
            fmt(graceEnd) +
            '. Renew now to avoid losing it.',
          RENEW
        );
        s.reminders++;
      }
      continue;
    }

    // Before expiry: reminders (paid members only)
    if (r.is_complimentary || !canMessage) continue;
    const msLeft = end.getTime() - now.getTime();
    const stage = msLeft <= DAY ? '1_day' : msLeft <= 3 * DAY ? '3_day' : null;
    if (!stage) continue;

    if (await claimReminder(r.id, stage)) {
      await sendMessage(
        user.telegram_id,
        stage === '1_day'
          ? 'Your membership expires tomorrow (' + fmt(end) + '). Renew now to keep access.'
          : 'Your membership expires on ' + fmt(end) + '. Renew now to keep access.',
        RENEW
      );
      s.reminders++;
    }
  }

  // 3. Retry failed removals (last 7 days, no later success, no live access)
  if (!timeUp()) {
    const { data: failedEv } = await supabase
      .from('access_events')
      .select('telegram_user_id, created_at')
      .eq('event_type', 'removed')
      .eq('result', 'failed')
      .gt('created_at', sevenDaysAgo);
    const { data: okEv } = await supabase
      .from('access_events')
      .select('telegram_user_id, created_at')
      .eq('event_type', 'removed')
      .eq('result', 'success')
      .gt('created_at', sevenDaysAgo);

    const lastOk = new Map<string, string>();
    for (const e of okEv ?? []) {
      const cur = lastOk.get(e.telegram_user_id);
      if (!cur || e.created_at > cur) lastOk.set(e.telegram_user_id, e.created_at);
    }
    const todo = new Set<string>();
    for (const e of failedEv ?? []) {
      const ok = lastOk.get(e.telegram_user_id);
      if (!ok || ok < e.created_at) todo.add(e.telegram_user_id);
    }

    let tried = 0;
    for (const userId of Array.from(todo)) {
      if (timeUp() || tried >= 20) {
        s.truncated = true;
        break;
      }
      const { data: u } = await supabase
        .from('telegram_users')
        .select('id, telegram_id')
        .eq('id', userId)
        .maybeSingle();
      if (!u || isAdminId(u.telegram_id)) continue;

      const { data: live } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('telegram_user_id', userId)
        .eq('is_deleted', false)
        .in('status', ['active', 'grace'])
        .gt('grace_ends_at', new Date().toISOString())
        .maybeSingle();
      if (live) continue;

      tried++;
      const removal = await removeMember(u.telegram_id);
      await supabase.from('access_events').insert({
        telegram_user_id: userId,
        event_type: removal.ok ? 'removed' : 'retry_failed',
        result: removal.ok ? 'success' : 'failed',
        detail: removal.ok ? null : { error: removal.error },
      });
      if (removal.ok) s.retriesOk++;
      else s.retriesFailed++;
    }
  }

  // 4. Close pending payments older than 7 days
  const { data: closed } = await supabase
    .from('payments')
    .update({ status: 'failed' })
    .eq('status', 'pending')
    .lt('created_at', sevenDaysAgo)
    .select('id');
  s.paymentsClosed = closed?.length ?? 0;

  return s;
}

export async function runDailyReconcileLocked(): Promise<{
  skipped: boolean;
  summary?: CronSummary;
}> {
  const supabase = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);

  const { error } = await supabase.from('scheduled_job_runs').insert({
    job_name: 'daily-reconcile',
    run_date: today,
    status: 'running',
  });

  if (error) {
    if (error.code !== '23505') {
      console.error('cron lock failed', error);
      return { skipped: true };
    }
    const { data: existing } = await supabase
      .from('scheduled_job_runs')
      .select('id, status, started_at')
      .eq('job_name', 'daily-reconcile')
      .eq('run_date', today)
      .maybeSingle();
    if (!existing) return { skipped: true };

    const stale = Date.now() - new Date(existing.started_at).getTime() > 5 * 60000;
    if (existing.status === 'completed') return { skipped: true };
    if (existing.status === 'running' && !stale) return { skipped: true };

    const { data: taken } = await supabase
      .from('scheduled_job_runs')
      .update({
        status: 'running',
        started_at: new Date().toISOString(),
        completed_at: null,
      })
      .eq('id', existing.id)
      .eq('status', existing.status)
      .select('id');
    if (!taken || taken.length === 0) return { skipped: true };
  }

  try {
    const summary = await runDailyReconcile();
    await supabase
      .from('scheduled_job_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        detail: summary,
      })
      .eq('job_name', 'daily-reconcile')
      .eq('run_date', today);
    return { skipped: false, summary };
  } catch (e) {
    console.error('daily reconcile crashed', e);
    await supabase
      .from('scheduled_job_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        detail: { error: String(e) },
      })
      .eq('job_name', 'daily-reconcile')
      .eq('run_date', today);
    return { skipped: false };
  }
}