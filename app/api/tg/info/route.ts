// app/api/tg/info/route.ts  (NEW) - read-only look at the Telegram webhook settings.
// Shows which update types Telegram delivers (we need channel_post).
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!secret || secret !== process.env.DISPATCH_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const res = await fetch(
      'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/getWebhookInfo',
      { cache: 'no-store', signal: AbortSignal.timeout(10000) }
    );
    const json = (await res.json()) as {
      ok?: boolean;
      result?: {
        url?: string;
        pending_update_count?: number;
        last_error_date?: number;
        last_error_message?: string;
        allowed_updates?: string[];
      };
    };
    const r = json.result ?? {};
    return NextResponse.json({
      ok: json.ok === true,
      webhook_url: r.url ?? null,
      pending_update_count: r.pending_update_count ?? 0,
      last_error_message: r.last_error_message ?? null,
      allowed_updates: r.allowed_updates ?? 'not restricted (Telegram default, includes channel_post)',
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'Could not reach Telegram' }, { status: 502 });
  }
}
