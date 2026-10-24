"use client";

// Billing redesign (18 Oct 2026): every document, one line each (number or "Quotation draft", the client, type and date,
// the amount and its state); a row opens the document. A segmented row filters (All · Quotes · Proformas · Invoices ·
// To approve · Overdue) and search finds a number, client or project; both stay in the address, so a link opens the same
// view. 48 px rows on a phone; a CSV of what is shown.
import Link from "next/link";
import { useMemo, useState } from "react";
import { Download, FileMinus2, FileText, Plus, ReceiptText, ScrollText } from "lucide-react";
import { formatAmount, formatDate } from "@pulse/invoice-doc/gst";
import { Badge, styles } from "../../ui";
import { Segmented } from "../../kit/segmented";
import { LineList, LineRow } from "../../kit/line-row";
import { saveFile } from "../../lib/save-file";
import { STATUS_LABEL, STATUS_TONE, TYPE_LABEL } from "../nav";
import type { Doc } from "../types";
import { inr } from "./chain";
import css from "./documents.module.css";

type View = "all" | "quotation" | "proforma" | "invoice" | "approve" | "overdue";
const OPEN = ["issued", "sent", "part_paid"];
const isOpen = (d: Doc) => d.docType === "invoice" && OPEN.includes(d.status);
const late = (d: Doc, today: string) => isOpen(d) && !!d.dueDate && d.dueDate < today;
const toApprove = (d: Doc) => d.status === "draft" || d.ownerApproval === "needed";
const KEEP: Record<View, (d: Doc, today: string) => boolean> = {
  all: () => true, quotation: (d) => d.docType === "quotation", proforma: (d) => d.docType === "proforma", invoice: (d) => d.docType === "invoice" || d.docType === "credit_note",
  approve: toApprove, overdue: late,
};
const LABELS: Record<View, string> = { all: "All", quotation: "Quotes", proforma: "Proformas", invoice: "Invoices", approve: "To approve", overdue: "Overdue" };
const ICON = { quotation: ScrollText, proforma: FileText, invoice: ReceiptText, credit_note: FileMinus2 } as const;
/** Older links (the overview's tiles): ?view=drafts and ?view=open. */
const fromLink = (v?: string): { view: View; unpaid: boolean } => v === "drafts" ? { view: "approve", unpaid: false } : v === "open" ? { view: "invoice", unpaid: true }
  : v && v in KEEP ? { view: v as View, unpaid: false } : { view: "all", unpaid: false };
const PAGE = 60;

export function DocumentsTable({ docs, today, view: initialView, q: initialQ, canWrite }: { docs: Doc[]; today: string; view?: string; q?: string; canWrite: boolean }) {
  const start = fromLink(initialView);
  const [view, setView] = useState<View>(start.view), [unpaid, setUnpaid] = useState(start.unpaid), [q, setQ] = useState(initialQ ?? ""), [shown, setShown] = useState(PAGE);
  const remember = (v: View, text: string) => {
    const u = new URL(window.location.href);
    if (v === "all") u.searchParams.delete("view"); else u.searchParams.set("view", v);
    if (text.trim()) u.searchParams.set("q", text.trim()); else u.searchParams.delete("q");
    window.history.replaceState(window.history.state, "", u);
  };
  const choose = (v: View) => { setView(v); setUnpaid(false); setShown(PAGE); remember(v, q); };
  const search = (text: string) => { setQ(text); setShown(PAGE); remember(view, text); };
  const counts = useMemo(() => Object.fromEntries((Object.keys(KEEP) as View[]).map((k) => [k, docs.filter((d) => KEEP[k](d, today)).length])) as Record<View, number>, [docs, today]);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = docs.filter((d) => KEEP[view](d, today) && (!unpaid || isOpen(d)) && words.every((w) =>
    `${d.number ?? ""} ${d.buyer?.name ?? ""} ${d.reference?.project ?? ""} ${d.project ?? ""} ${TYPE_LABEL[d.docType]} ${STATUS_LABEL[d.status]} ${d.salespersonName ?? ""}`.toLowerCase().includes(w)));
  function csv() {
    const cell = (v: unknown) => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const rows = [["Number", "Type", "Client", "Project", "Date", "Due or valid until", "Total", "Balance", "Status"],
      ...list.map((d) => [d.number ?? "Draft", TYPE_LABEL[d.docType], d.buyer?.name ?? "", d.reference?.project ?? "", d.issueDate, d.dueDate ?? d.validUntil ?? "", formatAmount(d.total),
        isOpen(d) ? formatAmount(d.total - d.paid - d.credited) : "", late(d, today) ? "Overdue" : STATUS_LABEL[d.status]])];
    void saveFile(new Blob([`﻿${rows.map((r) => r.map(cell).join(",")).join("\n")}`], { type: "text/csv;charset=utf-8" }), `pulse-billing-documents-${today}.csv`);
  }

  return <div className={css.listWrap}>
    <div className={css.listTools}>
      <Segmented label="Show" value={view} onChange={choose} options={(Object.keys(LABELS) as View[]).map((k) => ({ value: k, label: LABELS[k], count: k === "all" ? undefined : counts[k] || undefined }))} />
      <label className={css.search}><span className={styles.srOnly}>Search documents</span>
        <input type="search" value={q} onChange={(e) => search(e.target.value)} placeholder="Search number, client or project" /></label>
    </div>
    {unpaid ? <p className={css.listNote}>Showing unpaid invoices. <button type="button" onClick={() => setUnpaid(false)}>Show every invoice</button></p> : null}
    {list.length ? <LineList label="Documents">
      {list.slice(0, shown).map((d) => {
        const Icon = ICON[d.docType] ?? FileText;
        const overdue = late(d, today), open = isOpen(d);
        const balance = d.total - d.paid - d.credited;
        const state = overdue ? <Badge tone="danger">Overdue</Badge> : d.ownerApproval === "needed" ? <Badge tone="warning">Price to approve</Badge>
          : d.status === "draft" ? <Badge tone="warning">To approve</Badge> : <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>;
        return <LineRow key={d.id} href={`/erp/documents/${d.id}`} label={`${d.number ?? `${TYPE_LABEL[d.docType]} draft`}, ${d.buyer?.name || "no client yet"}`}
          lead={<span className={css.typeIcon} data-type={d.docType}><Icon size={16} aria-hidden="true" /></span>}
          title={d.number ?? `${TYPE_LABEL[d.docType]} draft`}
          sub={[d.buyer?.name || "No client yet", TYPE_LABEL[d.docType], formatDate(d.issueDate), open && d.dueDate ? `due ${formatDate(d.dueDate)}` : null].filter(Boolean).join(" · ")}
          amount={inr(open && (d.paid || d.credited) ? balance : d.total)} amountSub={<span className={css.chipStatus}>{state}</span>} />;
      })}
    </LineList> : <div className={css.empty}>
      {docs.length ? <p>Nothing matches{q ? ` "${q}"` : ""} in {LABELS[view].toLowerCase()}.</p> : <p>No documents yet. A quotation, proforma or invoice starts from a client or a project.</p>}
      {!docs.length && canWrite ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/erp/new?type=quotation"><Plus size={14} aria-hidden="true" />New quotation</Link> : null}
    </div>}
    <div className={css.listFoot}>
      <span>{list.length > shown ? `${shown} of ${list.length} shown` : `${list.length} document${list.length === 1 ? "" : "s"}`}</span>
      <span className={styles.inline}>
        {list.length > shown ? <button type="button" className={styles.btn} onClick={() => setShown(shown + PAGE)}>Show more</button> : null}
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={csv} disabled={!list.length}><Download size={14} aria-hidden="true" />CSV</button>
      </span>
    </div>
  </div>;
}
