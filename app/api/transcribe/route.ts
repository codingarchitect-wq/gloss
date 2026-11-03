import { CHAT_URL, llmHeaders, reportedCost, serverKey } from "@/lib/llm";
import { chargeFree, checkFree, needKey } from "@/lib/quota";
import { downloadAudio, paragraphs, ytdlpReady, type Cue } from "@/lib/youtube";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * A transcript for a YouTube video without captions: its sound, in the language spoken and the
 * smallest file YouTube has, heard by Gemini 3.1 Flash-Lite through OpenRouter. About $0.07 an
 * hour of speech; prices below are a fallback, OpenRouter reports each call's cost.
 * On a 17-minute talk with captions to check against (2026-11-03), its times were within 4 s
 * throughout; Gemini 3.5 Flash-Lite's ran 20% fast, and 2.5 Flash-Lite's were within 8 s.
 */
const MODEL = "google/gemini-3.1-flash-lite";
const PRICE = { audioPerM: 0.5, outPerM: 1.5 };
/** Audio goes inline, and a request holds about 20 MB; base64 adds a third. Some 40 minutes of speech. */
const MAX_AUDIO_BYTES = 14_000_000;

const PROMPT = `Transcribe the speech in this audio, word for word, in the language spoken.
- Paragraphs of a few sentences each; start a new one when the speaker changes or the subject turns.
- Begin every paragraph with the time it starts in the audio, as [m:ss] or [h:mm:ss], then the text on the same line.
- Proper punctuation and capitals. Leave out filler sounds (um, uh) and false starts.
- Write only the transcript: no title, summary or notes. If there is no speech, write NONE.`;

const STAMP = /^\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\s*(.*)$/;

/** "[1:05] Text" lines as stretches of speech, each running until the next begins. */
function cuesOf(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const line of text.replace(/<think>[\s\S]*?<\/think>/g, "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    const m = STAMP.exec(line);
    if (m) {
      const t = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      if (m[4]) cues.push({ t, end: t, text: m[4] });
    } else if (cues.length && !/^NONE$/i.test(line)) {
      cues[cues.length - 1].text += ` ${line}`;
    }
  }
  cues.forEach((c, i) => (c.end = cues[i + 1]?.t ?? c.t));
  return cues;
}

export async function POST(req: Request) {
  let body: { youtube?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const id = body.youtube ?? "";
  if (!/^[\w-]{11}$/.test(id)) return Response.json({ error: "Send a YouTube video id." }, { status: 400 });
  if (!ytdlpReady()) return Response.json({ error: "This server can't read YouTube videos." }, { status: 501 });

  const headerKey = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  const own = body.apiKey?.trim() || headerKey || undefined;
  let free: Awaited<ReturnType<typeof checkFree>> | null = null;
  if (!own) {
    if (!serverKey()) return needKey(null);
    free = await checkFree(req, 5);
    if (!free.ok) return needKey(free);
  }

  let audio: Buffer | null;
  let chapters: Awaited<ReturnType<typeof downloadAudio>>["chapters"];
  try {
    ({ audio, chapters } = await downloadAudio(id, MAX_AUDIO_BYTES));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not get the video's sound." }, { status: 502 });
  }
  if (!audio) return Response.json({ error: "This video is too long to transcribe here (about 40 minutes at most)." }, { status: 413 });

  let res: Response;
  try {
    res = await fetch(CHAT_URL, {
      method: "POST",
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(240_000)]),
      headers: llmHeaders((own ?? serverKey())!),
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 32_000,
        // Little thinking, as tested, and none of it in the answer.
        reasoning: { effort: "low", exclude: true },
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "input_audio", input_audio: { data: audio.toString("base64"), format: "m4a" } }] }],
      }),
    });
  } catch {
    return Response.json({ error: "Could not reach the transcriber." }, { status: 502 });
  }
  type Usage = { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  let j: { choices?: { message?: { content?: string } }[]; usage?: Usage; error?: { message?: string } | string };
  try {
    j = await res.json();
  } catch {
    return Response.json({ error: `The transcriber answered ${res.status}.` }, { status: 502 });
  }
  if (!res.ok) {
    const msg = typeof j.error === "string" ? j.error : j.error?.message ?? `The transcriber answered ${res.status}.`;
    return Response.json({ error: msg }, { status: res.status === 401 || res.status === 429 ? res.status : 502 });
  }

  if (free) {
    const u = j.usage;
    const cost = reportedCost(u) ?? ((u?.prompt_tokens ?? 50_000) * PRICE.audioPerM + (u?.completion_tokens ?? 8_000) * PRICE.outPerM) / 1_000_000;
    await chargeFree(free.subject, cost);
  }
  // The model's paragraphs are a sentence or two; they are put together as captions are.
  const blocks = paragraphs(cuesOf(j.choices?.[0]?.message?.content ?? ""), chapters);
  if (!blocks.some((b) => b.type === "p")) return Response.json({ error: "No speech was heard in this video." }, { status: 422 });
  return Response.json({ blocks, cost: reportedCost(j.usage) });
}
