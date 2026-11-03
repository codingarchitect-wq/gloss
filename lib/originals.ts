/**
 * Saved copies of the originals, for when the reader wants to see a text as it was published.
 * A page: everything it is made of (styles, pictures, fonts, scripts, video) packed into one HTML
 * file by monolith (github.com/Y2Z/monolith). A PDF link: the PDF itself. A YouTube video: the
 * video at 360p (lib/youtube.ts). Server-side only, and only where GLOSS_ORIGINALS_DIR is set;
 * pages also need monolith, videos yt-dlp (the Docker image has both).
 *
 * Copies are made in the background after an import, two at a time (and one video at a time
 * beside them), kept on disk as <dir>/<reader>/<article id>.html.gz (gzipped), .pdf or .mp4.
 * A page's copy is cut off from the internet when it is opened (monolith -I), so it works
 * offline and can't report back to anyone.
 *
 * monolith fetches whatever a page points at, so all of its traffic goes through a small proxy
 * that only connects to public addresses (lib/guard-proxy.ts): a page can't use a copy to reach
 * this machine, its database or the local network.
 */

import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { guardProxy, publicTarget } from "./guard-proxy";
import { APP_UA } from "./llm";
import { fetchArticle } from "./fetch-article";
import { youtubeId } from "./article";
import { downloadVideo, ytdlpReady } from "./youtube";

const DIR = process.env.GLOSS_ORIGINALS_DIR?.trim() || "";
/** monolith flags: keep going past a failed asset (-e), accept odd certificates (-k), cut the copy off from the internet (-I). */
const FLAGS = ["-e", "-k", "-I", "-t", "30"];
const MAX_RUN_MS = 240_000;
const MAX_BYTES = 200_000_000;
/** Less than this is an empty page: the document itself failed to load. */
const MIN_BYTES = 512;
/** At once: pages and PDFs, and beside them videos, which take minutes and shouldn't hold the rest up. */
const LANES = { short: 2, video: 1 } as const;
/** The largest video kept: two hours or so at 360p. */
const MAX_VIDEO_BYTES = 2_000_000_000;
const SAFE_ID = /^[\w.-]{1,160}$/;

export type OriginalKind = "page" | "pdf" | "video";
const EXT: Record<OriginalKind, string> = { page: ".html.gz", pdf: ".pdf", video: ".mp4" };
const KINDS = Object.keys(EXT) as OriginalKind[];

/** Whether this server keeps copies: a directory to keep them in. */
export function originalsEnabled(): boolean {
  return Boolean(DIR);
}

let monolith: boolean | null = null;

/** Whether this server can copy pages: that takes monolith. PDFs don't. */
export function canCopyPages(): boolean {
  if (monolith === null) {
    monolith = Boolean(DIR) && spawnSync("monolith", ["-V"], { stdio: "ignore", timeout: 5000 }).status === 0;
    if (DIR && !monolith) console.warn("originals: monolith is not installed, so pages are not copied; PDFs still are.");
  }
  return monolith;
}

function fileFor(userId: string, id: string, kind: OriginalKind): string | null {
  if (!SAFE_ID.test(userId) || !SAFE_ID.test(id) || id.startsWith(".")) return null;
  return join(DIR, userId, `${id}${EXT[kind]}`);
}

export type Original = { kind: OriginalKind; size: number; path: string };

/** The copy kept for a text, if there is one. */
export async function findOriginal(userId: string, id: string): Promise<Original | null> {
  if (!originalsEnabled()) return null;
  for (const kind of KINDS) {
    const path = fileFor(userId, id, kind);
    if (!path) return null;
    try {
      return { kind, size: (await stat(path)).size, path };
    } catch {}
  }
  return null;
}

/** A copy's file as a stream, or the bytes `range` asks for: gzipped HTML for a page, a PDF or a video as it came. */
export const openOriginal = (o: Original, range?: { start: number; end: number }) => createReadStream(o.path, range);

export async function removeOriginal(userId: string, id: string): Promise<void> {
  if (!originalsEnabled()) return;
  for (const kind of KINDS) {
    const f = fileFor(userId, id, kind);
    if (f) await rm(f, { force: true });
  }
}

/* ---------- making a copy ---------- */

/**
 * A copy opens sandboxed, where reading localStorage, sessionStorage or cookies throws, and a page
 * script that tries stops there (a theme switch, a reading-time counter). These stand-ins, in
 * memory and gone when the tab closes, go first in <head> so they are in place before any of the
 * page's own scripts run.
 */
const STAND_INS = `<script>/* Gloss: storage for this saved copy, in memory only. */(function(){function mem(){var d={};return{get length(){return Object.keys(d).length},key:function(i){var k=Object.keys(d);return i<k.length?k[i]:null},getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d={}}}}["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});try{document.cookie}catch(e){var jar={};try{Object.defineProperty(document,"cookie",{configurable:true,get:function(){return Object.keys(jar).map(function(k){return k+"="+jar[k]}).join("; ")},set:function(v){var p=String(v).split(";")[0],i=p.indexOf("=");if(i>0)jar[p.slice(0,i).trim()]=p.slice(i+1)}})}catch(_){}}})();</script>`;

/** The page with the stand-ins right after its <head> tag; unchanged when there is none near the top. */
function withStandIns(page: Buffer): Buffer[] {
  // latin1 maps every byte to one character, so the index found is a byte offset whatever the page's encoding.
  const m = /<head\b[^>]*>/i.exec(page.subarray(0, 1_000_000).toString("latin1"));
  if (!m) return [page];
  const at = m.index + m[0].length;
  return [page.subarray(0, at), Buffer.from(STAND_INS), page.subarray(at)];
}

type Job = { userId: string; id: string; url: string; kind: OriginalKind };
const queue: Job[] = [];
const pending = new Set<string>();
const running = { short: 0, video: 0 };
const laneOf = (kind: OriginalKind) => (kind === "video" ? "video" : "short");

/**
 * Save a copy of the page an article came from, its PDF or its video, in the background. False when
 * this server can't (copies are off, or no monolith for a page, no yt-dlp for a video); true once it
 * is on its way.
 */
export function queueOriginal(userId: string, id: string, url: string | undefined, kind: OriginalKind = "page"): boolean {
  if (!url || !/^https?:\/\//i.test(url) || !originalsEnabled() || !fileFor(userId, id, kind)) return false;
  if (kind === "page" && !canCopyPages()) return false;
  if (kind === "video" && (!youtubeId(url) || !ytdlpReady())) return false;
  const key = `${userId}/${id}`;
  if (pending.has(key)) return true;
  pending.add(key);
  queue.push({ userId, id, url, kind });
  drain();
  return true;
}

function drain() {
  for (let i = 0; i < queue.length; ) {
    const job = queue[i];
    const lane = laneOf(job.kind);
    if (running[lane] >= LANES[lane]) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    running[lane]++;
    void (job.kind === "pdf" ? savePdf(job) : job.kind === "video" ? saveVideo(job) : save(job))
      .catch((e) => console.error(`originals: could not save ${job.url}:`, e instanceof Error ? e.message : e))
      .finally(() => {
        running[lane]--;
        pending.delete(`${job.userId}/${job.id}`);
        drain();
      });
  }
}

async function save({ userId, id, url }: Job) {
  const final = fileFor(userId, id, "page")!;
  const html = `${final}.part.html`;
  const gz = `${final}.part`;
  // The page itself first: the proxy would refuse it too, but monolith, told to ignore errors, would then save an empty page.
  if (!(await publicTarget(new URL(url).hostname))) throw new Error("not a public address");
  await mkdir(join(DIR, userId), { recursive: true });
  const via = await guardProxy();
  const started = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      // A clean environment: monolith gets the proxy and nothing else, none of this server's keys.
      const child = spawn("monolith", [...FLAGS, "-u", `Mozilla/5.0 (compatible; ${APP_UA}; +reader)`, url, "-o", html], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HTTP_PROXY: via, HTTPS_PROXY: via, ALL_PROXY: via, http_proxy: via, https_proxy: via, NO_PROXY: "", no_proxy: "" } as unknown as NodeJS.ProcessEnv,
      });
      let err = "";
      child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
      const timer = setTimeout(() => child.kill("SIGKILL"), MAX_RUN_MS);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`monolith exited ${code}${err ? `: ${err.trim()}` : ""}`));
      });
    });
    const size = (await stat(html)).size;
    if (size < MIN_BYTES) throw new Error("monolith saved nothing: the page could not be read");
    if (size > MAX_BYTES) throw new Error(`the copy is ${Math.round(size / 1e6)} MB, over the ${MAX_BYTES / 1e6} MB limit`);
    const page = await readFile(html);
    await pipeline(Readable.from(withStandIns(page)), createGzip({ level: 6 }), createWriteStream(gz));
    await rename(gz, final);
    console.info(`originals: saved ${url} (${Math.round(size / 1024)} KB, ${Math.round((Date.now() - started) / 1000)} s)`);
  } finally {
    await rm(html, { force: true });
    await rm(gz, { force: true });
  }
}

/** The largest PDF kept, whether fetched from its link or sent up from the reader's browser. */
export const MAX_PDF_BYTES = 25_000_000;

/** Keep a PDF as a text's original. False when the bytes are not a PDF (or this server keeps no copies). */
export async function storePdf(userId: string, id: string, bytes: Buffer): Promise<boolean> {
  const final = originalsEnabled() ? fileFor(userId, id, "pdf") : null;
  // Every PDF starts with its version line, within the first kilobyte.
  if (!final || bytes.length > MAX_PDF_BYTES || !bytes.subarray(0, 1024).includes("%PDF-")) return false;
  const part = `${final}.part`;
  await mkdir(join(DIR, userId), { recursive: true });
  try {
    await writeFile(part, bytes);
    await rename(part, final);
  } finally {
    await rm(part, { force: true });
  }
  return true;
}

/** A PDF, fetched again from its link the way the import fetched it: every hop checked, at most 25 MB. */
async function savePdf({ userId, id, url }: Job) {
  const r = await fetchArticle(url, { pdf: true });
  if (!r.ok) throw new Error(r.error);
  if (!("pdf" in r)) throw new Error("the link no longer leads to a PDF");
  const bytes = Buffer.from(r.pdf);
  if (!(await storePdf(userId, id, bytes))) throw new Error("what came back is not a PDF");
  console.info(`originals: saved ${url} (${Math.round(bytes.length / 1024)} KB PDF)`);
}

/** A YouTube video at 360p, up to 2 GB. */
async function saveVideo({ userId, id, url }: Job) {
  const final = fileFor(userId, id, "video")!;
  const part = `${final}.part`;
  const started = Date.now();
  await mkdir(join(DIR, userId), { recursive: true });
  try {
    await downloadVideo(youtubeId(url)!, part, MAX_VIDEO_BYTES);
    // yt-dlp skips a video over the size limit without failing: then there is no file.
    const size = await stat(part).then((s) => s.size, () => 0);
    if (!size) throw new Error(`no video saved: it may be over ${MAX_VIDEO_BYTES / 1e9} GB at 360p`);
    await rename(part, final);
    console.info(`originals: saved ${url} (${Math.round(size / 1e6)} MB video, ${Math.round((Date.now() - started) / 1000)} s)`);
  } finally {
    await rm(part, { force: true });
    await rm(`${part}.part`, { force: true });
  }
}
