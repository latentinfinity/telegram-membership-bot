// app/api/fb/card/route.tsx  (NEW) - draws a text-only image card (1200x630).
// Secret-gated with DISPATCH_SECRET. The bot calls it itself and uploads the
// picture to Facebook, so the secret never reaches Meta.
// No logos, no copied images, no emoji (text and colours only).
import { ImageResponse } from 'next/og';

export const runtime = 'edge';

function clean(text: string | null, max: number): string {
  if (!text) return '';
  return text.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!secret || secret !== process.env.DISPATCH_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const title = clean(url.searchParams.get('title'), 48) || 'New post on Telegram';
  const sub = clean(url.searchParams.get('sub'), 70) || 'Head over to our Telegram channel';
  const dateText = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  }).format(new Date());

  const titleSize = title.length > 28 ? 76 : 96;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          background: 'linear-gradient(135deg, #0f172a 0%, #14532d 100%)',
          color: '#ffffff',
          padding: '60px',
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: 30,
            letterSpacing: 6,
            color: '#4ade80',
            marginBottom: 36,
          }}
        >
          {dateText.toUpperCase()}
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: titleSize,
            fontWeight: 800,
            textAlign: 'center',
            lineHeight: 1.1,
            justifyContent: 'center',
          }}
        >
          {title}
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 42,
            color: '#cbd5e1',
            marginTop: 40,
            textAlign: 'center',
            justifyContent: 'center',
          }}
        >
          {sub}
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
