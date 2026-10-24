import Link from "next/link";
import { Plus } from "lucide-react";
import { api } from "../../lib/api";
import { Message, Page, PageHeader, styles } from "../../ui";
import { ErpNav } from "../nav";
import type { Doc } from "../types";
import { DocumentsTable } from "./table";

export default async function Documents({ searchParams }: { searchParams: Promise<{ view?: string; q?: string }> }) {
  const q = await searchParams;
  const r = await api<{ documents: Doc[]; today: string; canWrite: boolean }>("erp/documents");
  if (!r.data) return <Message text={r.error ?? "Documents are unavailable"} />;
  const n = r.data.documents.length;
  return <Page>
    <PageHeader title="Documents" context={["Quotations, proformas and invoices", `${n} document${n === 1 ? "" : "s"}`]}
      actions={r.data.canWrite ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/erp/new"><Plus size={14} aria-hidden="true" />New document</Link> : undefined} />
    <ErpNav current="documents" />
    <DocumentsTable docs={r.data.documents} today={r.data.today} view={q.view} q={q.q} canWrite={r.data.canWrite} />
  </Page>;
}
