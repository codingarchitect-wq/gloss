import { needKey } from "@/lib/quota";
import { llmHeaders, serverKey } from "@/lib/llm";
import { LOCAL_USER_ID } from "@/lib/auth-mode";
import { TTS_MAX_CHARS, TTS_MODEL, TTS_URL, TTS_VOICE } from "@/lib/voice";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * One passage, spoken. The audio streams straight through from OpenRouter as
 * MP3, so playback can begin before the whole clip exists.
 */
export async function POST(req: Request) {
  let body: { text?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) return Response.json({ error: "Nothing to read." }, { status: 400 });
  if (text.length > TTS_MAX_CHARS + 200) return Response.json({ error: "That passage is too long to read in one go." }, { status: 413 });

  const headerKey = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  // Reading aloud is never on the shared key: a minute of voice costs more than a day of free answers.
  // On a personal instance (lib/auth-mode.ts) the server's key is the owner's own, so it is used.
  const apiKey = body.apiKey?.trim() || headerKey || (LOCAL_USER_ID ? serverKey() : undefined);
  if (!apiKey) return needKey(null, "Reading aloud uses your own OpenRouter API key. Add it to listen.");

  let res: Response;
  try {
    res = await fetch(TTS_URL, {
      method: "POST",
      signal: req.signal,
      headers: llmHeaders(apiKey),
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: "mp3" }),
    });
  } catch {
    return Response.json({ error: "Could not reach the voice. Check your connection." }, { status: 502 });
  }
  if (!res.ok || !res.body) {
    let msg = `The voice answered ${res.status}.`;
    try {
      const j = (await res.json()) as { error?: { message?: string } | string };
      msg = typeof j.error === "string" ? j.error : j.error?.message ?? msg;
    } catch {}
    if (res.status === 401) msg = "OpenRouter rejected that API key. Check it and try again.";
    return Response.json({ error: msg }, { status: res.status === 401 || res.status === 429 ? res.status : 502 });
  }
  return new Response(res.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
}
