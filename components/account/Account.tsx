"use client";

import { CLERK_ENABLED, Show, SignInButton, UserButton } from "@/lib/auth-client";
import { barBtn } from "@/components/ui/Popover";

/** Signed out: a quiet "Sign in". Signed in: the avatar, with Clerk's account menu. */
export function Account() {
  // No accounts, or one local reader: nothing to sign in to and no account menu.
  if (!CLERK_ENABLED) return null;
  return (
    <>
      <Show when="signed-out">
        <SignInButton mode="modal">
          <button type="button" className={`${barBtn} !px-3 whitespace-nowrap`} data-tip="Keep your highlights and notes on every device">
            Sign in
          </button>
        </SignInButton>
      </Show>
      <Show when="signed-in">
        <span className="grid size-9 place-items-center">
          <UserButton appearance={{ elements: { avatarBox: "size-7" } }} />
        </span>
      </Show>
    </>
  );
}
