import { redirect } from "next/navigation";
import { getMe } from "../lib/api";
import { adminUrl } from "../lib/admin-site.mjs";
import { Message } from "../ui";

export const metadata = { title: "Admin console" };

// PULSE-ADMIN: Pulse's company back office is its own site (apps/admin, pulse-admin.<domain>). This address only leads
// there, for its platform admins; the in-app console it replaced is gone.
export default async function AdminConsole() {
  const me = await getMe();
  if (me.error || !me.data) return <Message text={me.error ?? "Sign in to Pulse"} />;
  const site = adminUrl();
  if (!me.data.platformAdmin) return <Message notice="The admin console is for Pulse’s platform admins. Your organisation’s own settings are under Settings." />;
  if (!site) return <Message notice="The admin site has no address on this server yet (PULSE_ADMIN_URL)." />;
  redirect(site);
}
