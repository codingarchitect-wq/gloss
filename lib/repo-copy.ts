/**
 * Saved copies of the repos kept as link cards, beside the other saved
 * originals (lib/originals.ts): the latest commit of each repo's default
 * branch, without its history, as a git bundle, one file that `git clone`
 * turns back into the repo. A shallow clone can't be bundled as it is (its
 * commit points at parents the bundle doesn't have), so its files are committed
 * again with no parent, keeping the author, the dates and the message, and the
 * original commit's id is added under the message.
 *
 * A copy is looked at again once a week, and made again when the branch has
 * moved on. A new copy under half the size of the one before (the code taken
 * down, a notice put in its place) doesn't take its place alone: the old one is
 * kept beside it, as <id>.bundle.prev. A repo that is gone keeps its last copy.
 * What is known about a copy (its commit, when it was saved and last looked at,
 * whether the original is gone) is kept beside it in <id>.repo.json.
 *
 * git runs with none of this machine's configuration or credentials, never
 * prompts, speaks https only, and is only pointed at the code hosts repoOf knows.
 * Server-side only.
 */

import { spawn, spawnSync } from "node:child_process";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repoOf } from "./repo-url";

export type RepoCopy = {
  /** host/owner/repo */
  name: string;
  /** The card's link. */
  url: string;
  branch?: string;
  /** The original commit the copy holds. */
  commit?: string;
  committedAt?: string;
  /** The commit's first line. */
  subject?: string;
  size?: number;
  savedAt?: string;
  /** When the original was last looked at. */
  checkedAt: string;
  /** Since when the original can't be found. Its last copy stays. */
  goneSince?: string;
  /** Why the last look failed. */
  error?: string;
  /** A larger, earlier copy, set aside when the code shrank: <id>.bundle.prev. */
  previous?: { commit?: string; committedAt?: string; size: number; savedAt?: string };
};

/** The largest copy kept, and the most a clone may take on the way. */
const MAX_BYTES = 1_000_000_000;
const CLONE_MS = 15 * 60_000;
const STEP_MS = 5 * 60_000;
/** A new copy under this share of the one before doesn't replace it alone. */
const SHRINK = 0.5;
/** The original is gone (or private now), as opposed to a network that failed for a moment. */
const GONE = /not found|could not read Username|Authentication failed|Access denied|HTTP Basic|unavailable|DMCA|returned error: (401|403|404|410|451)/i;

let git: boolean | null = null;
/** Whether this server can copy repos: that takes git. */
export function gitReady(): boolean {
  if (git === null) git = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  return git;
}

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", LANG: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const SAFE = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "credential.helper=", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60", "-c", "core.hooksPath=/dev/null"];

type Ran = { code: number | null; out: string; err: string };

/** git, given `ms` to finish. `tooBig`, asked every few seconds, stops it when it says so. */
function run(args: string[], opts: { ms: number; input?: string; env?: Record<string, string>; tooBig?: () => Promise<boolean> }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...SAFE, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...ENV, ...opts.env } as unknown as NodeJS.ProcessEnv });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.ms);
    const watch = opts.tooBig
      ? setInterval(() => void opts.tooBig!().then((big) => big && child.kill("SIGKILL")), 5000)
      : undefined;
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      resolve({ code, out, err: err.trim() });
    });
    child.stdin.end(opts.input ?? "");
  });
}

async function sizeOf(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (e.isFile()) n += await stat(join(e.parentPath, e.name)).then((s) => s.size, () => 0);
  }
  return n;
}

const infoFile = (file: string) => file.replace(/\.bundle$/, ".repo.json");

export async function readRepoCopy(file: string): Promise<RepoCopy | null> {
  try {
    return JSON.parse(await readFile(infoFile(file), "utf8")) as RepoCopy;
  } catch {
    return null;
  }
}

async function writeRepoCopy(file: string, info: RepoCopy): Promise<void> {
  const to = infoFile(file);
  for (const k of Object.keys(info) as (keyof RepoCopy)[]) if (info[k] === undefined) delete info[k];
  await writeFile(`${to}.part`, JSON.stringify(info, null, 2));
  await rename(`${to}.part`, to);
}

/** The last lines git wrote, without its "remote:" and "fatal:" prefixes. */
const tidy = (err: string) =>
  err
    .split("\n")
    .map((l) => l.replace(/^(remote|fatal|error):\s*/i, "").trim())
    .filter(Boolean)
    .slice(-2)
    .join(" ")
    .slice(0, 300) || "git failed";

/**
 * Save the repo a card links to, or bring its copy up to date. `file`: where
 * its bundle goes (<dir>/<reader>/<id>.bundle). Throws when no copy could be
 * made; what went wrong is kept with the copy's record as well.
 */
export async function saveRepoCopy(url: string, file: string): Promise<{ saved: boolean; size?: number }> {
  const ref = repoOf(url);
  if (!ref) throw new Error("not a repository on a code host Gloss knows");
  const before = await readRepoCopy(file);
  const had = await stat(file).then((s) => s.size, () => 0);
  const now = () => new Date().toISOString();

  const failed = async (why: string): Promise<never> => {
    const gone = GONE.test(why);
    await writeRepoCopy(file, {
      ...(before ?? {}),
      name: ref.name,
      url,
      // A network that failed for a moment is tried again within the hour; a gone repo next week.
      checkedAt: gone || !before ? now() : before.checkedAt,
      goneSince: gone && had ? (before?.goneSince ?? now()) : before?.goneSince,
      error: tidy(why),
    });
    throw new Error(tidy(why));
  };

  // Where the default branch is now: one round trip, and nothing more to do when it hasn't moved.
  const head = await run(["ls-remote", "--symref", ref.clone, "HEAD"], { ms: 60_000 });
  if (head.code !== 0) return failed(head.err || "git ls-remote failed");
  const sha = /^([0-9a-f]{40,64})\tHEAD$/m.exec(head.out)?.[1];
  if (!sha) return failed("the repository has no commits");
  if (had && before?.commit === sha) {
    await writeRepoCopy(file, { ...before, name: ref.name, url, checkedAt: now(), goneSince: undefined, error: undefined });
    return { saved: false, size: had };
  }

  const tmp = `${file}.part.git`;
  const part = `${file}.part`;
  await rm(tmp, { recursive: true, force: true });
  try {
    const clone = await run(["clone", "--quiet", "--bare", "--depth", "1", "--single-branch", "--no-tags", ref.clone, tmp], {
      ms: CLONE_MS,
      tooBig: async () => (await sizeOf(tmp)) > MAX_BYTES,
    });
    if (clone.code !== 0) return failed(clone.err || `the clone was stopped: over ${MAX_BYTES / 1e9} GB, or over ${CLONE_MS / 60_000} minutes`);

    const g = (args: string[], more: { input?: string; env?: Record<string, string> } = {}) => run(["-C", tmp, ...args], { ms: STEP_MS, ...more });
    const log = await g(["log", "-1", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%B", "HEAD"]);
    const [commit, an, ae, ad, cn, ce, cd, ...rest] = log.out.split("\x1f");
    const message = rest.join("\x1f").trim() || "(no message)";
    const branch = (await g(["symbolic-ref", "--short", "HEAD"])).out.trim();
    if (log.code !== 0 || !commit || !branch) return failed(log.err || "the clone has no branch");

    // The same files as a commit with no parent, so the bundle can be cloned.
    const snap = await g(["commit-tree", "HEAD^{tree}"], {
      input: `${message}\n\nGloss-Snapshot-Of: ${ref.clone} ${branch} ${commit}\n`,
      env: { GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad, GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce, GIT_COMMITTER_DATE: cd },
    });
    if (snap.code !== 0) return failed(snap.err);
    const ref2 = await g(["update-ref", `refs/heads/${branch}`, snap.out.trim()]);
    if (ref2.code !== 0) return failed(ref2.err);
    const bundle = await g(["bundle", "create", "--quiet", part, "--all"]);
    if (bundle.code !== 0) return failed(bundle.err);

    const size = (await stat(part)).size;
    if (size > MAX_BYTES) return failed(`the copy is ${Math.round(size / 1e6)} MB, over the ${MAX_BYTES / 1e6} MB limit`);
    let previous = before?.previous;
    if (had && size < had * SHRINK) {
      await rename(file, `${file}.prev`);
      previous = { commit: before?.commit, committedAt: before?.committedAt, size: had, savedAt: before?.savedAt };
    }
    await rename(part, file);
    const at = now();
    await writeRepoCopy(file, { name: ref.name, url, branch, commit, committedAt: cd, subject: message.split("\n")[0].slice(0, 200), size, savedAt: at, checkedAt: at, previous });
    return { saved: true, size };
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(part, { force: true });
  }
}
