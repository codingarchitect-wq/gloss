import { auth } from "@/lib/auth-server";
import { originalKind } from "@/lib/article";
import { articleSources } from "@/lib/db";
import { findOriginal, originalsEnabled, queueOriginal } from "@/lib/originals";

export const runtime = "nodejs";

/** Save copies for every text on the shelf that came from a page or a PDF link and has none yet. */
export async function POST() {
  if (!originalsEnabled()) return Response.json({ error: "This server doesn't save copies." }, { status: 501 });
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in first." }, { status: 401 });
  let queued = 0;
  for (const a of await articleSources(userId)) {
    const kind = originalKind({ origin: a.origin, sourceUrl: a.url });
    if (!kind || (await findOriginal(userId, a.id))) continue;
    if (queueOriginal(userId, a.id, a.url, kind)) queued++;
  }
  return Response.json({ queued }, { status: 202 });
}
