import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { processSuccessfulPayment } from '@/lib/processPayment';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get('x-paystack-signature');
  
  const expected = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!)
    .update(rawBody)
    .digest('hex');
  
  if (!signature || signature !== expected) {
    console.error('Paystack webhook: signature mismatch');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Bad body' }, { status: 400 });
  }
  
  if (event.event !== 'charge.success') {
    return NextResponse.json({ received: true });
  }
  
  const reference = event.data?.reference;
  if (typeof reference !== 'string' || !reference.startsWith('TG-')) {
    return NextResponse.json({ received: true });
  }
  
  const result = await processSuccessfulPayment(reference);
  
  if (!result.ok) {
    console.error('processSuccessfulPayment failed:', result.error);
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  
  return NextResponse.json({ received: true });
}