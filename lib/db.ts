/**
 * Postgres on Neon, over its HTTP driver: one round trip per query, no pool
 * to manage in serverless functions. Any other Postgres (a Docker container on
 * your own machine, say) goes through node-postgres instead, behind the same
 * two calls. The URL's host picks the driver; DATABASE_DRIVER=neon|pg overrides
 * it. Server-side only.
 */

import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";

type Row = Record<string, any>;
/** A query that runs when awaited, or that transaction() runs together with others. */
type Query = PromiseLike<Row[]>;
type Sql = {
  query(text: string, params?: unknown[]): Query;
  transaction(queries: Query[]): Promise<Row[][]>;
};

export function driverFor(url: string, forced = process.env.DATABASE_DRIVER): "neon" | "pg" {
  if (forced === "neon" || forced === "pg") return forced;
  try {
    return new URL(url).hostname.endsWith(".neon.tech") ? "neon" : "pg";
  } catch {
    return "pg";
  }
}

/** Neon's queries are lazy, so they can be handed to a transaction; these are too. */
class PgQuery implements PromiseLike<Row[]> {
  private run?: Promise<Row[]>;
  constructor(
    private pool: Pool,
    readonly text: string,
    readonly params: unknown[] = []
  ) {}
  then<A = Row[], B = never>(ok?: ((rows: Row[]) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    this.run ??= this.pool.query(this.text, this.params).then((r) => r.rows);
    return this.run.then(ok, bad);
  }
}

function pgSql(url: string): Sql {
  // One pool per process, kept across dev reloads so they don't each open new connections.
  const g = globalThis as { __glossPool?: Pool };
  const pool = (g.__glossPool ??= new Pool({ connectionString: url, max: 5 }));
  pool.removeAllListeners("error");
  pool.on("error", (e) => console.error("db: idle connection failed", e));
  return {
    query: (text, params) => new PgQuery(pool, text, params),
    async transaction(queries) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out: Row[][] = [];
        for (const q of queries as PgQuery[]) out.push((await client.query(q.text, q.params)).rows);
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

let client: Sql | null = null;

export function db(): Sql {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set.");
    client = driverFor(url) === "neon" ? (neon(url) as unknown as Sql) : pgSql(url);
  }
  return client;
}

/** The tables the sync route reads and writes. Names are only ever taken from this list. */
export const COLLECTIONS = ["articles", "highlights", "glosses", "briefs", "progress"] as const;
export type Collection = (typeof COLLECTIONS)[number];
export const isCollection = (v: unknown): v is Collection => typeof v === "string" && (COLLECTIONS as readonly string[]).includes(v);

export type PushRow = { id: string; article_id: string; data: unknown; deleted: boolean; doc?: unknown };
export type PullRow = { id: string; articleId: string; data: unknown; deleted: boolean };

/** Rows changed since `since` in every collection, tombstones included, plus the server clock to pull from next time. */
export async function pullRows(userId: string, since: string): Promise<{ now: string; changes: Record<Collection, PullRow[]> }> {
  const sql = db();
  const [clock, ...results] = await sql.transaction([
    sql.query("select now() as now"),
    ...COLLECTIONS.map((t) =>
      sql.query(`select id, article_id, data, deleted from ${t} where user_id = $1 and updated_at > $2 order by updated_at`, [userId, since])
    ),
  ]);
  const changes = Object.fromEntries(
    COLLECTIONS.map((t, i) => [
      t,
      (results[i] as Record<string, unknown>[]).map((r) => ({ id: String(r.id), articleId: String(r.article_id), data: r.deleted ? null : r.data, deleted: Boolean(r.deleted) })),
    ])
  ) as Record<Collection, PullRow[]>;
  return { now: new Date((clock as { now: string }[])[0].now).toISOString(), changes };
}

/** Upsert every collection's rows in one transaction. The server stamps the time, so the latest write wins. */
export async function pushRows(userId: string, changes: Partial<Record<Collection, PushRow[]>>): Promise<void> {
  const sql = db();
  const queries = Object.entries(changes)
    .filter(([t, rows]) => isCollection(t) && rows?.length)
    .map(([t, rows]) => sql.query(upsert(t as Collection), [userId, JSON.stringify(rows)]));
  // A text taken off the shelf takes its painted cover with it.
  const gone = (changes.articles ?? []).filter((r) => r.deleted).map((r) => r.id);
  if (gone.length) queries.push(sql.query("delete from covers where user_id = $1 and id = any($2::text[])", [userId, gone]));
  if (queries.length) await sql.transaction(queries);
}

/** One article's full text. */
export async function articleDoc(userId: string, id: string): Promise<unknown | null> {
  const rows = await db().query("select doc from articles where user_id = $1 and id = $2 and not deleted and doc is not null", [userId, id]);
  return rows.length ? rows[0].doc : null;
}

/** One statement per table: unpack the JSON array of rows and upsert them all. An article pushed without its text keeps the stored one. */
function upsert(table: Collection): string {
  const isArticles = table === "articles";
  return `insert into ${table} (user_id, id, article_id, data, deleted, updated_at${isArticles ? ", doc" : ""})
    select $1, r.id, r.article_id, r.data, r.deleted, now()${isArticles ? ", r.doc" : ""}
    from jsonb_to_recordset($2::jsonb) as r(id text, article_id text, data jsonb, deleted boolean${isArticles ? ", doc jsonb" : ""})
    on conflict (user_id, id) do update set
      article_id = excluded.article_id, data = excluded.data, deleted = excluded.deleted, updated_at = now()${
        isArticles ? ", doc = case when excluded.deleted then null else coalesce(excluded.doc, articles.doc) end" : ""
      }`;
}

/** Where an article came from: its page and how it was added. */
export async function articleSource(userId: string, id: string): Promise<{ url?: string; origin?: string } | null> {
  const rows = await db().query("select data->>'sourceUrl' as url, data->>'origin' as origin from articles where user_id = $1 and id = $2 and not deleted", [userId, id]);
  return rows.length ? { url: rows[0].url ?? undefined, origin: rows[0].origin ?? undefined } : null;
}

/** Every article on a reader's shelf, with its page and how it was added. */
export async function articleSources(userId: string): Promise<{ id: string; url?: string; origin?: string }[]> {
  const rows = await db().query("select id, data->>'sourceUrl' as url, data->>'origin' as origin from articles where user_id = $1 and not deleted", [userId]);
  return rows.map((r) => ({ id: String(r.id), url: r.url ?? undefined, origin: r.origin ?? undefined }));
}

/* ---------- painted covers ---------- */

export async function saveCover(userId: string, id: string, jpeg: Uint8Array): Promise<void> {
  await db().query(
    `insert into covers (user_id, id, jpeg) values ($1, $2, $3)
     on conflict (user_id, id) do update set jpeg = excluded.jpeg, created_at = now()`,
    [userId, id, Buffer.from(jpeg).toString("base64")]
  );
}

export async function loadCover(userId: string, id: string): Promise<Uint8Array | null> {
  const rows = await db().query("select jpeg from covers where user_id = $1 and id = $2", [userId, id]);
  return rows.length ? Uint8Array.from(Buffer.from(String(rows[0].jpeg), "base64")) : null;
}

/* ---------- agent tokens ---------- */

export type AgentToken = { id: string; label: string; createdAt: string; lastUsedAt: string | null };

export async function createToken(userId: string, id: string, hash: string, label: string): Promise<void> {
  await db().query("insert into agent_tokens (id, user_id, hash, label) values ($1, $2, $3, $4)", [id, userId, hash, label]);
}

export async function listTokens(userId: string): Promise<AgentToken[]> {
  const rows = await db().query("select id, label, created_at, last_used_at from agent_tokens where user_id = $1 and not revoked order by created_at desc", [userId]);
  return rows.map((r) => ({ id: String(r.id), label: String(r.label), createdAt: new Date(r.created_at).toISOString(), lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null }));
}

export async function revokeToken(userId: string, id: string): Promise<boolean> {
  const rows = await db().query("update agent_tokens set revoked = true where user_id = $1 and id = $2 and not revoked returning id", [userId, id]);
  return rows.length > 0;
}

/** The reader a token belongs to, noting that it was used. Null for an unknown or revoked token. */
export async function tokenUser(hash: string): Promise<{ userId: string; label: string } | null> {
  const rows = await db().query("update agent_tokens set last_used_at = now() where hash = $1 and not revoked returning user_id, label", [hash]);
  return rows.length ? { userId: String(rows[0].user_id), label: String(rows[0].label ?? "") } : null;
}

/* ---------- the library, for an agent ---------- */

export type ShelfRow = { id: string; data: Record<string, unknown>; pct: number };

/** Every text on a reader's shelf, with how far they've read. */
export async function shelfOf(userId: string): Promise<ShelfRow[]> {
  const rows = await db().query(
    `select a.id, a.data, p.data as progress from articles a
     left join progress p on p.user_id = a.user_id and p.id = a.id and not p.deleted
     where a.user_id = $1 and not a.deleted order by a.updated_at desc`,
    [userId]
  );
  return rows.map((r) => ({ id: String(r.id), data: (r.data ?? {}) as Record<string, unknown>, pct: Number((r.progress as { pct?: number } | null)?.pct ?? 0) }));
}

/** Put one imported text on a reader's shelf, as their browser would: the next sync brings it down. */
export async function shelveForUser(userId: string, item: { id: string }, doc: unknown): Promise<void> {
  await db().query(
    `insert into articles (user_id, id, article_id, data, doc, deleted, updated_at) values ($1, $2, $2, $3, $4, false, now())
     on conflict (user_id, id) do update set data = excluded.data, doc = excluded.doc, deleted = false, updated_at = now()`,
    // A link kept as a card has no text: its doc is null, as a bundled sample's is.
    [userId, item.id, JSON.stringify(item), doc == null ? null : JSON.stringify(doc)]
  );
}
