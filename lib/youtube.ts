/**
 * YouTube videos, read as texts: the video's captions become the text, a paragraph every half
 * minute or so with the time it starts, and the video itself (360p, picture and sound in one MP4,
 * so no ffmpeg) is kept with the saved copies (lib/originals.ts). All through yt-dlp
 * (github.com/yt-dlp/yt-dlp), which runs YouTube's player scripts in Deno. Server-side only, and
 * only where yt-dlp is installed (the Docker image has it).
 *
 * yt-dlp is only ever given a watch URL built here from a video id, never a link as it came, and
 * it reaches the internet through the guard proxy (lib/guard-proxy.ts) with none of this server's
 * environment.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardProxy } from "./guard-proxy";
import { slugify, tidyTitle, undash, type Article, type Block, type VideoInfo } from "./article";

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

let ready: boolean | null = null;

/** Whether this server can read YouTube videos: that takes yt-dlp. */
export function ytdlpReady(): boolean {
  ready ??= spawnSync("yt-dlp", ["--version"], { stdio: "ignore", timeout: 20_000 }).status === 0;
  return ready;
}

/** yt-dlp's own words for why it failed, as a reader would want them. */
function reason(stderr: string): string {
  const line = stderr.split("\n").reverse().find((l) => l.startsWith("ERROR:")) ?? "";
  const msg = line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]{11}:\s*)?/, "").trim();
  if (/sign in to confirm|not a bot/i.test(msg)) return "YouTube asked to confirm this isn't a bot. Try again later.";
  if (/private video/i.test(msg)) return "That video is private.";
  if (/unavailable|removed|terminated/i.test(msg)) return "That video is not available.";
  if (/age/i.test(msg) && /restrict|confirm/i.test(msg)) return "That video is age-restricted, and Gloss doesn't sign in to YouTube.";
  if (/live event|premieres in/i.test(msg)) return "That video hasn't started yet.";
  return msg ? `YouTube: ${msg.slice(0, 200)}` : "Could not read that video.";
}

/** Run yt-dlp in `cwd`, through the guard proxy, with nothing of this server's environment. */
async function ytdlp(args: string[], opts: { cwd: string; timeoutMs: number }): Promise<string> {
  const via = await guardProxy();
  const tmp = tmpdir();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "yt-dlp",
      ["--no-config", "--proxy", via, "--cache-dir", join(tmp, "gloss-yt-dlp"), "--no-progress", "--no-playlist", "--no-mtime", ...args],
      {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: tmp, TMPDIR: tmp, XDG_CACHE_HOME: join(tmp, "gloss-cache") } as unknown as NodeJS.ProcessEnv,
      }
    );
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > 64_000_000) child.kill("SIGKILL");
      else out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(reason(err)));
    });
  });
}

/* ---------- what yt-dlp says about a video ---------- */

type Format = { format_id?: string; vcodec?: string; acodec?: string; language?: string | null; format_note?: string };
type Info = {
  id: string;
  title?: string;
  channel?: string;
  uploader?: string;
  description?: string;
  upload_date?: string;
  duration?: number;
  thumbnail?: string;
  language?: string | null;
  is_live?: boolean;
  chapters?: { start_time: number; title: string }[] | null;
  formats?: Format[];
  subtitles?: Record<string, unknown>;
  automatic_captions?: Record<string, unknown>;
};

/**
 * The language spoken in the video as made. A video dubbed into many languages marks its original
 * sound track; yt-dlp's own `language` can name one of the dubs.
 */
function spoken(info: Info): string | undefined {
  const original = info.formats?.find((f) => f.vcodec === "none" && f.language && /\boriginal\b/i.test(f.format_note ?? ""));
  return original?.language ?? info.language ?? undefined;
}

const base = (lang: string) => lang.toLowerCase().split("-")[0];

type Track = { key: string; manual: boolean; lang: string };

/**
 * The captions to read: the creator's own in the spoken language, else YouTube's speech
 * recognition of it ("<lang>-orig"), else English, else whatever there is. Never a machine
 * translation of one language into another.
 */
export function pickCaptions(info: Info): Track | null {
  const manual = Object.keys(info.subtitles ?? {}).filter((k) => k !== "live_chat");
  const auto = Object.keys(info.automatic_captions ?? {}).filter((k) => k.endsWith("-orig"));
  const lang = spoken(info);
  const pick = (key: string | undefined, isManual: boolean): Track | null => (key ? { key, manual: isManual, lang: base(key.replace(/-orig$/, "")) } : null);
  if (lang) {
    const L = base(lang);
    const t = pick(manual.find((k) => base(k) === L), true) ?? pick(auto.find((k) => base(k) === L), false);
    if (t) return t;
  }
  return pick(manual.find((k) => base(k) === "en"), true) ?? pick(auto.find((k) => base(k) === "en"), false) ?? pick(auto[0], false) ?? pick(manual[0], true);
}

/* ---------- captions into paragraphs ---------- */

type Json3 = { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] };
/** A stretch of speech: when it starts and ends, in seconds, and what is said. */
export type Cue = { t: number; end: number; text: string };
export type Chapter = { start_time: number; title: string };

/** Sound cues that stand alone: [Music], [Applause], a line of notes. */
const SOUND_ONLY = /^(\[[^\]]{1,24}\]|[♪♫\s]+)$/;
const SENTENCE_END = /[.!?…]["')\]”’]*$/;

function cuesOf(j: Json3): Cue[] {
  const out: Cue[] = [];
  for (const e of j.events ?? []) {
    if (!e.segs) continue;
    const text = e.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!text || SOUND_ONLY.test(text)) continue;
    const t = (e.tStartMs ?? 0) / 1000;
    out.push({ t, end: t + (e.dDurationMs ?? 0) / 1000, text });
  }
  return out;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Captions (YouTube's json3) into paragraphs. */
export const captionsToBlocks = (j: Json3, chapters: Chapter[] = []): Block[] => paragraphs(cuesOf(j), chapters);

/**
 * Speech into paragraphs, each with the second it starts at: a paragraph ends at a sentence's
 * end once it has some length, at a pause, at a change of speaker (">>"), and at the latest after
 * about a minute of speech. The video's chapters become headings.
 */
export function paragraphs(cues: Cue[], chapters: Chapter[] = []): Block[] {
  const blocks: Block[] = [];
  const todo = [...chapters].filter((c) => c.title?.trim()).sort((a, b) => a.start_time - b.start_time);
  let para: string[] = [];
  let at = 0;
  let count = 0;
  let lastEnd = 0;
  const flush = () => {
    const text = para.join(" ").replace(/\s+([,.!?;:])/g, "$1").trim();
    if (text) blocks.push({ id: "", type: "p", runs: [{ text: text[0].toUpperCase() + text.slice(1) }], t: Math.floor(at) });
    para = [];
    count = 0;
  };
  const add = (text: string, t: number) => {
    if (!para.length) at = t;
    para.push(text);
    count += words(text);
  };
  for (const cue of cues) {
    while (todo.length && todo[0].start_time <= cue.t + 0.5) {
      const c = todo.shift()!;
      flush();
      blocks.push({ id: "", type: "h2", runs: [{ text: undash(c.title.trim()) }], t: Math.floor(c.start_time) });
    }
    if (count >= 40 && cue.t - lastEnd > 3) flush();
    // ">>" marks a new speaker in YouTube's captions.
    const parts = cue.text.split(/\s*>>\s*/);
    parts.forEach((part, i) => {
      if (i > 0 && count) flush();
      if (part) add(part, cue.t);
    });
    lastEnd = Math.max(lastEnd, cue.end);
    if ((count >= 70 && SENTENCE_END.test(cue.text)) || count >= 180) flush();
  }
  flush();
  // A chapter with nothing after it.
  while (blocks.length && blocks[blocks.length - 1].type === "h2") blocks.pop();
  // A word or two from another speaker ("Mhm.") goes with what follows, from its own time.
  for (let i = blocks.length - 2; i >= 0; i--) {
    const [b, next] = [blocks[i], blocks[i + 1]];
    if (b.type === "p" && next.type === "p" && words(b.runs[0].text) < 4) {
      blocks.splice(i, 2, { ...next, runs: [{ text: `${b.runs[0].text} ${next.runs[0].text}` }], t: b.t });
    }
  }
  // A chapter's first paragraph starts when the chapter does; its heading shows the time once.
  return blocks.map((b, i) => {
    const prev = blocks[i - 1];
    const same = b.type === "p" && prev?.type === "h2" && prev.t === b.t;
    return { ...b, id: `b${i + 1}`, t: same ? undefined : b.t };
  });
}

/* ---------- a video as a text ---------- */

/** A description's opening, when it reads as one: not links, hashtags or a list of timestamps. */
function dekOf(description: string | undefined): string | undefined {
  const first = (description ?? "").trim().split(/\n\s*\n/)[0] ?? "";
  const plain = first.replace(/https?:\/\/\S+/g, "").replace(/#\w+/g, "").replace(/\b\d{1,2}:\d{2}\b/g, "").replace(/\s+/g, " ").trim();
  if (plain.length < 40 || plain.length < first.length * 0.6) return undefined;
  const dek = undash(plain);
  return dek.length > 280 ? `${dek.slice(0, 277).replace(/\s+\S*$/, "")}...` : dek;
}

/** What a video without captions shows until it is transcribed. */
function noTranscript(description: string | undefined): Block[] {
  const blocks: Block[] = [{ id: "", type: "note", runs: [{ text: "YouTube has no captions for this video. Transcribe it from the button under the video to read it here." }] }];
  for (const p of (description ?? "").split(/\n\s*\n/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 20)) {
    blocks.push({ id: "", type: "p", runs: [{ text: p }] });
  }
  return blocks.map((b, i) => ({ ...b, id: `b${i + 1}` }));
}

/** A YouTube video as a text: its transcript, with what the video is and where it lives. */
export async function youtubeArticle(id: string): Promise<Article> {
  const dir = await mkdtemp(join(tmpdir(), "gloss-yt-"));
  try {
    const raw = await ytdlp(["-J", "--skip-download", watchUrl(id)], { cwd: dir, timeoutMs: 90_000 });
    const info = JSON.parse(raw) as Info;
    if (info.is_live) throw new Error("That video is a live stream. Add it once the stream has ended.");
    const track = pickCaptions(info);
    let blocks: Block[] = [];
    if (track) {
      await writeFile(join(dir, "info.json"), raw);
      const escaped = track.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await ytdlp(
        ["--load-info-json", "info.json", "--skip-download", track.manual ? "--write-subs" : "--write-auto-subs", "--sub-langs", escaped, "--sub-format", "json3", "-o", "v.%(ext)s"],
        { cwd: dir, timeoutMs: 90_000 }
      );
      const file = (await readdir(dir)).find((f) => f.endsWith(".json3"));
      if (file) blocks = captionsToBlocks(JSON.parse(await readFile(join(dir, file), "utf8")) as Json3, info.chapters ?? []);
    }
    const captioned = blocks.some((b) => b.type === "p");
    const title = tidyTitle(undash((info.title || "YouTube video").trim()));
    const video: VideoInfo = { youtube: id, duration: info.duration, captions: captioned ? (track!.manual ? "manual" : "auto") : "none", lang: captioned ? track!.lang : undefined };
    return {
      id: `${slugify(title)}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      author: (info.channel || info.uploader || "").trim().slice(0, 120) || undefined,
      published: /^\d{8}$/.test(info.upload_date ?? "") ? info.upload_date!.slice(0, 4) : undefined,
      dek: dekOf(info.description),
      source: "YouTube",
      sourceUrl: watchUrl(id),
      blocks: captioned ? blocks : noTranscript(info.description),
      image: /^https:\/\/i\.ytimg\.com\//.test(info.thumbnail ?? "") ? info.thumbnail : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      origin: "url",
      video,
      addedAt: Date.now(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ---------- the video and its sound ---------- */

/**
 * The video at 360p, as one MP4 with its sound (YouTube's format 18, the original sound track):
 * the only size YouTube still serves whole, so nothing needs joining. Up to `maxBytes`.
 */
export async function downloadVideo(id: string, out: string, maxBytes: number): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "gloss-yt-"));
  try {
    await ytdlp(["-f", "18/b[height<=360][ext=mp4]", "--max-filesize", String(maxBytes), "-o", out, watchUrl(id)], { cwd: dir, timeoutMs: 60 * 60_000 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The smallest sound-only file in the original language (M4A), for a transcription, with the
 * video's chapters; `audio` is null when there is none under `maxBytes`.
 */
export async function downloadAudio(id: string, maxBytes: number): Promise<{ audio: Buffer | null; chapters: Chapter[] }> {
  const dir = await mkdtemp(join(tmpdir(), "gloss-yt-"));
  try {
    await ytdlp(["-f", "ba[ext=m4a]", "-S", "lang,+abr", "--max-filesize", String(maxBytes), "--write-info-json", "-o", "a.%(ext)s", watchUrl(id)], {
      cwd: dir,
      timeoutMs: 15 * 60_000,
    });
    const info = (await readFile(join(dir, "a.info.json"), "utf8").then(JSON.parse, () => ({}))) as Info;
    const audio = await readFile(join(dir, "a.m4a")).catch(() => null);
    return { audio, chapters: info.chapters ?? [] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
