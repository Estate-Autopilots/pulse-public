import { safeNext } from "../lib/safe-next.mjs";
import { SignupForm } from "./form";

export const metadata = { title: "Create your Pulse account" };

/** PULSE-ID: "New to Pulse? Create your account", reached from Sign in with Pulse; afterwards straight back to the app's
 *  consent screen. Only return addresses inside Pulse are kept (the sign-in page's own check). */
export default async function Signup({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next) ?? "/";
  return <SignupForm next={next} />;
}
