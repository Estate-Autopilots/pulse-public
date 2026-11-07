import { redirect } from "next/navigation";
import { getMe } from "../../lib/api";
import { Page, PageHeader } from "../../ui";
import { InviteTeam } from "../invite";

export const metadata = { title: "Invite your team" };

/** ONBOARD-SELF: step two of starting a company: who to invite, by seat, then the "how your team starts" page. */
export default async function Team() {
  const me = (await getMe()).data;
  if (!me?.person) redirect("/login?next=/start/team");
  const lead = me.role === "admin" || me.role === "leadership" || me.role === "hr" || !!me.lead;
  if (!lead) redirect("/start/ready");
  return <Page><PageHeader title="Invite your team" context={[`${me.orgName ?? "Your company"} is ready. Who works with you?`]} />
    <InviteTeam org={me.orgName ?? "your company"} next="/start/ready" /></Page>;
}
