import { Readable } from "node:stream";
import { auth } from "@/lib/auth-server";
import { originalKind } from "@/lib/article";
import { articleSource } from "@/lib/db";
import { MAX_PDF_BYTES, findOriginal, openOriginal, originalsEnabled, queueOriginal, storePdf } from "@/lib/originals";

export const runtime = "nodejs";

const COMMON = {
  "Cache-Control": "private, no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

/**
 * A page's copy opens as a page of its own, and can't reach Gloss or anything else: the CSP
 * sandbox gives it an opaque origin (no cookies, no storage, no access to this app), and the
 * policy allows only what the copy carries inside itself, so its scripts run but load nothing.
 */
const PAGE_HEADERS = {
  ...COMMON,
  "Content-Type": "text/html; charset=utf-8",
  "Content-Encoding": "gzip",
  "Content-Security-Policy":
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms; default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline' data:; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; frame-src data: blob:; worker-src data: blob:",
};

/**
 * A PDF opens in the browser's own viewer, which keeps whatever scripts a PDF carries away from this
 * app; the sandbox makes sure, giving it an opaque origin. Chrome's viewer works sandboxed.
 */
const PDF_HEADERS = { ...COMMON, "Content-Type": "application/pdf", "Content-Security-Policy": "sandbox" };

type Ctx = { params: Promise<{ id: string }> };

async function who(): Promise<string | Response> {
  if (!originalsEnabled()) return new Response(null, { status: 501 });
  const { userId } = await auth();
  return userId ?? new Response(null, { status: 401 });
}

/** The copy of the page or PDF this text came from, as it was saved. */
export async function GET(_req: Request, { params }: Ctx) {
  const userId = await who();
  if (userId instanceof Response) return userId;
  const id = (await params).id;
  const copy = await findOriginal(userId, id);
  if (!copy) return Response.json({ error: "No saved copy of this text." }, { status: 404 });
  const headers =
    copy.kind === "pdf" ? { ...PDF_HEADERS, "Content-Disposition": `inline; filename="${id}.pdf"` } : PAGE_HEADERS;
  return new Response(Readable.toWeb(openOriginal(copy)) as ReadableStream, { headers: { ...headers, "Content-Length": String(copy.size) } });
}

/** Whether there is a copy: 200, 404 when there isn't, 501 when this server doesn't save them. */
export async function HEAD(_req: Request, { params }: Ctx) {
  const userId = await who();
  if (userId instanceof Response) return userId;
  return new Response(null, { status: (await findOriginal(userId, (await params).id)) ? 200 : 404 });
}

/** Save (or save again) a copy of the page or PDF this text came from. */
export async function POST(_req: Request, { params }: Ctx) {
  const userId = await who();
  if (userId instanceof Response) return userId;
  const id = (await params).id;
  const src = await articleSource(userId, id);
  const kind = src ? originalKind({ origin: src.origin, sourceUrl: src.url }) : null;
  if (!kind) return Response.json({ error: "This text has no page or PDF to save." }, { status: 404 });
  if (!queueOriginal(userId, id, src!.url, kind)) return Response.json({ error: "This server can't save copies of pages." }, { status: 501 });
  return Response.json({ queued: true }, { status: 202 });
}

/**
 * Keep a PDF the reader dropped in as a file: there is no link to fetch it from, so their browser
 * sends it up. Only for a text from a file that is on their shelf here already (the sync brings it
 * up a moment after the import, so the browser tries again on 404).
 */
export async function PUT(req: Request, { params }: Ctx) {
  const userId = await who();
  if (userId instanceof Response) return userId;
  const id = (await params).id;
  const src = await articleSource(userId, id);
  if (src?.origin !== "file") return Response.json({ error: "No text from a file with that id on this shelf." }, { status: 404 });
  const declared = Number(req.headers.get("content-length"));
  if (!declared) return Response.json({ error: "Send the PDF with its length." }, { status: 411 });
  if (declared > MAX_PDF_BYTES) return Response.json({ error: `PDFs over ${MAX_PDF_BYTES / 1e6} MB are kept in this browser only.` }, { status: 413 });
  const body = Buffer.from(await req.arrayBuffer());
  // The proxy (proxy.ts) holds bodies up to a limit (next.config.ts) and passes on only that much of a longer one.
  if (body.length !== declared) return Response.json({ error: "The PDF did not arrive whole." }, { status: 413 });
  if (!(await storePdf(userId, id, body))) return Response.json({ error: "That is not a PDF." }, { status: 415 });
  return Response.json({ saved: true }, { status: 201 });
}
