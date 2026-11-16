import Link from "next/link";
import type { ReactNode } from "react";
import { formatDate, formatInr } from "@pulse/invoice-doc/gst";
import { Badge } from "../ui";
import { LineRow } from "../kit/line-row";
import { StripeRow, type Tone } from "../components/calm";
import { docStateWords } from "../lib/billing-words.mjs";
import { STATUS_LABEL, STATUS_TONE, TYPE_LABEL } from "./nav";
import { docNumber } from "./documents/chain";
import { DEAL_LABEL, type Doc, type DealStatus } from "./types";
import css from "./erp.module.css";

// ERP-INVOICE: pieces the ERP pages share (server-safe).
export const rupees = (paise: number) => formatInr(paise, { decimals: false });
export const ERP_CONTEXT = "Billing";

export function DocRow({ d, today }: { d: Doc; today: string }) {
  const balance = d.total - d.paid - d.credited;
  const late = d.docType === "invoice" && ["issued", "sent", "part_paid"].includes(d.status) && d.dueDate && d.dueDate < today;
  return <li>
    <span className={css.rowMain}>
      <Link className={css.rowLink} href={`/erp/documents/${d.id}`}>{docNumber(d) ?? `${TYPE_LABEL[d.docType]} draft`} · {d.buyer?.name || "No client yet"}</Link>
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
  return <LineRow href={`/erp/documents/${d.id}`} stack title={`${docNumber(d) ?? `${TYPE_LABEL[d.docType]} draft`} · ${d.buyer?.name || "No client yet"}`}
    sub={[TYPE_LABEL[d.docType], formatDate(d.issueDate), d.reference?.project, late ? `due ${formatDate(d.dueDate)}` : null].filter(Boolean).join(" · ")}
    amount={rupees(open && (d.paid || d.credited) ? d.total - d.paid - d.credited : d.total)}
    end={<Badge tone={late ? "danger" : STATUS_TONE[d.status]}>{late ? "Overdue" : STATUS_LABEL[d.status]}</Badge>} />;
}

/** UX-BILLING (5 Nov 2026): what a document waits for, in words and in its stripe's colour. */
export function docState(d: Doc, today: string, free = false): { label: string; tone: Tone } {
  // The words live in lib/billing-words.mjs (unit-tested); a state they leave to the screen takes its status label.
  const words = docStateWords(d, today, free);
  if (words) return words;
  return { label: STATUS_LABEL[d.status] ?? d.status, tone: STATUS_TONE[d.status] === "danger" ? "danger" : STATUS_TONE[d.status] === "success" ? "success" : "neutral" };
}

const DEAL_TONE: Record<DealStatus, Tone> = { draft: "neutral", to_send: "accent", sent: "accent", negotiating: "warning", accepted: "success", lost: "danger", cancelled: "neutral",
  invoiced: "accent", part_paid: "warning", paid: "success" };

/** UX-BILLING: a document as a stripe row: its number (or "Quotation draft"), the client, type and date under it, the
 *  amount (the balance when part-paid) and its state; the stripe is the state's colour. */
export function DocStripe({ d, today, lead, free = false }: { d: Doc; today: string; lead?: ReactNode; free?: boolean }) {
  const open = d.docType === "invoice" && ["issued", "sent", "part_paid"].includes(d.status);
  // KAZUK-FLOW G7: a quotation shows its deal's one status (Sent, Negotiating, Lost, Invoiced, Paid…).
  const st = d.docType === "quotation" && d.dealStatus && d.dealStatus !== "draft" ? { label: DEAL_LABEL[d.dealStatus], tone: DEAL_TONE[d.dealStatus] } : docState(d, today, free);
  const name = docNumber(d) ?? `${TYPE_LABEL[d.docType]} draft`;
  return <StripeRow tone={st.tone} href={`/erp/documents/${d.id}`} lead={lead} label={`${name}, ${d.buyer?.name || "no client yet"}, ${st.label}`}
    title={name} sub={[d.buyer?.name || "No client yet", TYPE_LABEL[d.docType], formatDate(d.issueDate), open && d.dueDate ? `due ${formatDate(d.dueDate)}` : null,
      // KAZUK-FLOW (G1): whose deal it is.
      d.salespersonName ? `by ${d.salespersonName}` : null].filter(Boolean).join(" · ")}
    amount={rupees(open && (d.paid || d.credited) ? d.total - d.paid - d.credited : d.total)}
    badge={<Badge tone={st.tone}>{st.label}</Badge>} />;
}
