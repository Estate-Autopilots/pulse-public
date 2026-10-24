import Link from "next/link";
import { api } from "../../lib/api";
import { Message, Page, PageHeader, Panel } from "../../ui";
import { ErpNav, TYPE_LABEL } from "../nav";
import { ERP_CONTEXT } from "../parts";
import css from "../erp.module.css";

type Event = { id: string; subjectType: string; subjectId: string | null; kind: string; detail: Record<string, unknown>; at: string; actor: string | null; number: string | null; docType: string | null; item: string | null };
const WHAT: Record<string, string> = { created: "created", edited: "edited", issued: "issued", exported: "exported", sent: "marked sent", payment: "payment recorded", payment_voided: "payment removed",
  cancel: "cancelled", accepted: "accepted", declined: "declined", task: "invoice task created", link_created: "acceptance link made", link_opened: "client opened the link",
  client_accepted: "accepted by the client", client_declined: "declined by the client", deleted: "draft deleted", saved: "saved", parts: "parts changed", seeded: "seeded as a draft", in: "stock in", out: "stock out", adjust: "stock adjusted" };

/** ERP-INVOICE: the ERP log, newest first: every document's life, catalog changes, settings and exports. */
export default async function ErpLog() {
  const r = await api<{ events: Event[] }>("erp/log");
  if (!r.data) return <Message text={r.error ?? "The ERP log is unavailable"} />;
  return <Page>
    <PageHeader title="Billing log" context={[ERP_CONTEXT, "Last 200 events"]} />
    <ErpNav current="log" />
    <div className={css.body}>
      <Panel title="Everything that happened" sub="Pulse's audit trail keeps every field change too">
        <ul className={css.rows}>{r.data.events.map((e) => {
          const subject = e.subjectType === "document" ? (e.number ? `${TYPE_LABEL[e.docType ?? "invoice"] ?? ""} ${e.number}` : `${TYPE_LABEL[e.docType ?? "invoice"] ?? "Document"} draft`)
            : e.subjectType === "item" || e.subjectType === "stock" ? e.item ?? "Catalog item" : e.subjectType === "settings" ? "Settings" : e.subjectType;
          const href = e.subjectId && e.subjectType === "document" && e.kind !== "deleted" ? `/erp/documents/${e.subjectId}` : e.subjectId && (e.subjectType === "item" || e.subjectType === "stock") ? `/erp/catalog/${e.subjectId}` : null;
          return <li key={e.id}><span className={css.rowMain}>{href ? <Link className={css.rowLink} href={href}>{subject} · {WHAT[e.kind] ?? e.kind}</Link> : <strong>{subject} · {WHAT[e.kind] ?? e.kind}</strong>}
            <span className={css.rowSub}>{new Date(e.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} · {e.actor ?? (e.kind.startsWith("client") || e.kind === "link_opened" ? "client" : "Pulse")}</span></span></li>;
        })}</ul>
      </Panel>
    </div>
  </Page>;
}
