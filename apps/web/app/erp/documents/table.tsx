"use client";

// Billing redesign (18 Oct 2026): every document, one line each (number or "Quotation draft", the client, type and date,
// the amount and its state); a row opens the document. Search finds a number, client or project; the view and the search
// stay in the address, so a link opens the same view. A CSV of what is shown.
// UX-BILLING (owner, 5 Nov 2026: Work → My day is the standard): four quiet figures on top (to collect, overdue, waiting
// for approval, quotations open), My day's chips with their counts instead of a segmented bar that was cut off on a
// phone, each document a row with a stripe in its state's colour and its state in words ("With Neha", "Awaiting
// payment"), and an empty view that says what to do with a button that does it.
import Link from "next/link";
import { useMemo, useState } from "react";
import { Download, FileMinus2, FileText, Plus, ReceiptText, ScrollText, SearchX } from "lucide-react";
import { formatAmount } from "@pulse/invoice-doc/gst";
import { styles } from "../../ui";
import { Card, EmptyState, StatTile, StatTiles, StripeList } from "../../components/calm";
import { ChipFilter } from "../../components/chip-filter";
import { saveFile } from "../../lib/save-file";
import { STATUS_LABEL, TYPE_LABEL } from "../nav";
import { DocStripe, rupees } from "../parts";
import type { ApprovalMode, Doc } from "../types";
import { docNumber } from "./chain";
import { score } from "../../lib/forgiving-search.mjs";
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
const VIEW_LABELS: Record<View, string> = { all: "All", quotation: "Quotations", proforma: "Proformas", invoice: "Invoices", approve: "Drafts to approve", overdue: "Overdue" };
const ICON = { quotation: ScrollText, proforma: FileText, invoice: ReceiptText, credit_note: FileMinus2 } as const;
/** Older links (the overview's tiles): ?view=drafts and ?view=open. */
const fromLink = (v?: string): { view: View; unpaid: boolean } => v === "drafts" ? { view: "approve", unpaid: false } : v === "open" ? { view: "invoice", unpaid: true }
  : v && v in KEEP ? { view: v as View, unpaid: false } : { view: "all", unpaid: false };
const PAGE = 60;

export function DocumentsTable({ docs, today, view: initialView, q: initialQ, canWrite, approvalMode = "approver" }: { docs: Doc[]; today: string; view?: string; q?: string; canWrite: boolean; approvalMode?: ApprovalMode }) {
  // KAZUK-FLOW (G2): with no approval, drafts are drafts (nobody approves them).
  const LABELS = approvalMode === "none" ? { ...VIEW_LABELS, approve: "Drafts" } : VIEW_LABELS;
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
  const money = useMemo(() => {
    const open = docs.filter(isOpen), overdue = open.filter((d) => late(d, today));
    const due = (list: Doc[]) => list.reduce((n, d) => n + Math.max(0, d.total - d.paid - d.credited), 0);
    return { open: due(open), openCount: open.length, overdue: due(overdue), overdueCount: overdue.length,
      quotes: docs.filter((d) => d.docType === "quotation" && ["issued", "sent"].includes(d.status)).length };
  }, [docs, today]);
  // BILLING-WL (4 Nov 2026): the same forgiving match as the catalogue (case, spaces and punctuation never matter).
  const list = docs.filter((d) => KEEP[view](d, today) && (!unpaid || isOpen(d)) && (!q.trim() || score(q, [docNumber(d), d.buyer?.name, d.buyer?.contactName, d.buyer?.phone,
    d.reference?.project, d.project, TYPE_LABEL[d.docType], STATUS_LABEL[d.status], d.salespersonName]) > 0));
  function csv() {
    const cell = (v: unknown) => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const rows = [["Number", "Type", "Client", "Project", "Date", "Due or valid until", "Total", "Balance", "Status"],
      ...list.map((d) => [docNumber(d) ?? "Draft", TYPE_LABEL[d.docType], d.buyer?.name ?? "", d.reference?.project ?? "", d.issueDate, d.dueDate ?? d.validUntil ?? "", formatAmount(d.total),
        isOpen(d) ? formatAmount(d.total - d.paid - d.credited) : "", late(d, today) ? "Overdue" : STATUS_LABEL[d.status]])];
    void saveFile(new Blob([`﻿${rows.map((r) => r.map(cell).join(",")).join("\n")}`], { type: "text/csv;charset=utf-8" }), `pulse-billing-documents-${today}.csv`);
  }
  const reset = () => { setView("all"); setUnpaid(false); setQ(""); setShown(PAGE); remember("all", ""); };

  return <div className={css.listWrap}>
    <StatTiles label="Documents at a glance">
      <StatTile label="To collect" value={rupees(money.open)} sub={`${money.openCount} invoice${money.openCount === 1 ? "" : "s"} open`} />
      <StatTile label="Overdue" value={rupees(money.overdue)} sub={money.overdueCount ? `${money.overdueCount} to chase` : "none"} tone={money.overdue ? "bad" : undefined} />
      <StatTile label={LABELS.approve} value={counts.approve} tone={counts.approve ? "warn" : undefined} />
      <StatTile label="With customers" value={money.quotes} />
    </StatTiles>
    <div className={css.listTools}>
      <ChipFilter label="Show" value={view} onChange={choose} chips={(Object.keys(LABELS) as View[]).map((k) => ({ value: k, label: LABELS[k], count: k === "all" ? undefined : counts[k] ?? 0,
        tone: k === "overdue" ? "danger" as const : k === "approve" ? "warning" as const : undefined, dot: k === "overdue" || k === "approve" }))} hideEmpty />
      <label className={css.search}><span className={styles.srOnly}>Search documents</span>
        <input type="search" value={q} onChange={(e) => search(e.target.value)} placeholder="Search number, client, phone or project" /></label>
    </div>
    {unpaid ? <p className={css.listNote}>Showing unpaid invoices. <button type="button" onClick={() => setUnpaid(false)}>Show every invoice</button></p> : null}
    {list.length ? <Card label="Documents" flat>
      <StripeList label="Documents">{list.slice(0, shown).map((d) => {
        const Icon = ICON[d.docType] ?? FileText;
        return <DocStripe key={d.id} d={d} today={today} free={approvalMode === "none"} lead={<span className={css.typeIcon} data-type={d.docType}><Icon size={16} aria-hidden="true" /></span>} />;
      })}</StripeList>
    </Card> : docs.length ? <EmptyState icon={<SearchX size={18} aria-hidden="true" />} title={`Nothing matches${q ? ` “${q}”` : ""}`}
      text={`No ${LABELS[view].toLowerCase()} ${q ? "with those words" : "right now"}. Check the spelling, or look through every document.`}
      action={<button type="button" className={styles.btn} onClick={reset}>Show every document</button>} />
      : <EmptyState icon={<ScrollText size={18} aria-hidden="true" />} title="No documents yet"
        text={`Start with a quotation: type the customer's name or phone and Pulse finds them. Once it is ${approvalMode === "none" ? "accepted" : "approved"}, it becomes a tax invoice in one tap.`}
        action={canWrite ? <Link className={styles.btn} href="/erp/new?type=quotation"><Plus size={14} aria-hidden="true" />New quotation</Link> : undefined} />}
    <div className={css.listFoot}>
      <span>{list.length > shown ? `${shown} of ${list.length} shown` : `${list.length} document${list.length === 1 ? "" : "s"}`}</span>
      <span className={styles.inline}>
        {list.length > shown ? <button type="button" className={styles.btn} onClick={() => setShown(shown + PAGE)}>Show more</button> : null}
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={csv} disabled={!list.length}><Download size={14} aria-hidden="true" />CSV</button>
      </span>
    </div>
  </div>;
}
