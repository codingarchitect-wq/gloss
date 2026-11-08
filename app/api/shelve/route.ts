import { chargeFree, checkFree, needKey } from "@/lib/quota";
import { classify, type ShelveInput } from "@/lib/shelve";
import { serverKey } from "@/lib/llm";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Sort one text onto the library's shelves: a topic, a few tags and a scene for its cover. */
export async function POST(req: Request) {
  let body: ShelveInput & { apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof body.title !== "string" || !body.title.trim()) return Response.json({ error: "title is required." }, { status: 400 });
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const input: ShelveInput = { title: body.title.slice(0, 300), author: str(body.author, 200), source: str(body.source, 200), dek: str(body.dek, 600), excerpt: str(body.excerpt, 3000), link: body.link === true || undefined };

  const apiKey = body.apiKey?.trim() || undefined;
  let free: Awaited<ReturnType<typeof checkFree>> | null = null;
  if (!apiKey) {
    if (!serverKey()) return needKey(null);
    // A whole shelf may be sorted at once on a first visit, so the burst is generous.
    free = await checkFree(req, 90);
    if (!free.ok) return needKey(free);
  }
  const r = await classify(input, { apiKey, signal: req.signal });
  if (free && r.ok) await chargeFree(free.subject, r.usd);
  if (!r.ok) return Response.json({ error: r.error }, { status: 502 });
  return Response.json(r.shelving);
}
