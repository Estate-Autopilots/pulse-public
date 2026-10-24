import { api } from "../../../lib/api";
import { Message, Page, PageHeader } from "../../../ui";
import type { PersonPay } from "../model";
import { PersonPayView } from "../person";

/** COMP-A: one person's pay from offer to exit. `?do=` opens the step the People & pay table pointed to. */
export default async function PersonPayPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ do?: string }> }) {
  const [{ id }, q] = await Promise.all([params, searchParams]);
  const r = await api<PersonPay>(`comp/people/${encodeURIComponent(id)}`);
  if (!r.data) return <Message text={r.status === 403 ? "This pay is for founders, HR and the person." : r.error ?? "Not available"} />;
  return <Page>
    <PageHeader title="Pay" back={{ href: "/people/pay", label: "People & pay" }} context={[r.data.person.name]} />
    <PersonPayView p={r.data} start={/^[a-z.]{3,30}$/.test(q.do ?? "") ? q.do : undefined} />
  </Page>;
}
