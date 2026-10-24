// app/api/fb/token/route.ts  (NEW) - one-time token exchange, admin only.
// Takes the temporary user token (env FB_USER_TOKEN), swaps it for a
// long-lived one, fetches the Page token for FB_PAGE_ID, checks it with Meta,
// and saves it in fb_settings. No token is ever returned in the reply.
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const GRAPH = 'https://graph.facebook.com/v26.0';
const VERSION = 'fb-token-1';
const REQUIRED_SCOPES = ['pages_manage_engagement', 'pages_read_engagement', 'pages_show_list'];

type GraphResult = { ok: boolean; data: Record<string, unknown>; error?: string };

async function graphGet(path: string, params: Record<string, string>): Promise<GraphResult> {
  try {
    const url = GRAPH + path + '?' + new URLSearchParams(params).toString();
    const res = await fetch(url, { cache: 'no-store' });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok || json.error) {
      const err = (json.error ?? {}) as { message?: string; code?: number };
      return {
        ok: false,
        data: {},
        error: 'Meta error ' + (err.code ?? res.status) + ': ' + (err.message ?? 'unknown'),
      };
    }
    return { ok: true, data: json };
  } catch (e) {
    console.error('fb token graph call failed');
    return { ok: false, data: {}, error: 'Could not reach Meta' };
  }
}

function fail(message: string, status: number) {
  return NextResponse.json({ ok: false, version: VERSION, error: message }, { status });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!secret || secret !== process.env.DISPATCH_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;
  const pageId = process.env.FB_PAGE_ID;
  const userToken = process.env.FB_USER_TOKEN;

  const missing: string[] = [];
  if (!appId) missing.push('FB_APP_ID');
  if (!appSecret) missing.push('FB_APP_SECRET');
  if (!pageId) missing.push('FB_PAGE_ID');
  if (!userToken) missing.push('FB_USER_TOKEN');
  if (missing.length > 0 || !appId || !appSecret || !pageId || !userToken) {
    return fail('Missing environment variables: ' + missing.join(', ') + '. Add them and redeploy.', 400);
  }

  // Step 1: short-lived user token -> long-lived user token
  const longLived = await graphGet('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: userToken,
  });
  const longToken = typeof longLived.data.access_token === 'string' ? longLived.data.access_token : '';
  if (!longLived.ok || !longToken) {
    return fail('Step 1 failed (exchange for a long-lived token). ' + (longLived.error ?? ''), 502);
  }

  // Step 2: the Pages this login manages, with their tokens
  const accounts = await graphGet('/me/accounts', {
    fields: 'id,name,access_token',
    limit: '100',
    access_token: longToken,
  });
  if (!accounts.ok) {
    return fail('Step 2 failed (listing your Pages). ' + (accounts.error ?? ''), 502);
  }
  const list = Array.isArray(accounts.data.data)
    ? (accounts.data.data as { id?: string; name?: string; access_token?: string }[])
    : [];
  const page = list.find((p) => p.id === pageId);
  if (!page || !page.access_token) {
    return fail(
      'Your Page (FB_PAGE_ID) was not in the list. Pages found: ' +
        (list.length > 0 ? list.map((p) => (p.name ?? '?') + ' (' + (p.id ?? '?') + ')').join(', ') : 'none') +
        '. Generate the user token again and choose the Page when asked.',
      404
    );
  }
  const pageToken = page.access_token;

  // Step 3: ask Meta what this Page token is (type, validity, expiry, permissions)
  const dbg = await graphGet('/debug_token', {
    input_token: pageToken,
    access_token: appId + '|' + appSecret,
  });
  let verified = false;
  let expires = 'unknown';
  let scopes: string[] = [];
  let missingScopes: string[] = [];
  if (dbg.ok && dbg.data.data && typeof dbg.data.data === 'object') {
    const d = dbg.data.data as { is_valid?: boolean; expires_at?: number; scopes?: string[] };
    if (d.is_valid === false) {
      return fail('Meta says the Page token is not valid. Nothing was saved.', 502);
    }
    verified = d.is_valid === true;
    expires =
      d.expires_at === 0
        ? 'never'
        : typeof d.expires_at === 'number'
          ? new Date(d.expires_at * 1000).toISOString()
          : 'unknown';
    scopes = Array.isArray(d.scopes) ? d.scopes : [];
    missingScopes = REQUIRED_SCOPES.filter((s) => scopes.indexOf(s) === -1);
  }

  // Step 4: save it
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { data: saved, error } = await supabase
    .from('fb_settings')
    .update({ page_token: pageToken, token_saved_at: now, updated_at: now })
    .eq('id', 1)
    .select('id');
  if (error || !saved || saved.length === 0) {
    console.error('fb_settings save failed', error);
    return fail('Could not save the token in fb_settings. Check the table has its row.', 500);
  }

  return NextResponse.json({
    ok: true,
    version: VERSION,
    page: page.name ?? null,
    saved: true,
    verified_by_meta: verified,
    expires,
    permissions_missing: missingScopes,
    next: 'Delete the FB_USER_TOKEN variable in Vercel and redeploy.',
  });
}
