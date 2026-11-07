import Link from "next/link";
import { FilePlus2, Plus } from "lucide-react";
import { api } from "../../lib/api";
import { Message, Page, PageHeader, styles } from "../../ui";
import { PRIMARY } from "../../components/calm";
import { ErpNav } from "../nav";
import type { ApprovalMode, Doc } from "../types";
import { DocumentsTable } from "./table";

export const metadata = { title: "Documents · Billing" };

// UX-BILLING (5 Nov 2026): the one main action is the one most people come for, a new quotation; an invoice, proforma or
// credit note starts from the quiet button beside it.
export default async function Documents({ searchParams }: { searchParams: Promise<{ view?: string; q?: string }> }) {
  const q = await searchParams;
  const r = await api<{ documents: Doc[]; today: string; canWrite: boolean; ownOnly?: boolean; approvalMode?: ApprovalMode }>("erp/documents");
  if (!r.data) return <Message text={r.error ?? "Documents are unavailable"} />;
  const n = r.data.documents.length;
  return <Page>
    <PageHeader title="Documents" context={["Quotations, proformas and invoices", `${n} document${n === 1 ? "" : "s"}`]}
      actions={r.data.canWrite ? <>
        {/* KAZUK-FLOW (G1): a salesperson starts quotations only; their invoice is made from the accepted quotation. */}
        {r.data.ownOnly ? null : <Link className={`${styles.btn} ${styles.btnGhost}`} href="/erp/new"><FilePlus2 size={14} aria-hidden="true" />Other document</Link>}
        <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/erp/new?type=quotation" {...PRIMARY}><Plus size={14} aria-hidden="true" />New quotation</Link>
      </> : undefined} />
    <ErpNav current="documents" own={r.data.ownOnly} />
    <DocumentsTable docs={r.data.documents} today={r.data.today} view={q.view} q={q.q} canWrite={r.data.canWrite} approvalMode={r.data.approvalMode} />
  </Page>;
}
