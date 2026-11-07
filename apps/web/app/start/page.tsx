import { cookies, headers } from "next/headers";
import { getMe } from "../lib/api";
import { StartWizard } from "./wizard";

export const metadata = { title: "Start your company on Pulse" };
export const dynamic = "force-dynamic";

/** ONBOARD-SELF: the public entry (the sign-in page's footer links here) and, signed in, "start another company".
 *  It stands alone like the sign-in page (layout.tsx). Signed out it makes the Pulse account first. */
export default async function Start() {
  const h = await headers();
  const maybe = (await cookies()).has("pulse_session") || !!h.get("cf-access-authenticated-user-email");
  const me = maybe ? (await getMe()).data : null;
  return <StartWizard signedIn={!!me?.person} you={me?.name ?? ""} />;
}
