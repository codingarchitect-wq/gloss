import type { Metadata } from "next";
import { auth } from "@/lib/auth-server";
import { Landing } from "@/components/landing/Landing";

export const metadata: Metadata = { title: "Gloss", alternates: { canonical: "/" } };

export default async function Home() {
  const { userId } = await auth();
  return <Landing signedIn={Boolean(userId)} />;
}
