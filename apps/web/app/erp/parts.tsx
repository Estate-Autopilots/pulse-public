import Link from "next/link";
import { formatDate, formatInr } from "@pulse/invoice-doc/gst";
import { Badge } from "../ui";
import { LineRow } from "../kit/line-row";
import { STATUS_LABEL, STATUS_TONE, TYPE_LABEL } from "./nav";
import type { Doc } from "./types";
import css from "./erp.module.css";

// ERP-INVOICE: pieces the ERP pages share (server-safe).
export const rupees = (paise: number) => formatInr(paise, { decimals: false });
export const ERP_CONTEXT = "Billing";

export function DocRow({ d, today }: { d: Doc; today: string }) {
  const balance = d.total - d.paid - d.credited;
  const late = d.docType === "invoice" && ["issued", "sent", "part_paid"].includes(d.status) && d.dueDate && d.dueDate < today;
  return <li>
    <span className={css.rowMain}>
      <Link className={css.rowLink} href={`/erp/documents/${d.id}`}>{d.number ?? `${TYPE_LABEL[d.docType]} draft`} · {d.buyer?.name || "No client yet"}</Link>
      <span className={css.rowSub}>{TYPE_LABEL[d.docType]} · {formatDate(d.issueDate)}{d.reference?.project ? ` · ${d.reference.project}` : ""}{late ? ` · due ${formatDate(d.dueDate)}` : ""}</span>
    </span>
    <span className={css.rowEnd}>
      <span className={css.num}>{rupees(d.docType === "invoice" && ["issued", "sent", "part_paid"].includes(d.status) && (d.paid || d.credited) ? balance : d.total)}</span>
      <Badge tone={late ? "danger" : STATUS_TONE[d.status]}>{late ? "Overdue" : STATUS_LABEL[d.status]}</Badge>
    </span>
  </li>;
}

/** BILLING (18 Oct 2026): a document as one line (kit LineRow): number or "Quotation draft" and the client, type and date
 *  under it, the amount (the balance when part-paid) and its state. */
export function DocLine({ d, today }: { d: Doc; today: string }) {
  const open = d.docType === "invoice" && ["issued", "sent", "part_paid"].includes(d.status);
  const late = open && !!d.dueDate && d.dueDate < today;
  return <LineRow href={`/erp/documents/${d.id}`} stack title={`${d.number ?? `${TYPE_LABEL[d.docType]} draft`} · ${d.buyer?.name || "No client yet"}`}
    sub={[TYPE_LABEL[d.docType], formatDate(d.issueDate), d.reference?.project, late ? `due ${formatDate(d.dueDate)}` : null].filter(Boolean).join(" · ")}
    amount={rupees(open && (d.paid || d.credited) ? d.total - d.paid - d.credited : d.total)}
    end={<Badge tone={late ? "danger" : STATUS_TONE[d.status]}>{late ? "Overdue" : STATUS_LABEL[d.status]}</Badge>} />;
}
