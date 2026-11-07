import { api } from "../../../lib/api";
import { Message, Page, PageHeader } from "../../../ui";
import type { Runs } from "./model";
import { Months } from "./months";

/** COMP-B: Payroll for founders and HR: the next step, then every month's run. */
export default async function Payroll() {
  const r = await api<Runs>("comp/payroll");
  if (!r.data) return <Message text={r.status === 403 ? "Payroll is for founders and HR. Your payslips are on My pay." : r.error ?? "Not available"} />;
  return <Page fit>
    <PageHeader title="Payroll" back={{ href: "/people/pay", label: "People & pay" }} context={["Draft → HR checks → a founder approves → locked", "Pulse never pays"]} />
    <Months data={r.data} />
  </Page>;
}
