import { api, getMe } from "../../../lib/api";
import { Message, Page, PageHeader } from "../../../ui";
import type { Claim } from "../model";
import { ClaimQueue } from "./queue";

/** COMP-A: reimbursement claims waiting for the viewer: as the claimant's head, or as HR or a founder. */
export default async function Claims({ searchParams }: { searchParams: Promise<{ claim?: string }> }) {
  const [r, q, me] = await Promise.all([api<{ claims: Claim[]; keyring: boolean }>("comp/claims"), searchParams, getMe()]);
  // VISUAL-QA (D83): a head of team reviews claims here, but People & pay opens only for admin, leadership and HR with
  // the salary grant (the menu's rule); anyone else goes back to Team, not to "This view is unavailable".
  const pay = !!me.data && ["admin", "leadership", "hr"].includes(me.data.role) && me.data.hrAccess !== false;
  if (!r.data) return <Message text={r.error ?? "Not available"} />;
  return <Page>
    <PageHeader title="Claims to review" back={pay ? { href: "/people/pay", label: "People & pay" } : { href: "/people", label: "Team" }} context={[`${r.data.claims.length} waiting`]} />
    <ClaimQueue claims={r.data.claims} focus={q.claim} />
  </Page>;
}
