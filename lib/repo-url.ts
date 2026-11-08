/**
 * A code repository, from a link to it or to anywhere inside it: where to clone
 * it from, and its name (host/owner/repo). On GitHub, GitLab, Codeberg,
 * Bitbucket and sourcehut; null for anything else, those sites' own pages
 * included. Shared by browser and server.
 */

export type RepoRef = { host: string; path: string; name: string; clone: string };

/** GitHub's own pages, not anybody's repo. */
export const GITHUB_PAGES =
  /^(orgs|users|topics|collections|features|marketplace|sponsors|settings|explore|trending|search|login|signup|join|about|pricing|enterprise|apps|site|security|customer-stories|readme|events|notifications|new|codespaces|issues|pulls|discussions|organizations|account|contact|team|resources|solutions|why-github|mobile|github-copilot|copilot|dashboard)$/i;

const PAGES: Record<string, RegExp> = {
  "github.com": GITHUB_PAGES,
  "gitlab.com": /^(explore|users|dashboard|help|groups|projects|search|admin|api|oauth|profile|snippets|-)$/i,
  "codeberg.org": /^(explore|user|repo|org|notifications|admin|api|assets|-)$/i,
  "bitbucket.org": /^(account|dashboard|product|site|repo|workspace|socialauth|blog)$/i,
};

/** A GitLab project's own pages, in links made before GitLab put them under /-/. */
const GITLAB_TAIL = /^(tree|blob|raw|issues|merge_requests|commits|commit|tags|releases|wikis|pipelines|activity|graphs|compare|branches)$/;

const SEGMENT = /^[\w.~-]+$/;
const ok = (s?: string) => Boolean(s && SEGMENT.test(s) && !/^\.+$/.test(s));

export function repoOf(raw: string): RepoRef | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  let path: string[];

  if (host === "github.com" || host === "codeberg.org" || host === "bitbucket.org") {
    path = parts.slice(0, 2);
  } else if (host === "gitlab.com") {
    // Groups nest: gitlab.com/group/subgroup/project/-/tree/main.
    const end = parts.indexOf("-");
    path = end >= 0 ? parts.slice(0, end) : parts;
    const tail = path.findIndex((p, i) => i >= 2 && GITLAB_TAIL.test(p));
    if (tail >= 0) path = path.slice(0, tail);
  } else if (host === "git.sr.ht") {
    path = parts.slice(0, 2);
    if (!path[0]?.startsWith("~")) return null;
  } else return null;

  if (path.length < 2) return null;
  path[path.length - 1] = path[path.length - 1].replace(/\.git$/, "");
  if (!path.every(ok) || PAGES[host]?.test(path[0])) return null;
  const p = path.join("/");
  return { host, path: p, name: `${host}/${p}`, clone: host === "git.sr.ht" ? `https://${host}/${p}` : `https://${host}/${p}.git` };
}
