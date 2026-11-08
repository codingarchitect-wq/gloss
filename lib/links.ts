/** Links, shared by browser and server. */

import { slugify } from "./article";

/** The same link, written the same way: no fragment, no tracking parameters, no trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|ref_src$|s$|t$|fbclid$|gclid$|mc_)/i.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.replace(/^www\./, "");
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

/* ---------- links kept as cards ---------- */

/**
 * Some links are for keeping, not reading: a repo, a package, a model, a tool's
 * home page. The library keeps them as cards in its Links drawer instead of as
 * books on the shelf. A link kept that way has no text.
 */
export const isLink = (x: { kind?: string } | null | undefined): boolean => x?.kind === "link";

/** What a link's own site says about it, beyond its card: a repo's stars and language. */
export type LinkMeta = { stars?: number; language?: string; license?: string; archived?: boolean };

/** A link, read for its card: what /api/link answers. */
export type LinkInfo = {
  url: string;
  title: string;
  /** What it is, in the site's own words. */
  dek?: string;
  /** The picture it shares itself with (og:image). */
  image?: string;
  /** The site's icon. */
  icon?: string;
  /** The site's name. */
  source?: string;
  meta?: LinkMeta;
};

const parse = (raw: string): URL | null => {
  try {
    return new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
};

/** Where code lives. Any page there is a card, except a document in a repo, which reads as a text. */
const CODE = /^(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org|git\.sr\.ht|sr\.ht)$/;
const DOC_IN_REPO = /\/(blob|src|-\/blob)\/.+\.(md|markdown|mdx|txt|rst|adoc)$/i;
/** Packages, models, extensions and apps: host and path, without www. */
const KEEPERS = [
  /^npmjs\.com\/package\//,
  /^pypi\.org\/project\//,
  /^crates\.io\/crates\//,
  /^pkg\.go\.dev\//,
  /^rubygems\.org\/gems\//,
  /^packagist\.org\/packages\//,
  /^jsr\.io\/@/,
  /^hub\.docker\.com\//,
  /^marketplace\.visualstudio\.com\/items/,
  /^open-vsx\.org\/extension\//,
  /^huggingface\.co\/(?!blog\/|docs\/|learn\/|papers\/|posts\/)[^/]+\/[^/]+/,
  /^ollama\.com\/(library\/|[^/]+\/[^/]+$)/,
  /^replicate\.com\/[^/]+\/[^/]+/,
  /^apps\.apple\.com\//,
  /^play\.google\.com\/store\/apps\//,
  /^chromewebstore\.google\.com\//,
  /^chrome\.google\.com\/webstore\//,
  /^addons\.mozilla\.org\/[^/]+\/firefox\/addon\//,
  /^producthunt\.com\/(products|posts)\//,
  /^figma\.com\/community\//,
];

/**
 * Whether a link is better kept as a card than read as a text: anything on a
 * code host (but a document in a repo), a package, a model, an extension, an
 * app, or a site's home page. A link this misses still becomes a card when the
 * importer finds no article on its page.
 */
export function looksLikeLink(raw: string): boolean {
  const u = parse(raw);
  if (!u) return false;
  const host = u.hostname.replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  if (CODE.test(host)) return !DOC_IN_REPO.test(path);
  const at = `${host}${u.pathname}`;
  if (KEEPERS.some((re) => re.test(at))) return true;
  // A site's front door: a product, a tool, a person's site. A query asks for something on it.
  const query = [...u.searchParams.keys()].filter((k) => !/^(utm_|ref$|ref_src$|via$|fbclid$|gclid$)/i.test(k));
  return path === "" && !query.length;
}

/** A repository on GitHub, from a link to it or anywhere inside it. */
export function githubRepo(raw: string): { owner: string; repo: string } | null {
  const u = parse(raw);
  if (!u || u.hostname.replace(/^www\./, "") !== "github.com") return null;
  const [owner, repo] = u.pathname.split("/").filter(Boolean);
  // Pages of GitHub's own, not anybody's repo.
  if (!owner || !repo || /^(orgs|users|topics|collections|features|marketplace|sponsors|settings|explore|trending|search|login|about|pricing|enterprise|apps|site|security|customer-stories|readme|events)$/i.test(owner)) return null;
  return { owner, repo: repo.replace(/\.git$/, "") };
}

/** A count the way a repo page writes it: 950, 4.2k, 12k, 1.3M. */
export function fmtCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** A new card's id: what it is, and a few random letters. */
export const linkId = (title: string) => `link-${slugify(title).slice(0, 48).replace(/-+$/, "") || "site"}-${Math.random().toString(36).slice(2, 7)}`;
