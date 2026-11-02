"use client";

import { useAuth } from "@/lib/auth-client";
import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { startSync } from "@/lib/sync";

/** Runs account sync while someone is signed in. Renders nothing. */
export function SyncAgent() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    useStore.getState().hydrate();
    const s = startSync(userId);
    return () => s.stop();
  }, [isLoaded, isSignedIn, userId]);
  return null;
}
