import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import { ErpNav } from "../nav";
import { ERP_CONTEXT } from "../parts";
import { PrintCentre, type PrintOverview } from "./print-centre";

export const metadata = { title: "Office printer" };
export const dynamic = "force-dynamic";

/** OFFICE-PRINT (owner at the Willow Lane office, 21 Nov 2026): the office printer as Vitals sees it: what was printed and
 *  why a print failed, the printer's paper and toner, and (admins) the office print agent that connects it. */
export default async function OfficePrinter() {
  const r = await api<PrintOverview>("office-print");
  if (!r.data) return <Message text={r.error ?? "Printing is for people who use Billing"} />;
  return <Page>
    <PageHeader title="Office printer" context={[ERP_CONTEXT, `${r.data.today} of ${r.data.limit} pages printed today`]} />
    <ErpNav current="print" own={!r.data.canManage} />
    <PrintCentre data={r.data} />
  </Page>;
}
