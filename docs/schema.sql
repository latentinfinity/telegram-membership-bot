-- ═══════════════════════════════════════════════════════════════
-- 3OddsWeekend - full database schema + starter rows (35 tables)
-- Run in the Supabase SQL editor, ONE PART AT A TIME, in order.
-- Safe to re-run: every statement uses "if not exists" / "on conflict".
-- Facebook tables (PART 5) are kept only because the code still reads
-- them. The Facebook feature itself is no longer used.
-- ═══════════════════════════════════════════════════════════════


-- ───────────────────────── PART 1: membership ─────────────────────────

create table if not exists telegram_users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null unique,
  telegram_username text,
  first_seen_at timestamptz not null default now(),
  has_started_bot boolean not null default true,
  is_blocked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists membership_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  duration_days integer not null default 30,
  grace_days integer not null default 3,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists plan_prices (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references membership_plans(id),
  currency text not null,
  amount numeric not null,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (plan_id, currency)
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id uuid not null references telegram_users(id),
  plan_id uuid not null references membership_plans(id),
  status text not null check (status in ('pending','active','grace','expired','cancelled')),
  renewal_mode text not null default 'manual' check (renewal_mode in ('manual','auto')),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  grace_ends_at timestamptz not null,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_complimentary boolean not null default false
);
create unique index if not exists one_live_sub_per_user on subscriptions (telegram_user_id) where (is_deleted = false);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id uuid not null references telegram_users(id),
  subscription_id uuid references subscriptions(id),
  provider text not null default 'paystack',
  payment_reference text not null unique,
  amount numeric not null,
  currency text not null,
  status text not null default 'pending' check (status in ('pending','success','failed','refunded','disputed')),
  raw_provider_response jsonb,
  created_at timestamptz not null default now()
);

create table if not exists access_events (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id uuid not null references telegram_users(id),
  subscription_id uuid references subscriptions(id),
  event_type text not null check (event_type in ('invite_created','join_approved','removed','retry_failed')),
  result text not null check (result in ('success','failed')),
  detail jsonb,
  created_at timestamptz not null default now()
);

create table if not exists admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_telegram_id bigint not null,
  action text not null,
  target_telegram_user_id bigint,
  target_subscription_id uuid,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists reminder_log (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  stage text not null check (stage in ('3_day','1_day','expiry','grace_day_2','grace_end')),
  sent_at timestamptz not null default now(),
  unique (subscription_id, stage)
);

create table if not exists provider_customers (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id uuid not null references telegram_users(id),
  provider text not null default 'paystack',
  provider_customer_id text,
  provider_subscription_id text,
  created_at timestamptz not null default now()
);

create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text,
  processed boolean not null default false,
  payload jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, provider_event_id)
);

create table if not exists scheduled_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  run_date date not null,
  status text not null check (status in ('running','completed','failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  detail jsonb,
  unique (job_name, run_date)
);

create table if not exists app_config (
  id uuid primary key default gen_random_uuid(),
  reminder_days_before integer[] not null default '{3,1}'::integer[],
  grace_reminder_day integer not null default 2,
  updated_at timestamptz not null default now()
);


-- ───────────────────── PART 2: posts, channel, AI, tickets ─────────────────────

create table if not exists channel_config (
  id uuid primary key default gen_random_uuid(),
  channel_id bigint,
  ad_caption text,
  ad_image_file_id text,
  ad_enabled boolean not null default false,
  ad_hour_utc integer not null default 13,
  ad_minute_utc integer not null default 30,
  last_sent_date date,
  updated_at timestamptz not null default now(),
  discussion_group_id bigint
);

create table if not exists scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  created_by bigint not null,
  caption text,
  image_file_id text,
  send_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','cancelled')),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  destination text not null default 'group' check (destination in ('group','channel'))
);

create table if not exists post_drafts (
  id uuid primary key default gen_random_uuid(),
  admin_telegram_id bigint not null unique,
  step text not null check (step in ('awaiting_photo','awaiting_caption','awaiting_time','awaiting_confirm')),
  image_file_id text,
  caption text,
  send_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  destination text not null default 'group' check (destination in ('group','channel')),
  is_ad boolean not null default false
);

create table if not exists channel_profile (
  id uuid primary key default gen_random_uuid(),
  niche text,
  tone text,
  topics_to_avoid text,
  posting_window_start_hour integer not null default 8,
  posting_window_end_hour integer not null default 21,
  max_posts_per_day integer not null default 3,
  max_polls_per_day integer not null default 1,
  ai_replies_enabled boolean not null default false,
  max_replies_per_day integer not null default 20,
  reply_cooldown_minutes integer not null default 3,
  updated_at timestamptz not null default now(),
  ai_posts_enabled boolean not null default true
);

create table if not exists engagement_posts_log (
  id uuid primary key default gen_random_uuid(),
  post_type text not null check (post_type in ('post','poll')),
  content text not null,
  sent_at timestamptz not null default now()
);

create table if not exists ai_reply_log (
  id uuid primary key default gen_random_uuid(),
  triggering_message_id bigint,
  triggering_user_id bigint,
  reply_text text not null,
  sent_at timestamptz not null default now()
);

create table if not exists ad2_config (
  id integer primary key default 1 check (id = 1),
  ad_caption text,
  ad_image_file_id text,
  ad_enabled boolean not null default true,
  ad_hour_utc integer not null default 8,
  ad_minute_utc integer not null default 30,
  last_sent_date date,
  updated_at timestamptz not null default now()
);

create table if not exists ticket_matches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null unique,
  data_line text not null,
  created_by bigint not null,
  created_at timestamptz not null default now(),
  league text
);


-- ───────────────────────── PART 3: Masaniello ─────────────────────────

create table if not exists masaniello_cycles (
  id uuid primary key default gen_random_uuid(),
  created_by bigint not null,
  label text,
  initial_bankroll_kobo bigint not null,
  total_bets integer not null,
  wins_required integer not null,
  ref_odds_h integer not null,
  bankroll_kobo bigint not null,
  bets_left integer not null,
  wins_needed integer not null,
  status text not null default 'active' check (status in ('active','achieved','not_achieved','infeasible','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create unique index if not exists one_active_masaniello_name on masaniello_cycles (lower(label)) where (status = 'active');

create table if not exists masaniello_tickets (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references masaniello_cycles(id) on delete cascade,
  ticket_no integer not null,
  odds_h integer not null,
  stake_kobo bigint not null,
  prediction text,
  status text not null default 'open' check (status in ('open','win','loss','void')),
  capped boolean not null default false,
  bankroll_before_kobo bigint not null,
  bankroll_after_kobo bigint,
  bets_left_before integer not null,
  wins_needed_before integer not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  reopened_count integer not null default 0,
  unique (cycle_id, ticket_no)
);
create unique index if not exists one_open_masaniello_ticket on masaniello_tickets (cycle_id) where (status = 'open');


-- ─────────────────────── PART 4: football-data (fd_) ───────────────────────

create table if not exists fd_competitions (
  code text primary key,
  name text not null,
  comp_type text,
  season_year text not null,
  season_start date not null,
  season_end date not null,
  in_season boolean not null default true,
  stats_synced_at timestamptz,
  updated_at timestamptz not null default now(),
  sync_checked_at timestamptz
);

create table if not exists fd_team_stats (
  comp_code text not null,
  season_year text not null,
  team_id integer not null,
  team_name text not null,
  played integer not null,
  scored integer not null,
  conceded integer not null,
  updated_at timestamptz not null default now(),
  primary key (comp_code, season_year, team_id)
);

create table if not exists fd_fixtures (
  fd_match_id bigint primary key,
  comp_code text not null,
  season_year text not null,
  matchday integer not null,
  match_date timestamptz not null,
  home_id integer not null,
  home_name text not null,
  away_id integer not null,
  away_name text not null,
  status text not null default 'pending' check (status in ('pending','graded','void','skipped')),
  skip_reason text,
  hs numeric,
  hc numeric,
  asc_ numeric,
  ac numeric,
  home_tier text,
  away_tier text,
  f1_home smallint,
  f1_away smallint,
  f2_home smallint,
  f2_away smallint,
  predicted_at timestamptz,
  real_home smallint,
  real_away smallint,
  graded_at timestamptz,
  created_at timestamptz not null default now(),
  stage text not null default 'REGULAR_SEASON',
  stale_note text,
  posted_at timestamptz,
  result_checked_at timestamptz
);
create index if not exists fd_fixtures_comp_matchday on fd_fixtures (comp_code, matchday);
create index if not exists fd_fixtures_group on fd_fixtures (comp_code, season_year, stage, matchday);
create index if not exists fd_fixtures_match_date on fd_fixtures (match_date);

create table if not exists fd_job_lock (
  name text primary key,
  locked_until timestamptz not null,
  locked_at timestamptz not null default now()
);

create table if not exists fd_run_log (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  step text not null,
  comp_code text,
  ok boolean not null,
  seconds numeric,
  detail jsonb
);
create index if not exists fd_run_log_ran_at on fd_run_log (ran_at);

create table if not exists fd_post_settings (
  id integer primary key default 1 check (id = 1),
  enabled boolean not null default false,
  send_channel boolean not null default true,
  send_group boolean not null default true,
  week_day smallint not null default 1,
  week_time text not null default '08:00',
  today_time text not null default '08:00',
  pred_time text not null default '09:00',
  footer text not null default ''
);

create table if not exists fd_post_log (
  post_key text primary key,
  kind text not null,
  destination text not null,
  status text not null check (status in ('sending','sent','failed')),
  attempts integer not null default 1,
  message_ids jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists fd_summary (
  month text not null,
  comp_code text not null,
  call_type text not null,
  predicted integer not null default 0,
  hit integer not null default 0,
  missed integer not null default 0,
  primary key (month, comp_code, call_type)
);


-- ───────────── PART 5: Facebook tables (unused feature, kept so the code does not error) ─────────────

create table if not exists fb_settings (
  id integer primary key default 1 check (id = 1),
  enabled boolean not null default true,
  page_token text,
  token_saved_at timestamptz,
  updated_at timestamptz not null default now(),
  last_event text,
  last_event_at timestamptz,
  watch_started_at timestamptz,
  teasers_enabled boolean not null default false,
  generic_teaser text,
  last_cleanup_date date
);

create table if not exists fb_comments (
  id bigint generated always as identity primary key,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists fb_comment_log (
  post_id text primary key,
  comment_id text,
  status text not null check (status in ('claiming','posted','failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists fb_triggers (
  id bigint generated always as identity primary key,
  name text not null,
  words text[] not null,
  teaser text not null,
  image_title text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists fb_teaser_log (
  channel_message_id bigint primary key,
  rule_name text,
  fb_post_id text,
  comment_id text,
  status text not null check (status in ('claiming','posted','failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


-- ───────────── PART 6: security (all access is service-role only, no policies) ─────────────

alter table access_events enable row level security;
alter table ad2_config enable row level security;
alter table admin_audit_logs enable row level security;
alter table ai_reply_log enable row level security;
alter table app_config enable row level security;
alter table channel_config enable row level security;
alter table channel_profile enable row level security;
alter table engagement_posts_log enable row level security;
alter table fb_comment_log enable row level security;
alter table fb_comments enable row level security;
alter table fb_settings enable row level security;
alter table fb_teaser_log enable row level security;
alter table fb_triggers enable row level security;
alter table fd_competitions enable row level security;
alter table fd_fixtures enable row level security;
alter table fd_job_lock enable row level security;
alter table fd_post_log enable row level security;
alter table fd_post_settings enable row level security;
alter table fd_run_log enable row level security;
alter table fd_summary enable row level security;
alter table fd_team_stats enable row level security;
alter table masaniello_cycles enable row level security;
alter table masaniello_tickets enable row level security;
alter table membership_plans enable row level security;
alter table payments enable row level security;
alter table plan_prices enable row level security;
alter table post_drafts enable row level security;
alter table provider_customers enable row level security;
alter table reminder_log enable row level security;
alter table scheduled_job_runs enable row level security;
alter table scheduled_posts enable row level security;
alter table subscriptions enable row level security;
alter table telegram_users enable row level security;
alter table ticket_matches enable row level security;
alter table webhook_events enable row level security;


-- ───────────── PART 7: starter rows (what the bot needs on day one) ─────────────

insert into membership_plans (name, duration_days, grace_days, active)
values ('monthly', 30, 3, true)
on conflict (name) do nothing;

insert into plan_prices (plan_id, currency, amount, active)
select id, 'NGN', 2000, true from membership_plans where name = 'monthly'
on conflict (plan_id, currency) do nothing;

insert into app_config (reminder_days_before, grace_reminder_day)
select '{3,1}'::integer[], 2 where not exists (select 1 from app_config);

insert into channel_config (channel_id, ad_caption, ad_enabled, ad_hour_utc, ad_minute_utc, discussion_group_id)
select null,
  E'If you are a high staker get access to:\n3 Odds on Friday\n3 Odds on Saturday\n3 Odds on Sunday\nhttps://t.me/YOUR_NEW_BOT_USERNAME',
  false, 13, 30, null
where not exists (select 1 from channel_config);

insert into channel_profile (niche, tone, topics_to_avoid, posting_window_start_hour, posting_window_end_hour, max_posts_per_day, max_polls_per_day, ai_posts_enabled, ai_replies_enabled, max_replies_per_day, reply_cooldown_minutes)
select 'Soccer Betting Hacks, Soccer Fun Facts', 'Confident, Non Motivational',
  'guaranteed wins, exact score promises, politics, religion',
  8, 21, 3, 1, false, false, 20, 3
where not exists (select 1 from channel_profile);

insert into fd_post_settings (id, enabled, send_channel, send_group, week_day, week_time, today_time, pred_time, footer)
values (1, false, false, false, 1, '08:00', '08:00', '09:00', '')
on conflict (id) do nothing;

insert into ad2_config (id, ad_caption, ad_enabled, ad_hour_utc, ad_minute_utc)
values (1,
  E'Do you want a 500% bonus on your first 4 deposits and 75% cashback if you lose your first bet?\n\nThen make sure to use this promo code on 1win: bosco123\n\nRegister on 1win 👇:\n\n https://lkjz.pro/53b2ac\n\nWe’ll be using 1win for our 2 Odds Rollover.',
  false, 8, 30)
on conflict (id) do nothing;

insert into fb_settings (id, enabled, teasers_enabled)
values (1, false, false)
on conflict (id) do nothing;

-- Check: this should return 35.
-- select count(*) from information_schema.tables where table_schema = 'public';
