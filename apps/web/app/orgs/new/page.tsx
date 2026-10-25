import { api, getMe } from "../../lib/api";
import { Page, PageHeader } from "../../ui";
import { StartOrg, type PackCard } from "./start";

// ORG: Start your own Pulse: one step, an industry pack (FLOW-E), and you are its owner; switch back any time.
export default async function NewOrganisation() {
  const [packs, me] = await Promise.all([api<{ packs: PackCard[] }>("account/packs"), getMe()]);
  return <Page><PageHeader title="Start your own Pulse" back={{ href: "/orgs", label: "Organisations" }} context={[`You stay in ${me.data?.orgName ?? "your organisation"} too: switch between them any time`]} />
    <StartOrg packs={packs.data?.packs ?? []} error={packs.error ?? null} you={me.data?.name ?? ""} /></Page>;
}
