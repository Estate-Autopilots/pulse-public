import { api } from "../../../../lib/api";
import { Message, Page, PageHeader } from "../../../../ui";
import { runTitle, type Run } from "../model";
import { RunView } from "../run";

/** COMP-B: one payroll run, its steps, people, exceptions, payslips and bank file. */
export default async function PayrollRun({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<Run>(`comp/payroll/${encodeURIComponent(id)}`);
  if (!r.data) return <Message text={r.status === 403 ? "Payroll is for founders and HR. Your payslips are on My pay." : r.error ?? "Not available"} />;
  return <Page fit>
    <PageHeader title={runTitle(r.data)} back={{ href: "/people/pay/payroll", label: "Payroll" }} context={[`${r.data.lines.length} ${r.data.lines.length === 1 ? "person" : "people"}`, "Figures hidden until shown; every look is logged"]} />
    <RunView run={r.data} />
  </Page>;
}
