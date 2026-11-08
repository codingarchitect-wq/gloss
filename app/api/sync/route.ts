import { auth } from "@/lib/auth-server";
import { isCollection, pullRows, pushRows, type Collection, type PushRow } from "@/lib/db";
import { originalKind } from "@/lib/article";
import { findOriginal, originalsEnabled, queueOriginal, removeOriginal, tendRepos } from "@/lib/originals";

export const runtime = "nodejs";

/** Vercel caps a request body at 4.5MB; the client batches below this. */
const MAX_BODY = 4_400_000;
const MAX_ROWS = 2000;
const MAX_DATA = 256_000;

type InRow = { id: string; articleId: string; data: unknown; deleted?: boolean; doc?: unknown };

/**
 * Pull: every row of the signed-in reader's that changed since `since`,
 * tombstones included. Article texts are left out; they are fetched one at a
 * time from /api/articles/[id], so a big shelf never makes a huge response.
 */
export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in to sync." }, { status: 401 });
  if (!process.env.DATABASE_URL) return Response.json({ error: "There is no database on this server." }, { status: 503 });
  const raw = new URL(req.url).searchParams.get("since");
  const since = raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : "1970-01-01T00:00:00Z";
  // While the library is in use, its repo copies are kept current (at most once an hour; lib/originals.ts).
  void tendRepos(userId).catch((e) => console.error("originals: could not tend repos:", e instanceof Error ? e.message : e));
  return Response.json(await pullRows(userId, since));
}

/** Push: upsert the rows a device changed. */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in to sync." }, { status: 401 });
  if (!process.env.DATABASE_URL) return Response.json({ error: "There is no database on this server." }, { status: 503 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ error: "Too large." }, { status: 413 });

  let body: { changes?: Record<string, InRow[]> };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const changes: Partial<Record<Collection, PushRow[]>> = {};
  let count = 0;
  for (const [table, rows] of Object.entries(body.changes ?? {})) {
    if (!isCollection(table) || !Array.isArray(rows)) continue;
    changes[table] = rows.filter(valid).map((r) => ({
      id: r.id,
      article_id: r.articleId,
      data: r.deleted ? {} : r.data,
      deleted: Boolean(r.deleted),
      ...(table === "articles" ? { doc: r.deleted ? null : r.doc ?? null } : {}),
    }));
    count += changes[table].length;
  }
  if (count > MAX_ROWS) return Response.json({ error: "Too many rows in one push." }, { status: 413 });
  await pushRows(userId, changes);
  // Saved copies follow the shelf: one is made for a new text from a page, a PDF link or a video, and goes with it.
  if (originalsEnabled()) {
    for (const r of changes.articles ?? []) {
      if (r.deleted) await removeOriginal(userId, r.id).catch(() => {});
      else {
        const d = (r.data ?? {}) as { sourceUrl?: unknown; origin?: unknown };
        const kind = originalKind(d);
        if (kind && !(await findOriginal(userId, r.id))) queueOriginal(userId, r.id, d.sourceUrl as string, kind);
      }
    }
  }
  return Response.json({ ok: true, count });
}

function valid(r: InRow): boolean {
  if (!r || typeof r.id !== "string" || typeof r.articleId !== "string") return false;
  if (!r.id || r.id.length > 120 || !r.articleId || r.articleId.length > 120) return false;
  if (r.deleted) return true;
  return typeof r.data === "object" && r.data !== null && JSON.stringify(r.data).length <= MAX_DATA;
}
