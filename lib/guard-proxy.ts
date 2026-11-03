/**
 * The way out to the internet for the tools that fetch on a reader's behalf (monolith for saved
 * pages, yt-dlp for videos): a forward proxy on 127.0.0.1 that connects only to public addresses,
 * checked as each socket opens and pinned to the address it checked (lib/public-net.ts). A page
 * can't use them to reach this machine, its database or the local network. Server-side only.
 */

import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { isPublicAddress } from "./public-net";

/** The address to connect to, or null when a host resolves to anything that isn't public. */
export async function publicTarget(host: string): Promise<string | null> {
  const h = host.replace(/^\[|\]$/g, "");
  try {
    const addrs = net.isIP(h) ? [{ address: h }] : await lookup(h, { all: true });
    if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) return null;
    return addrs[0].address;
  } catch {
    return null;
  }
}

/**
 * How long a server gets to accept a connection. Old pages point at servers long gone that never
 * answer (an ad network's spacer image, say), and each wait held a copy up for monolith's whole
 * timeout; one page took 91 s that way, 1 s for everything else.
 */
const CONNECT_MS = 10_000;
/** A server that didn't answer is given up on for a while, so a page that points at it again doesn't wait again. */
const DEAD_MS = 10 * 60_000;
const dead = new Map<string, number>();

function isDead(key: string): boolean {
  const until = dead.get(key);
  if (until && until > Date.now()) return true;
  dead.delete(key);
  return false;
}

/** Give up on a connection that isn't made in time, and remember the server for a while. */
function connectDeadline(key: string, onTimeout: () => void): () => void {
  const t = setTimeout(() => {
    dead.set(key, Date.now() + DEAD_MS);
    onTimeout();
  }, CONNECT_MS);
  return () => clearTimeout(t);
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
      const port = Number(url.port) || 80;
      const key = `${url.hostname}:${port}`;
      if (url.protocol === "http:" && isDead(key)) return res.writeHead(504).end();
      const ip = url.protocol === "http:" ? await publicTarget(url.hostname) : null;
      if (!ip) return res.writeHead(403).end();
      // A socket of its own (no agent), so every request connects, and the deadline covers just that.
      const up = http.request(
        { host: ip, port, method: req.method, path: url.pathname + url.search, headers: { ...req.headers, host: url.host }, setHost: false, agent: false, timeout: 60_000 },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        }
      );
      const connected = connectDeadline(key, () => up.destroy(new Error("no answer")));
      up.on("socket", (s) => s.once("connect", connected));
      up.on("close", connected);
      up.on("error", () => res.headersSent || res.writeHead(502).end());
      up.on("timeout", () => up.destroy());
      req.pipe(up);
    });
    // https: a tunnel, opened only to a public address. TLS runs end to end, so monolith still checks the certificate's name.
    server.on("connect", async (req, client: net.Socket, head: Buffer) => {
      const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
      if (m && isDead(req.url!)) return client.end("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
      const ip = m ? await publicTarget(m[1]) : null;
      if (!m || !ip) return client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      const connected = connectDeadline(req.url!, () => {
        upstream.destroy();
        client.end("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
      });
      const upstream = net.connect(Number(m[2]), ip, () => {
        connected();
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.setTimeout(60_000, () => upstream.destroy());
      upstream.on("close", connected);
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
