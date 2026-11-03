/**
 * Saved copies of the originals, for when the reader wants to see a text as it was published.
 * A page: everything it is made of (styles, pictures, fonts, scripts, video) packed into one HTML
 * file by monolith (github.com/Y2Z/monolith). A PDF link: the PDF itself. Server-side only, and
 * only where GLOSS_ORIGINALS_DIR is set; pages also need monolith (the Docker image has both).
 *
 * Copies are made in the background after an import, two at a time, and kept on disk as
 * <dir>/<reader>/<article id>.html.gz (gzipped) or .pdf. A page's copy is cut off from the
 * internet when it is opened (monolith -I), so it works offline and can't report back to anyone.
 *
 * monolith fetches whatever a page points at, so all of its traffic goes through a small proxy
 * here that only connects to public addresses, checked when the socket opens (lib/public-net.ts):
 * a page can't use a copy to reach this machine, its database or the local network.
 */

import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { isPublicAddress } from "./public-net";
import { APP_UA } from "./llm";
import { fetchArticle } from "./fetch-article";

const DIR = process.env.GLOSS_ORIGINALS_DIR?.trim() || "";
/** monolith flags: keep going past a failed asset (-e), accept odd certificates (-k), cut the copy off from the internet (-I). */
const FLAGS = ["-e", "-k", "-I", "-t", "30"];
const MAX_RUN_MS = 240_000;
const MAX_BYTES = 200_000_000;
/** Less than this is an empty page: the document itself failed to load. */
const MIN_BYTES = 512;
const AT_ONCE = 2;
const SAFE_ID = /^[\w.-]{1,160}$/;

export type OriginalKind = "page" | "pdf";
const EXT: Record<OriginalKind, string> = { page: ".html.gz", pdf: ".pdf" };

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
  for (const kind of ["page", "pdf"] as const) {
    const path = fileFor(userId, id, kind);
    if (!path) return null;
    try {
      return { kind, size: (await stat(path)).size, path };
    } catch {}
  }
  return null;
}

/** A copy's file as a stream: gzipped HTML for a page, the PDF as it came. */
export const openOriginal = (o: Original) => createReadStream(o.path);

export async function removeOriginal(userId: string, id: string): Promise<void> {
  if (!originalsEnabled()) return;
  for (const kind of ["page", "pdf"] as const) {
    const f = fileFor(userId, id, kind);
    if (f) await rm(f, { force: true });
  }
}

/* ---------- the proxy monolith goes through ---------- */

/** The address to connect to, or null when a host resolves to anything that isn't public. */
async function publicTarget(host: string): Promise<string | null> {
  const h = host.replace(/^\[|\]$/g, "");
  try {
    const addrs = net.isIP(h) ? [{ address: h }] : await lookup(h, { all: true });
    if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) return null;
    return addrs[0].address;
  } catch {
    return null;
  }
}

let proxy: Promise<string> | null = null;

/** A forward proxy on 127.0.0.1 that connects only to public addresses, pinned to the one it checked. */
export function guardProxy(): Promise<string> {
  proxy ??= new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // Plain http: the request line carries the whole URL.
      let url: URL;
      try {
        url = new URL(req.url ?? "");
      } catch {
        return res.writeHead(400).end();
      }
      const ip = url.protocol === "http:" ? await publicTarget(url.hostname) : null;
      if (!ip) return res.writeHead(403).end();
      const up = http.request(
        { host: ip, port: Number(url.port) || 80, method: req.method, path: url.pathname + url.search, headers: { ...req.headers, host: url.host }, setHost: false, timeout: 60_000 },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        }
      );
      up.on("error", () => res.headersSent || res.writeHead(502).end());
      up.on("timeout", () => up.destroy());
      req.pipe(up);
    });
    // https: a tunnel, opened only to a public address. TLS runs end to end, so monolith still checks the certificate's name.
    server.on("connect", async (req, client: net.Socket, head: Buffer) => {
      const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
      const ip = m ? await publicTarget(m[1]) : null;
      if (!m || !ip) return client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      const upstream = net.connect(Number(m[2]), ip, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.setTimeout(60_000, () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "");
    });
  });
  return proxy;
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
let running = 0;

/**
 * Save a copy of the page an article came from, or of its PDF, in the background. False when this
 * server can't (copies are off, or a page and no monolith); true once it is on its way.
 */
export function queueOriginal(userId: string, id: string, url: string | undefined, kind: OriginalKind = "page"): boolean {
  if (!url || !/^https?:\/\//i.test(url) || !originalsEnabled() || !fileFor(userId, id, kind)) return false;
  if (kind === "page" && !canCopyPages()) return false;
  const key = `${userId}/${id}`;
  if (pending.has(key)) return true;
  pending.add(key);
  queue.push({ userId, id, url, kind });
  void drain();
  return true;
}

async function drain() {
  while (running < AT_ONCE && queue.length) {
    const job = queue.shift()!;
    running++;
    void (job.kind === "pdf" ? savePdf(job) : save(job))
      .catch((e) => console.error(`originals: could not save ${job.url}:`, e instanceof Error ? e.message : e))
      .finally(() => {
        running--;
        pending.delete(`${job.userId}/${job.id}`);
        void drain();
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
