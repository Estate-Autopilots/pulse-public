import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import type { PersonPay } from "../../people/pay/model";
import { MyPay, type Payslip } from "./my-pay";

/** COMP-A: the person's own pay: what they are paid, their letters, an offer to answer, claims and one-time items. */
export default async function MyPayPage() {
  const r = await api<PersonPay>("comp/me");
  if (!r.data) return <Message text={r.error ?? "Not available"} />;
  // COMP-B: the payslips payroll issued.
  const slips = await api<{ payslips: Payslip[] }>(`comp/people/${r.data.person.id}/payslips`);
  return <Page>
    <PageHeader title="My pay" back={{ href: "/me", label: "My desk" }} context={["Only you, HR and the founders see this"]} />
    <MyPay p={r.data} payslips={slips.data?.payslips ?? []} />
  </Page>;
}
