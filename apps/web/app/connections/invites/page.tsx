import { api, getMe } from "../../lib/api";
import { Page, PageHeader } from "../../ui";
import { ConnectionsView, type Data } from "../view";

// CONNECT (0953): this organisation's client invitations, its connected organisations' shared groups and tasks, and
// (for admins, HR and leadership) client requests: one link per closed deal. CONNECTIONS (16 Nov 2026): reached from
// "People and companies you work with" (/connections), which lists every connection across your spaces.
export const metadata = { title: "Client invitations" };
export default async function ConnectionInvites() {
  const [r, me] = await Promise.all([api<Data>("connections"), getMe()]);
  const orgName = me.data?.orgName ?? "this organisation";
  return <Page><PageHeader title="Client invitations" context={["Invite a client to work with you on Pulse", orgName]} back={{ href: "/connections", label: "Connections" }} />
    {r.data ? <ConnectionsView data={r.data} orgName={orgName} /> : <p role="alert">{r.error ?? "Connections are unavailable right now."}</p>}</Page>;
}
