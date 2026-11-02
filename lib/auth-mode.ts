/**
 * Who the reader is depends on how Gloss is deployed. NEXT_PUBLIC_ values are
 * fixed at build time, so the server and the browser always agree.
 *
 * - Clerk keys set: accounts through Clerk, as on usegloss.io.
 * - NEXT_PUBLIC_GLOSS_LOCAL_USER=1 and no Clerk: one trusted reader, always
 *   signed in, with no sign-in screen. For a personal instance on your own
 *   machine (see docker-compose.yml). Anyone who can reach the server is that
 *   reader, so never set it on a public server.
 * - Neither: no accounts. The library stays in the browser.
 */
export const CLERK_ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export const LOCAL_USER_ID: string | null = !CLERK_ENABLED && process.env.NEXT_PUBLIC_GLOSS_LOCAL_USER === "1" ? "local" : null;
