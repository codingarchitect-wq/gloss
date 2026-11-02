import { peekFree } from "@/lib/quota";
import { keyWorks, serverKey } from "@/lib/llm";

export const runtime = "nodejs";

/** Validates a pasted key against OpenRouter, at no cost. The key is never stored or logged. */
export async function POST(req: Request) {
  let body: { apiKey?: string } = {};
  try {
    body = await req.json();
  } catch {}
  const key = body.apiKey?.trim();
  if (!key) return Response.json({ ok: false });
  return Response.json({ ok: await keyWorks(key) });
}

/** Whether there is a shared key, and how much of today's free allowance is left on it. */
export async function GET(req: Request) {
  const house = Boolean(serverKey());
  return Response.json({ house, free: house ? await peekFree(req) : null });
}
