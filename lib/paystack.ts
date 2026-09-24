export type InitializeResult = |
  { ok: true;authorizationUrl: string;reference: string } |
  { ok: false;error: string };

export function makeReference(telegramId: number) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `TG-${telegramId}-${Date.now()}-${rand}`;
}

export function placeholderEmail(telegramId: number) {
  return `tg${telegramId}@example.com`;
}

export async function initializeTransaction(params: {
  telegramId: number;
  amountNaira: number;
  reference: string;
}): Promise<InitializeResult> {
  try {
    const res = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: placeholderEmail(params.telegramId),
        amount: Math.round(params.amountNaira * 100),
        currency: 'NGN',
        reference: params.reference,
        metadata: {
          source: 'telegram-bot',
          telegram_id: params.telegramId,
        },
      }),
    });
    
    const json = await res.json();
    if (!res.ok || !json.status) {
      return { ok: false, error: json.message ?? 'Paystack error' };
    }
    return {
      ok: true,
      authorizationUrl: json.data.authorization_url,
      reference: json.data.reference,
    };
  } catch (e) {
    return { ok: false, error: 'Network error' };
  }
}
