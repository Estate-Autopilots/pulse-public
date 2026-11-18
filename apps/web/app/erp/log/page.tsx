import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import { ErpNav } from "../nav";
import { ERP_CONTEXT } from "../parts";
import { LogList, type LogEvent } from "./list";

export const metadata = { title: "Log · Billing" };

/** ERP-INVOICE: the ERP log, newest first: every document's life, catalog changes, settings and exports.
 *  UX-BILLING (5 Nov 2026): grouped by day, in plain words, with chips for what to show (log/list.tsx). */
export default async function ErpLog() {
  const r = await api<{ events: LogEvent[] }>("erp/log");
  if (!r.data) return <Message text={r.error ?? "The ERP log is unavailable"} />;
  return <Page>
    <PageHeader title="Billing log" context={[ERP_CONTEXT, "The last 200 things that happened"]} />
    <ErpNav current="log" />
    <LogList events={r.data.events} />
  </Page>;
}
