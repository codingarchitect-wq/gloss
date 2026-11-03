import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import { CLERK_ENABLED } from "@/lib/auth-mode";

/**
 * Writes only from Gloss's own pages. A browser marks where a request comes from (Origin,
 * Sec-Fetch-Site), and any other site, or a sandboxed page with an opaque origin, is refused: on a
 * personal instance there is no sign-in to stop it, and a plain cross-site POST needs no preflight.
 * Requests without either header (curl, scripts on this machine) pass. Agents reach /mcp with a
 * token, from anywhere, so it is left out.
 */
function crossSite(req: NextRequest): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
  if (req.nextUrl.pathname === "/mcp" || req.nextUrl.pathname.startsWith("/mcp/")) return false;
  const origin = req.headers.get("origin");
  if (origin) {
    if (origin === "null") return true;
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    try {
      return new URL(origin).host !== host;
    } catch {
      return true;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

const refuse = () => NextResponse.json({ error: "Requests from other sites are refused." }, { status: 403 });

// Signing in is optional: nothing is protected here. Routes that need a user check auth() themselves.
// Without Clerk keys (lib/auth-mode.ts) there is no Clerk to run.
export default CLERK_ENABLED
  ? clerkMiddleware((_auth, req) => (crossSite(req) ? refuse() : undefined))
  : (req: NextRequest) => (crossSite(req) ? refuse() : NextResponse.next());

export const config = {
  matcher: [
    // Skip Next internals and static files, unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|mjs|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
