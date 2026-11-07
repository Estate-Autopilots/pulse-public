import { api } from "../../../lib/api";
import { Message, Page, PageHeader } from "../../../ui";
import type { Claim } from "../model";
import { ClaimQueue } from "./queue";

/** COMP-A: reimbursement claims waiting for the viewer: as the claimant's head, or as HR or a founder. */
export default async function Claims({ searchParams }: { searchParams: Promise<{ claim?: string }> }) {
  const [r, q] = await Promise.all([api<{ claims: Claim[]; keyring: boolean }>("comp/claims"), searchParams]);
  if (!r.data) return <Message text={r.error ?? "Not available"} />;
  return <Page>
    <PageHeader title="Claims to review" back={{ href: "/people/pay", label: "People & pay" }} context={[`${r.data.claims.length} waiting`]} />
    <ClaimQueue claims={r.data.claims} focus={q.claim} />
  </Page>;
}
