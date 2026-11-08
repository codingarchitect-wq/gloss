import { auth } from "@/lib/auth-server";
import type { Article } from "@/lib/article";
import { articleDocs, pullRows, type PullRow } from "@/lib/db";
import { libraryFiles } from "@/lib/library-export";
import { SAMPLES } from "@/lib/samples";
import type { BriefState, Gloss, Highlight, LibraryItem, Progress } from "@/lib/store";
import { zip } from "@/lib/zip";

export const runtime = "nodejs";

/**
 * The reader's whole library from their account, as a zip of Markdown to read
 * without Gloss (lib/library-export.ts): what the library's Export button
 * makes in the browser, for a backup made from a script (scripts/backup.sh).
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in to export your library." }, { status: 401 });
  if (!process.env.DATABASE_URL) return Response.json({ error: "There is no database on this server." }, { status: 503 });

  const [{ changes }, docs] = await Promise.all([pullRows(userId, "1970-01-01T00:00:00Z"), articleDocs(userId)]);
  const live = (rows: PullRow[]) => rows.filter((r) => !r.deleted && r.data);
  const list = <T,>(rows: PullRow[]) => {
    const out: Record<string, T[]> = {};
    for (const r of live(rows)) (out[r.articleId] ??= []).push(r.data as T);
    return out;
  };
  const one = <T,>(rows: PullRow[]) => Object.fromEntries(live(rows).map((r) => [r.articleId, r.data as T]));

  const now = new Date();
  const { files } = libraryFiles(
    {
      library: live(changes.articles).map((r) => r.data as LibraryItem),
      docs: docs as Map<string, Article>,
      samples: SAMPLES,
      glosses: list<Gloss>(changes.glosses),
      highlights: list<Highlight>(changes.highlights),
      briefs: one<BriefState>(changes.briefs),
      progress: one<Progress>(changes.progress),
    },
    now
  );
  return new Response(zip(files), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="gloss-library-${now.toISOString().slice(0, 10)}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
