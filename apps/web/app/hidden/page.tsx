import { getMe } from "../lib/api";
import { HiddenNotice } from "./notice";

export const metadata = { title: "Hidden by your admin" };

/** EST-1420: where a direct link to a screen the organisation hides from this person's role lands (layout.tsx sends it
 *  here before the page renders). In-app navigation is held by HiddenGate instead (layouts are reused, not re-run). */
export default async function Hidden() {
  const me = (await getMe()).data;
  return <HiddenNotice admin={me?.role === "admin"} client={me?.side === "client" ? me.orgName ?? "" : undefined} />;
}
