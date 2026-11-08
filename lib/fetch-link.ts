/**
 * Reading a link for its card, on the server: what the page says about itself
 * in its head (its title, its description, the picture it shares itself with,
 * its icon), and for a GitHub repo, its stars and language from GitHub's API.
 * Only the head is read. A page that can't be read still makes a card, from
 * its address alone: the reader asked to keep the link, not to read it.
 */

import { parseHTML } from "linkedom";
import { tidyTitle, undash } from "@/lib/article";
import { fetchPublic, safeUrl } from "@/lib/fetch-article";
import { githubRepo, type LinkInfo, type LinkMeta } from "@/lib/links";
import { APP_UA } from "@/lib/llm";
import { publicFetch, type PublicResponse } from "@/lib/public-net";

/** Enough for any page's head. Reading stops at </head>. */
const HEAD_BYTES = 1_000_000;

export async function fetchLink(raw: string): Promise<{ ok: true; link: LinkInfo } | { ok: false; error: string; status: number }> {
  const checked = await safeUrl(raw.trim());
  if (typeof checked === "string") return { ok: false, error: checked, status: 400 };
  const gh = githubRepo(checked.toString());
  const [page, repo] = await Promise.all([readHead(checked).catch(() => null), gh ? githubInfo(gh.owner, gh.repo).catch(() => null) : null]);

  const at = page?.url ?? checked;
  const host = at.hostname.replace(/^www\./, "");
  const link: LinkInfo = {
    url: at.toString(),
    title: repo?.title ?? (gh ? `${gh.owner}/${gh.repo}` : page?.title) ?? bareTitle(at),
    // A repo without a description gets GitHub's stock line in its page's head.
    dek: repo?.dek ?? (gh && /by creating an account on GitHub/i.test(page?.dek ?? "") ? undefined : page?.dek),
    image: page?.image,
    icon: page?.icon ?? `${at.origin}/favicon.ico`,
    source: gh ? "GitHub" : page?.site ?? host,
    meta: repo?.meta,
  };
  for (const k of Object.keys(link) as (keyof LinkInfo)[]) if (link[k] === undefined) delete link[k];
  return { ok: true, link };
}

/** A link's address as its title, when its page says nothing: the site, and the last part of the path. */
function bareTitle(u: URL): string {
  const host = u.hostname.replace(/^www\./, "");
  const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_+]+/g, " ").trim();
  return last ? `${host}: ${last}`.slice(0, 120) : host;
}

type Head = { url: URL; title?: string; dek?: string; image?: string; icon?: string; site?: string };

async function readHead(start: URL): Promise<Head | null> {
  const got = await fetchPublic(start, "text/html,application/xhtml+xml", 10_000);
  if (!got.ok) return null;
  const { res, url } = got;
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) {
    await res.body?.cancel().catch(() => {});
    return res.ok ? { url } : null;
  }
  const { document } = parseHTML(await headOf(res));
  const meta = (...names: string[]) => {
    for (const n of names) {
      const v = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute("content")?.replace(/\s+/g, " ").trim();
      if (v) return v;
    }
    return undefined;
  };
  const abs = (v?: string | null) => {
    if (!v) return undefined;
    try {
      const u = new URL(v, url);
      return /^https?:$/.test(u.protocol) ? u.toString() : undefined;
    } catch {
      return undefined;
    }
  };
  const title = meta("og:title", "twitter:title") ?? document.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim();
  const dek = meta("og:description", "description", "twitter:description");
  const site = meta("og:site_name", "application-name")?.slice(0, 80);
  return {
    url,
    title: title ? withoutSite(tidyTitle(undash(title)), [site, url.hostname]).slice(0, 200) : undefined,
    dek: dek ? clip(undash(dek), 300) : undefined,
    image: abs(meta("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src")),
    icon: abs(bestIcon(document as unknown as Document)),
    site,
  };
}

/** A title without the site's name after it ("Qwen3-8B · Hugging Face"): the card shows the site already. */
function withoutSite(title: string, names: (string | undefined)[]): string {
  const m = /^(.{3,}?)\s+[·|•–—-]\s+([^·|•–—]{2,40})$/.exec(title);
  if (!m) return title;
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const tail = squash(m[2]);
  return tail && names.some((n) => n && squash(n).includes(tail)) ? m[1] : title;
}

/** The page up to the end of its head, and no further than HEAD_BYTES. */
async function headOf(res: PublicResponse): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder();
  let html = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
    if (html.length > HEAD_BYTES || /<\/head>/i.test(html)) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return html;
}

/** The sharpest icon the page offers: a touch icon, else the largest one, else any. */
function bestIcon(doc: Document): string | null {
  let best: { href: string; score: number } | null = null;
  for (const el of Array.from(doc.querySelectorAll("link[rel][href]"))) {
    const rel = (el.getAttribute("rel") ?? "").toLowerCase();
    if (!/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel) || rel.includes("mask-icon")) continue;
    const href = el.getAttribute("href")!;
    const sizes = (el.getAttribute("sizes") ?? "").split(/\s+/).map((s) => Number(s.split("x")[0]) || 0);
    const size = (el.getAttribute("sizes") ?? "").includes("any") || /\.svg(\?|$)/i.test(href) ? 256 : Math.max(16, ...sizes);
    const score = (rel.includes("apple-touch-icon") ? 1000 : 0) + Math.min(size, 512);
    if (!best || score > best.score) best = { href, score };
  }
  return best?.href ?? null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3).replace(/\s+\S*$/, "")}...` : s);

/** GitHub's own words about a repo: anonymous calls get 60 an hour, GITHUB_TOKEN raises that. */
async function githubInfo(owner: string, repo: string): Promise<{ title: string; dek?: string; meta: LinkMeta } | null> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": APP_UA, "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await publicFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers, signal: AbortSignal.timeout(6000) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const j = (await res.json()) as {
    full_name?: string;
    description?: string | null;
    stargazers_count?: number;
    language?: string | null;
    license?: { spdx_id?: string | null } | null;
    archived?: boolean;
  };
  const meta: LinkMeta = {
    stars: typeof j.stargazers_count === "number" ? j.stargazers_count : undefined,
    language: j.language || undefined,
    license: j.license?.spdx_id && j.license.spdx_id !== "NOASSERTION" ? j.license.spdx_id : undefined,
    archived: j.archived || undefined,
  };
  for (const k of Object.keys(meta) as (keyof LinkMeta)[]) if (meta[k] === undefined) delete meta[k];
  return { title: j.full_name || `${owner}/${repo}`, dek: j.description ? clip(undash(j.description.trim()), 300) : undefined, meta };
}
