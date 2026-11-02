"use client";

/**
 * Clerk's hooks and components, or stand-ins when Clerk is not configured
 * (lib/auth-mode.ts). Components import these instead of @clerk/nextjs, so
 * Gloss runs with or without accounts. The choice is fixed at build time, so
 * hooks are always called in the same order.
 */

import * as Clerk from "@clerk/nextjs";
import type { ReactNode } from "react";
import { CLERK_ENABLED, LOCAL_USER_ID } from "./auth-mode";

export { CLERK_ENABLED, LOCAL_USER_ID };

type AuthState = { isLoaded: boolean; isSignedIn: boolean | undefined; userId: string | null | undefined };
type UserState = { isSignedIn: boolean | undefined; user: { firstName: string | null; fullName: string | null } | null | undefined };

const LOCAL_AUTH: AuthState = { isLoaded: true, isSignedIn: Boolean(LOCAL_USER_ID), userId: LOCAL_USER_ID };
const LOCAL_USER: UserState = { isSignedIn: Boolean(LOCAL_USER_ID), user: null };

export const useAuth: () => AuthState = CLERK_ENABLED
  ? () => {
      const a = Clerk.useAuth();
      return { isLoaded: a.isLoaded, isSignedIn: a.isSignedIn, userId: a.userId };
    }
  : () => LOCAL_AUTH;

export const useUser: () => UserState = CLERK_ENABLED
  ? () => {
      const u = Clerk.useUser();
      return { isSignedIn: u.isSignedIn, user: u.user };
    }
  : () => LOCAL_USER;

/** Without Clerk there is no signing in, so "signed-out" content (sign-in prompts) never shows. */
export function Show({ when, children }: { when: "signed-in" | "signed-out"; children: ReactNode }) {
  if (CLERK_ENABLED) return <Clerk.Show when={when}>{children}</Clerk.Show>;
  return when === "signed-in" && LOCAL_USER_ID ? <>{children}</> : null;
}

export function SignInButton({ children, mode }: { children: ReactNode; mode?: "modal" | "redirect" }) {
  return CLERK_ENABLED ? <Clerk.SignInButton mode={mode}>{children}</Clerk.SignInButton> : null;
}

export function UserButton(props: Parameters<typeof Clerk.UserButton>[0]) {
  return CLERK_ENABLED ? <Clerk.UserButton {...props} /> : null;
}
