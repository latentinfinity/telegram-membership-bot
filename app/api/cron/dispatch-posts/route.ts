import { NextResponse } from 'next/server';
import { dispatchDuePosts, dispatchDailyAd } from '@/lib/scheduledPosts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  
  if (!secret || secret !== process.env.DISPATCH_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  const posts = await dispatchDuePosts();
  const ad = await dispatchDailyAd();
  
  return NextResponse.json({ posts, ad });
}
