/** The signed-in reader on the server, whatever the deployment's auth mode (lib/auth-mode.ts). */

import { auth as clerkAuth } from "@clerk/nextjs/server";
import { CLERK_ENABLED, LOCAL_USER_ID } from "./auth-mode";

export async function auth(): Promise<{ userId: string | null }> {
  if (CLERK_ENABLED) return { userId: (await clerkAuth()).userId };
  return { userId: LOCAL_USER_ID };
}
