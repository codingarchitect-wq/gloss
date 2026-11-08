import { fetchLink } from "@/lib/fetch-link";

export const runtime = "nodejs";
export const maxDuration = 30;

/** A link, read for its card in the library's Links drawer: its title, description, picture and icon. */
export async function POST(req: Request) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const r = await fetchLink(typeof body.url === "string" ? body.url : "");
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ link: r.link });
}
