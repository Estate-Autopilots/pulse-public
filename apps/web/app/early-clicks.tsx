import { headers } from "next/headers";
import { EARLY_SHIM } from "./lib/early-clicks.mjs";

/** DITASU-FIX: notes clicks made before the app's code starts and says "Pulse is starting…" (lib/early-clicks.mjs). First in
 *  <body>, with the request's CSP nonce like BootStart. */
export async function EarlyClicks() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <script id="pulse-early" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: EARLY_SHIM }} />;
}
