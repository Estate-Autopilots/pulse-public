import { CalmPage, PageHeader } from "../components/page-kit";
import { api } from "../lib/api";
import { Message } from "../ui";
import { FundingList, type Program } from "./list";

export const dynamic = "force-dynamic";

/** FOCUS: funding and credits the company can apply for, and what stands in the way. */
export default async function FundingPage() {
  const r = await api<{ programs: Program[] }>("funding");
  if (r.error || !r.data) return <Message text={r.error ?? "Funding is unavailable."} />;
  return <CalmPage>
    <PageHeader title="Funding" lede="Credits and grants we can apply for, and what blocks each one." />
    <FundingList programs={r.data.programs} />
  </CalmPage>;
}
