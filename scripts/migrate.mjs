// Applies db/schema.sql to DATABASE_URL. Idempotent. Run with `npm run db:migrate`.
// Neon goes over its HTTP driver; any other Postgres (the Docker one) over node-postgres, as in lib/db.ts.
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Put it in .env.local.");
  process.exit(1);
}

function driverFor(u) {
  const forced = process.env.DATABASE_DRIVER;
  if (forced === "neon" || forced === "pg") return forced;
  try {
    return new URL(u).hostname.endsWith(".neon.tech") ? "neon" : "pg";
  } catch {
    return "pg";
  }
}

let query;
let close = async () => {};
if (driverFor(url) === "neon") {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  query = (s) => sql.query(s);
} else {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  // A database container may still be starting: try for half a minute.
  for (let i = 0; ; i++) {
    try {
      await client.connect();
      break;
    } catch (e) {
      if (i >= 30) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  query = async (s) => (await client.query(s)).rows;
  close = () => client.end();
}

const statements = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8")
  .replace(/--.*$/gm, "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

for (const s of statements) await query(s);
const tables = await query("select table_name from information_schema.tables where table_schema = 'public' order by 1");
console.log(`Applied ${statements.length} statements. Tables: ${tables.map((t) => t.table_name).join(", ")}`);
await close();
