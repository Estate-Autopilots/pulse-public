import { redirect } from "next/navigation";
import { getMe } from "../lib/api";
import { adminUrl } from "../lib/admin-site.mjs";
import { Message } from "../ui";
import { OpenConsole } from "./open-console";

export const metadata = { title: "Admin console" };
export const dynamic = "force-dynamic";

// PULSE-ADMIN: Pulse's company back office is its own site (apps/admin, pulse-admin.<domain>). This address only leads
// there. SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.4: "if I have to log in again, that's a very hectic job ... no problem
// message"): a platform admin, from whichever company they are in, arrives signed in: this page makes a one-time hand-off
// (auth/admin-handoff, from the browser) and the admin site trades it for its own session (/handoff#<token>; a fragment
// never reaches a server log). Anyone else who types this address goes to their own company's admin, Settings: no dead end.
export default async function AdminConsole() {
  const me = await getMe();
  if (me.error || !me.data) return <Message text={me.error ?? "Sign in to Pulse"} />;
  if (!(me.data.platformAdmin || me.data.platformConsole) || me.data.mustChange) redirect("/settings");
  const site = adminUrl();
  if (!site) return <Message notice="The admin site has no address on this server yet (PULSE_ADMIN_URL)." />;
  // The hand-off is made in the browser once this page is open (open-console.tsx), never by a prefetch.
  return <OpenConsole site={site} />;
}
