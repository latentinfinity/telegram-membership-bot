// lib/ai.ts
// Stage 1: AI provider wrappers — pure functions, no DB access.
// Primary: Gemini 2.5 Flash. Fallback: Groq (Llama 3.3 70B).
// generateText() never throws — it always returns a result object so
// callers (cron dispatch, webhook replies) can decide what "no content"
// means in their own context instead of crashing.

type AiResult =
  | { ok: true; text: string; provider: 'gemini' | 'groq' }
  | { ok: false; error: string };

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/' +
  GEMINI_MODEL +
  ':generateContent';

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function callGemini(
  systemPrompt: string,
  userPrompt: string
): Promise<AiResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY not set' };

  try {
    const res = await fetch(GEMINI_URL + '?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 400 },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        ok: false,
        error: 'Gemini HTTP ' + res.status + ': ' + errText.slice(0, 300),
      };
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { ok: false, error: 'Gemini returned no text' };

    return { ok: true, text: String(text).trim(), provider: 'gemini' };
  } catch (e) {
    return {
      ok: false,
      error: 'Gemini fetch failed: ' + (e instanceof Error ? e.message : String(e)),
    };
  }
}

async function callGroq(
  systemPrompt: string,
  userPrompt: string
): Promise<AiResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { ok: false, error: 'GROQ_API_KEY not set' };

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.9,
        max_tokens: 400,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        ok: false,
        error: 'Groq HTTP ' + res.status + ': ' + errText.slice(0, 300),
      };
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return { ok: false, error: 'Groq returned no text' };

    return { ok: true, text: String(text).trim(), provider: 'groq' };
  } catch (e) {
    return {
      ok: false,
      error: 'Groq fetch failed: ' + (e instanceof Error ? e.message : String(e)),
    };
  }
}

// generateText() — single entry point the rest of the app calls.
// Tries Gemini first; falls back to Groq on any failure (quota, network,
// missing key). Logs both failures if both fail, but still returns
// cleanly rather than throwing.
export async function generateText(
  systemPrompt: string,
  userPrompt: string
): Promise<AiResult> {
  const primary = await callGemini(systemPrompt, userPrompt);
  if (primary.ok) return primary;

  console.error('Gemini failed, falling back to Groq:', primary.error);

  const fallback = await callGroq(systemPrompt, userPrompt);
  if (fallback.ok) return fallback;

  console.error('Groq also failed:', fallback.error);

  return {
    ok: false,
    error:
      'Both providers failed. Gemini: ' +
      primary.error +
      ' | Groq: ' +
      fallback.error,
  };
}
