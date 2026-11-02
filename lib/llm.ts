/**
 * The model provider: OpenRouter. Server-side only. Raw fetch, OpenAI-compatible SSE.
 *
 * The house key is OPENROUTER_API_KEY; a reader can bring their own instead,
 * which is sent with each request and never stored here.
 *
 * Things worth knowing, kept on purpose:
 * 1. OpenRouter puts usage, with what it actually charged (`usage.cost`, dollars),
 *    on every response, so a receipt is real, not a guess from a price table.
 * 2. Errors come back as JSON: surface error.message, not the raw body. A stream
 *    can also fail midway, as a chunk with `error` instead of `choices`.
 * 3. `reasoning: { enabled: false }` keeps reasoners from spending the budget thinking.
 * 4. Keep-alive comments (": OPENROUTER PROCESSING") arrive between frames; they are skipped.
 */

export const LLM_BASE = "https://openrouter.ai/api/v1";
export const CHAT_URL = `${LLM_BASE}/chat/completions`;
export const APP_UA = "Gloss/0.1";

import { MODELS, costFor, type ModelEntry, type ModelKey, type StreamEvent, type Usage } from "./models";

export { MODELS, DEFAULT_MODEL, isModelKey, costFor } from "./models";
export type { ModelKey, StreamEvent, Usage } from "./models";

/** The shared key, when the server has one. */
export const serverKey = (): string | undefined => process.env.OPENROUTER_API_KEY?.trim() || undefined;

/** Headers for any OpenRouter call. The referer and title are OpenRouter's optional app attribution. */
export function llmHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": APP_UA,
    "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL ?? "https://usegloss.io",
    "X-Title": "Gloss",
  };
}

/** Whether OpenRouter accepts a key. GET /key answers 401 for an unknown one (/models is public, so it can't tell). */
export async function keyWorks(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${LLM_BASE}/key`, { headers: llmHeaders(apiKey), signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The dollars OpenRouter reported, or null when it did not say. */
export const reportedCost = (u: { cost?: unknown } | undefined): number | null => (typeof u?.cost === "number" && Number.isFinite(u.cost) ? u.cost : null);

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

type ApiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

type Chunk = {
  choices?: {
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_details?: unknown[];
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: ApiUsage;
  error?: { message?: string; code?: number | string };
};

function errorMessage(status: number, body: string): string {
  let msg = body.slice(0, 280);
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof j.error === "string") msg = j.error;
    else if (j.error?.message) msg = j.error.message;
    else if (j.message) msg = j.message;
  } catch {
    /* not JSON */
  }
  if (status === 401) return "OpenRouter rejected that API key. Check it and try again.";
  if (status === 402) return "That OpenRouter key is out of credits. Add credits on OpenRouter, or use another key.";
  if (status === 429) return "OpenRouter is rate limiting this key. Wait a moment, or use your own key.";
  return `OpenRouter ${status}: ${msg}`;
}

function usageOf(key: ModelKey, u: ApiUsage): Usage {
  const pt = u.prompt_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const ct = u.completion_tokens ?? 0;
  return { promptTokens: pt, cachedTokens: cached, completionTokens: ct, costUsd: reportedCost(u) ?? costFor(key, pt, cached, ct) };
}

export async function* streamChat(req: {
  messages: ChatMessage[];
  model: ModelKey;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Tools the model may call; a call ends the stream with a "tool" event instead of an answer. */
  tools?: readonly unknown[];
  /** "none" sends the tools (a conversation that already used one needs them) but asks for an answer. */
  toolChoice?: "auto" | "none";
}): AsyncGenerator<StreamEvent> {
  const model: ModelEntry = MODELS[req.model];
  const apiKey = req.apiKey?.trim() || serverKey();
  if (!apiKey) {
    yield { type: "error", text: "No OpenRouter API key. Set OPENROUTER_API_KEY, or add your own key." };
    return;
  }

  yield { type: "meta", model: model.label };

  let res: Response;
  try {
    res = await fetch(CHAT_URL, {
      method: "POST",
      signal: req.signal,
      headers: llmHeaders(apiKey),
      body: JSON.stringify({
        model: model.id,
        stream: true,
        temperature: req.temperature ?? 0.4,
        max_tokens: req.maxTokens ?? 900,
        reasoning: { enabled: false },
        messages: req.messages,
        ...(req.tools ? { tools: req.tools, tool_choice: req.toolChoice ?? "auto" } : {}),
      }),
    });
  } catch (e) {
    if (req.signal?.aborted) return;
    yield { type: "error", text: `Could not reach OpenRouter: ${String(e)}` };
    return;
  }

  if (!res.ok || !res.body) {
    yield { type: "error", text: errorMessage(res.status, await res.text().catch(() => "")) };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawContent = false;
  let sawReasoning = false;
  // A tool call arrives in pieces, by index: its id and name once, its arguments in fragments.
  const calls: { id: string; name: string; args: string }[] = [];

  const finish = (): StreamEvent => {
    if (calls[0]?.name) return { type: "tool", id: calls[0].id || "call_0", name: calls[0].name, args: calls[0].args };
    return !sawContent && sawReasoning ? { type: "error", text: `${model.label} answered only in its reasoning. Try again.` } : { type: "done" };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        yield finish();
        return;
      }
      let chunk: Chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.error) {
        yield { type: "error", text: `OpenRouter: ${chunk.error.message ?? "the model stopped with an error"}` };
        return;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning || delta?.reasoning_details?.length) sawReasoning = true;
      for (const tc of delta?.tool_calls ?? []) {
        const c = (calls[tc.index] ??= { id: "", name: "", args: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
      if (delta?.content) {
        sawContent = true;
        yield { type: "content", text: delta.content };
      }
      if (chunk.usage && typeof chunk.usage.completion_tokens === "number") {
        yield { type: "usage", usage: usageOf(req.model, chunk.usage) };
      }
    }
  }
  yield finish();
}

/** Non-streaming JSON completion, for structured output like the brief. */
export async function completeJSON<T>(req: {
  messages: ChatMessage[];
  model: ModelKey;
  apiKey?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Let the model reason before it answers, for checking a text against itself. Its thinking spends from maxTokens. */
  thinking?: boolean;
}): Promise<{ ok: true; data: T; usage: Usage } | { ok: false; error: string }> {
  const model: ModelEntry = MODELS[req.model];
  const apiKey = req.apiKey?.trim() || serverKey();
  if (!apiKey) return { ok: false, error: "No OpenRouter API key. Set OPENROUTER_API_KEY, or add your own key." };

  let res: Response;
  try {
    res = await fetch(CHAT_URL, {
      method: "POST",
      signal: req.signal,
      headers: llmHeaders(apiKey),
      body: JSON.stringify({
        model: model.id,
        temperature: 0.3,
        max_tokens: req.maxTokens ?? 1400,
        reasoning: { enabled: Boolean(req.thinking) },
        response_format: { type: "json_object" },
        messages: req.messages,
      }),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach OpenRouter: ${String(e)}` };
  }
  const body = await res.text();
  if (!res.ok) return { ok: false, error: errorMessage(res.status, body) };

  try {
    const j = JSON.parse(body) as { choices?: { message?: { content?: string } }[]; usage?: ApiUsage; error?: { message?: string } };
    if (j.error) return { ok: false, error: `OpenRouter: ${j.error.message ?? "the model stopped with an error"}` };
    const raw = j.choices?.[0]?.message?.content ?? "";
    const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const data = JSON.parse(jsonText) as T;
    return { ok: true, data, usage: usageOf(req.model, j.usage ?? {}) };
  } catch {
    return { ok: false, error: "The model returned something that was not valid JSON. Try again." };
  }
}
