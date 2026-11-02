/**
 * A painted cover for one text, on the server: the scene the classifier
 * wrote, as a two-colour risograph print in its topic's inks. The title is
 * never in the prompt, or the model letters it onto the picture.
 */

import { TOPIC, type TopicKey } from "./library";
import { LLM_BASE, llmHeaders, reportedCost, serverKey } from "./llm";

/** FLUX 3 [klein], the small, fast FLUX, through OpenRouter's image API. A square at its smallest size is plenty for a cover. */
const MODEL = "black-forest-labs/flux-3-image-klein";
/**
 * What one cover costs, charged to the free allowance when OpenRouter does not say:
 * an estimate on the high side.
 */
export const COVER_USD = 0.02;

export async function paintCover(req: { scene: string; topic: TopicKey; apiKey?: string; signal?: AbortSignal }): Promise<{ ok: true; jpeg: Uint8Array; usd: number } | { ok: false; error: string }> {
  const apiKey = req.apiKey?.trim() || serverKey();
  if (!apiKey) return { ok: false, error: "No OpenRouter API key." };
  const prompt = `Editorial risograph print. ${req.scene.replace(/\.?$/, ".")} Two-colour palette of ${TOPIC[req.topic].inks} ink on warm cream paper filling the whole image, grain and halftone texture, mid-century book-cover illustration, wordless, no lettering, no border.`;
  let res: Response;
  try {
    res = await fetch(`${LLM_BASE}/images`, {
      method: "POST",
      signal: req.signal,
      headers: llmHeaders(apiKey),
      body: JSON.stringify({ model: MODEL, prompt, aspect_ratio: "1:1", resolution: "768", output_format: "jpeg", n: 1 }),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach OpenRouter: ${String(e)}` };
  }
  const j = (await res.json().catch(() => ({}))) as { data?: { b64_json?: string }[]; usage?: { cost?: number }; error?: { message?: string } };
  const b64 = j.data?.[0]?.b64_json;
  if (!res.ok || !b64) return { ok: false, error: j.error?.message ?? `OpenRouter answered ${res.status}.` };
  return { ok: true, jpeg: Uint8Array.from(Buffer.from(b64, "base64")), usd: reportedCost(j.usage) ?? COVER_USD };
}
