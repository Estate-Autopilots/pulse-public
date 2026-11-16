import { headers } from "next/headers";
import { appNameFor } from "../lib/app-name";
import { safeNext } from "../lib/safe-next.mjs";
import { SignupForm } from "./form";

export const metadata = { title: "Create your Pulse account" };

/** PULSE-ID: "New to Pulse? Create your account", reached from Sign in with Pulse; afterwards straight back to the app's
 *  consent screen. Only return addresses inside Pulse are kept (the sign-in page's own check). ACCOUNT-CODE (1465): also
 *  from the sign-in page at the shared address; without a return address it opens the new account's home. SELF-SERVE:
 *  on the way to an app (Sign in with Pulse, or the ChatGPT or Claude connector) it names the app. */
export default async function Signup({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  const forApp = await appNameFor(next, await headers());
  return <SignupForm next={next} forApp={forApp} />;
}
