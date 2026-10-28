import { api, getMe } from "../lib/api";
import { Page, PageHeader } from "../ui";
import { ConnectionsView, type Data } from "./view";

// CONNECT: the organisations this one works with on Pulse (clients it invited, companies it is a client of), the groups
// and tasks shared in each connection, and (for admins, HR and leadership) client requests: one link per closed deal.
export const metadata = { title: "Connections" };
export default async function Connections() {
  const [r, me] = await Promise.all([api<Data>("connections"), getMe()]);
  const orgName = me.data?.orgName ?? "this organisation";
  return <Page><PageHeader title="Connections" context={["Clients and partners on Pulse", orgName]} />
    {r.data ? <ConnectionsView data={r.data} orgName={orgName} /> : <p role="alert">{r.error ?? "Connections are unavailable right now."}</p>}</Page>;
}
