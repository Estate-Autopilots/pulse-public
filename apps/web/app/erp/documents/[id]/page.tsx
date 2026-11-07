import type { BillingSetup } from "../../settings/fields";
import { DOC_LABELS } from "@pulse/invoice-doc";
import { api, getMe } from "../../../lib/api";
import { orgZone } from "../../../lib/brand-server";
import { Message, Page, PageHeader } from "../../../ui";
import { ErpNav } from "../../nav";
import type { DocumentData } from "../../types";
import { DocumentEditor } from "./editor";
import { IssuedDocument } from "./issued";
import { ServiceQuoteAttribution } from "../../service-quote";
import { QuoteToProject } from "../../../projects/quote-client";

export default async function ErpDocument({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [r, setup, me] = await Promise.all([api<DocumentData>(`erp/documents/${encodeURIComponent(id)}`), api<BillingSetup>("erp/setup"), getMe()]);
  if (!setup.data && setup.status !== 404) return <Message text={setup.error ?? "Billing setup is unavailable"} />;
  if (!r.data) return <Message text={r.error ?? "This document is unavailable"} />;
  const d = r.data.document, label = DOC_LABELS[d.docType];
  const draft = d.status === "draft";
  // KAZUK: an accepted quotation starts its project (Kazuk's "Quote signed → the project builds itself").
  const linked = d.docType === "quotation" && d.status === "accepted" ? (await api<{ projectId: string | null; title: string | null }>(`projects/from-quote/${encodeURIComponent(id)}`)).data ?? null : null;
  return <Page>
    <PageHeader title={draft ? d.number ? `${label.title} ${d.number}` : `New ${label.noun}` : `${label.title} ${d.number}`} back={{ href: "/erp/documents", label: "Documents" }} recent={{ title: d.number ?? `${label.title} draft` }}
      context={[d.buyer?.name || "No client yet", d.reference?.project ?? "", draft ? d.number ? `Revision ${d.revision ?? 1}: keeps its number` : `Draft: numbered when ${r.data.approvalMode === "none" ? "sent" : "approved"}` : (d.revision ?? 0) > 0 ? `Revision ${d.revision}` : ""]}
      // BILLING (owner, 4 Nov 2026): the project starts when the invoice is paid, so an accepted quotation only links to a
      // project that already exists (one started by hand before this change); its next step is the tax invoice.
      actions={linked?.projectId ? <QuoteToProject documentId={d.id} project={linked} people={r.data.canWrite ? r.data.assignees ?? [] : []} /> : undefined} />
    <ErpNav current="documents" own={r.data.ownOnly} />
    <ServiceQuoteAttribution document={d} />
    {draft && r.data.canWrite ? <DocumentEditor key={d.updatedAt} data={r.data} setup={setup.data} canApproveOwnerQuote={me.data?.role === "leadership"} /> : <IssuedDocument data={r.data} zone={await orgZone()} />}
  </Page>;
}
