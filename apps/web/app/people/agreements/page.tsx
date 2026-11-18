import { api, getMe } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import type { Contract, ContractsData } from "../../contracts/parts";
import { Workspace, type OffersData, type TeamPolicies } from "./workspace";

export const metadata = { title: "Agreements with your team" };

// FIX-PEOPLE-MONEY C6 (owner, 10 Nov 2026: "Sales & clients has agreements; People should also have agreements (offer
// letter, NDA)"): one agreements engine (Agreements, /contracts), seen from two sides; People shows the ones with the team.
// AGREEMENTS round 14 Nov (owner: "the right side panel is just empty … make an offer letter, but it does not do
// anything"): a workspace (workspace.tsx): the team's offer letters (People & pay's offers, agreements/people), agreements
// (employment, NDA … from /contracts) and policies (agreements/team), and a right panel that is never empty.
const TEAM_KINDS = new Set(["employment", "nda", "offer", "consultant", "internship"]);

export default async function TeamAgreements({ searchParams }: { searchParams: Promise<{ pick?: string }> }) {
  const q = await searchParams;
  const [r, offers, policies, me] = await Promise.all([api<ContractsData>("contracts"), api<OffersData>("agreements/people"), api<TeamPolicies>("agreements/team"), getMe()]);
  if (r.error && r.status !== 403 && !offers.data) return <Message text={r.error} />;
  const all = r.data ? [...r.data.company, ...r.data.mine] : [];
  const team: Contract[] = [...new Map(all.filter((c) => TEAM_KINDS.has(c.kind)).map((c) => [c.key, c])).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const canContract = Boolean(r.data?.canMake), viewer = me.data;
  const canPeople = !!viewer && ["admin", "hr", "leadership"].includes(viewer.role);
  const nOffers = offers.data?.offers.length ?? 0, plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return <Page>
    <PageHeader title="Agreements with your team" back={{ href: "/people", label: "Team" }} context={[nOffers || team.length ? `${plural(nOffers, "offer letter", "offer letters")} · ${plural(team.length, "agreement", "agreements")}` : "Offer letters, agreements and policies"]} />
    <Workspace offers={offers.data ?? null} contracts={team} policies={policies.data ?? null} canContract={canContract} canPeople={canPeople} pick={q.pick ?? null} />
  </Page>;
}
