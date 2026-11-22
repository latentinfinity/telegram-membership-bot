# 3OddsWeekend - Recovery Runbook

How to bring the bot back from scratch, using only the code in GitHub.
Written for a phone. Never put a secret in this file or in chat.

Scheduled posts, the daily ads, AI posts and Facebook are switched off and not part of
the setup. What a new install needs: membership and payments, the admin menus, Masaniello,
Tickets, Rankings, Correct Scores, and the football-data pipeline.

---

## 0. What you need and where it lives

| Thing | Where it lives | If lost |
| --- | --- | --- |
| The code | GitHub (and a copy on your phone or drive) | Re-upload from your local copy |
| Database | Supabase | Section 2 |
| Hosting | Vercel | Section 3 |
| The bot, group and channel | Telegram | Section 4 |
| Payments | Paystack | Log in again, nothing to rebuild |
| Schedules | cron-job.org | Section 7 |
| Match data | football-data.org | Get a new free token |

Keep ONE private note in a password manager with every value in section 1.

---

## 1. Values to collect first (never share them)

    TELEGRAM_BOT_TOKEN        BotFather, My Bots, your bot, API Token
    TELEGRAM_WEBHOOK_SECRET   you invent it (letters and numbers, 20+)
    TELEGRAM_ADMIN_IDS        your numeric Telegram ID (message @userinfobot)
    TELEGRAM_GROUP_ID         the paid group's ID, starts with -100 (see 4.4)
    NEXT_PUBLIC_SUPABASE_URL  Supabase, Project Settings, API, Project URL
    SUPABASE_SECRET_KEY       Supabase, Project Settings, API, secret / service_role key
    PAYSTACK_SECRET_KEY       Paystack, Settings, API Keys and Webhooks, LIVE secret key
    CRON_SECRET               you invent it
    DISPATCH_SECRET           you invent it (used in every cron-job.org link)
    SUPPORT_CONTACT           your support email, shown in /paysupport
    GEMINI_API_KEY            Google AI Studio (free)
    GROQ_API_KEY              Groq console (free)
    FOOTBALL_DATA_API_TOKEN   football-data.org, your account (free)
    SITE_URL                  your Vercel address, https://..., no trailing slash

Without a Gemini or Groq key the AI features simply fail. The football pipeline and
payments do not use them.

---

## 2. Supabase (database)

If Supabase is lost, or for a fresh start:

1. supabase.com, create a new project (free). Save the database password.
2. Project Settings, API: copy the Project URL and the secret key into your note.
3. SQL Editor. Open docs/schema.sql from the repo.
4. Run it ONE PART AT A TIME (PART 1, then 2, 3 ... up to 7). Copy one part, paste, Run.
   Large pastes can corrupt on a phone, so keep each paste small.
5. Check: run this and expect 35.

       select count(*) from information_schema.tables where table_schema = 'public';

6. Check the starter rows: `select name from membership_plans;` shows monthly, and
   `select amount from plan_prices;` shows 2000.

After a new Supabase project you MUST update NEXT_PUBLIC_SUPABASE_URL and
SUPABASE_SECRET_KEY in Vercel, then redeploy (section 3).

---

## 3. Vercel (hosting)

1. vercel.com, create an account and a new project. Import the GitHub repo
   (branch main, framework Next.js).
2. Settings, Environment Variables: add every value from section 1. Mark the secret ones
   Sensitive. SITE_URL is the production domain you copy in step 4.
3. Deploy. Wait until the top entry in the Deployments list says Ready.
   If it fails, open Build Logs and read the red error, never retry blindly.
4. Settings, Domains: copy the production domain, for example
   https://yourname.vercel.app . Put it in SITE_URL, then redeploy.
5. Settings, Deployment Protection: set Vercel Authentication to Disabled.
   If this stays on, Telegram and Paystack get blocked and nothing works.
6. The repo's vercel.json already runs the daily membership job
   (/api/cron/daily-reconcile at 07:00 UTC). Nothing to add.

If Vercel is lost but Supabase and Telegram are fine, do only this section, then
sections 5, 6 and 7 with the new address.

---

## 4. Telegram

Only do this if the Telegram side is lost. If only Vercel was lost, skip to section 5.

### 4.1 Protect the account first (do this now, before any loss)
- Turn on two-step verification (a cloud password) and store it in your password manager.
- Make a trusted second person an admin of the channel and the paid group, with full rights.
- Only the owner can transfer ownership, so decide who would receive it.
- If the Telegram account itself is gone, the old bot, group and channel cannot be
  recovered by this runbook. You start with a NEW bot, group and channel, and members
  must rejoin.

### 4.2 Create the bot
1. Open @BotFather, send /newbot, choose a name and a username ending in bot.
2. Copy the token into TELEGRAM_BOT_TOKEN.
3. BotFather, Bot Settings, Group Privacy: turn OFF (only needed for the AI discussion
   replies, which are off).

### 4.3 Your admin ID
Message @userinfobot, copy your numeric ID into TELEGRAM_ADMIN_IDS.

### 4.4 The paid group
1. Create a private group. Add the bot as admin with Invite Users and Ban Users.
2. Send /groupid in the group. The bot answers Chat ID: -100... Put it in
   TELEGRAM_GROUP_ID and redeploy.

### 4.5 The public channel (for posts and the Tickets buttons)
1. Create or use the channel. Add the bot as admin with permission to post.
2. In Telegram, post one message in the channel and forward it to the bot in private chat.
   The bot saves the channel ID. If nothing happens, check that the bot is a channel admin.

### 4.6 New bot username
Edit channel_config.ad_caption in Supabase if you will ever use the daily ad, because the
starter text has YOUR_NEW_BOT_USERNAME in the link.

---

## 5. Connect the webhooks

### 5.1 Telegram webhook
Open this in the phone browser after filling the capitals. Never paste the filled link in chat.

    https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=YOUR_SITE_URL/api/telegram/webhook&secret_token=YOUR_TELEGRAM_WEBHOOK_SECRET

You must see "ok":true. Check it with:

    YOUR_SITE_URL/api/tg/info?secret=YOUR_DISPATCH_SECRET

It should show your address and no last_error_message.

### 5.2 Paystack webhook
Paystack dashboard, Settings, API Keys and Webhooks, Live Webhook URL:

    YOUR_SITE_URL/api/paystack/webhook

Payments do not work until this is set.

---

## 6. First start

1. Send the bot /start. The menu must appear.
2. Open Admin Panel, Tickets. The buttons must load.
3. Open Masaniello. It must say there are no active cycles.
4. Football data starts empty. Open each link below several times, one at a time, until
   the reply says done. Each run handles one part:

       YOUR_SITE_URL/api/fd/run?secret=YOUR_DISPATCH_SECRET&step=tick

   Stats refresh one competition per run, so about 10 to 12 runs fill everything. After
   that the hourly job in section 7 keeps it fresh. Then Tickets, Rankings lists competitions.

---

## 7. cron-job.org (schedules)

Create 2 jobs, each every 1 HOUR (not every minute, that caused the Vercel pause):

    YOUR_SITE_URL/api/fd/run?secret=YOUR_DISPATCH_SECRET&step=tick
    YOUR_SITE_URL/api/cron/dispatch-posts?secret=YOUR_DISPATCH_SECRET

The second one now runs only the daily cleanup. A tick can take about 40 seconds while
cron-job.org waits 30, so it may show as failed. Vercel still finishes the run, so do
not disable the job.

---

## 8. Recovery by scenario

- Lost Vercel only: section 3, then 5 and 7 (new address, new links).
- Lost Supabase only: section 2, update the two variables in Vercel, redeploy, then 6.
- Lost Telegram only: section 4, update the variables, redeploy, then 5 and 6.
  Members must rejoin the new group.
- Lost cron-job.org only: section 7.
- Lost Paystack login: recover the account with Paystack, then section 5.2.
- Lost the code: GitHub first. Keep a copy on your phone or drive.
- Several lost: GitHub, then Supabase, then Vercel, then Telegram, then 5, 6, 7.

## 9. Checklist after any recovery

- [ ] Deployments list top entry says Ready
- [ ] Deployment Protection is Disabled
- [ ] /start answers
- [ ] Admin Panel, Tickets menu opens
- [ ] /api/tg/info shows the new address and no error
- [ ] Paystack live webhook points to the new address
- [ ] Both cron-job.org jobs run hourly
- [ ] A test payment of the lowest amount confirms and sends the access link
- [ ] Pending payments from the outage: in Supabase run
      select payment_reference, status, created_at from payments where status = 'pending';

## 10. Known facts worth remembering

- Never add "export const runtime = 'nodejs';" to middleware.ts.
- A pasted file must replace the old content, not sit below it. One closing brace at the end.
- Vercel keeps serving the last good build when a new one fails. Check the Deployments list.
- Secrets marked Sensitive in Vercel cannot be read back. Keep them in your password manager.
- A free Supabase project can pause after a week of inactivity. Open it and restore if so.
- 