import { api, getMe, type AccountState } from "../lib/api";
import Link from "next/link";
import { Page, PageHeader, styles } from "../ui";
import { OrgsView, type Invite } from "./view";

// ORG: your organisations on this Pulse: switch, accept invitations, start your own, your handle and account password,
// and (for admins, HR and leadership) invitations into this organisation.
export default async function Organisations() {
  const [account, me] = await Promise.all([api<AccountState>("account"), getMe()]);
  const canInvite = ["admin", "leadership", "hr"].includes(me.data?.role ?? "");
  const invites = canInvite ? (await api<{ invites: Invite[] }>("account/invites")).data?.invites ?? [] : null;
  return <Page><PageHeader title="Organisations" context={["One Pulse account for every organisation you work with"]}
      actions={<><Link className={styles.btn} href="/connections">Connections</Link>{["admin", "leadership"].includes(me.data?.role ?? "") ? <Link className={styles.btn} href="/orgs/licences">Licences</Link> : null}</>} />
    <OrgsView state={account.data ?? null} error={account.error ?? null} invites={invites} orgName={me.data?.orgName ?? "this organisation"} /></Page>;
}
