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
import { QuoteChain, type QuoteChainData } from "../../../contracts/quote-chain";
import { chainStep } from "../../../lib/agreements.mjs";

export default async function ErpDocument({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [r, setup, me] = await Promise.all([api<DocumentData>(`erp/documents/${encodeURIComponent(id)}`), api<BillingSetup>("erp/setup"), getMe()]);
  if (!setup.data && setup.status !== 404) return <Message text={setup.error ?? "Billing setup is unavailable"} />;
  if (!r.data) return <Message text={r.error ?? "This document is unavailable"} />;
  const d = r.data.document, label = DOC_LABELS[d.docType];
  const draft = d.status === "draft";
  // KAZUK: an accepted quotation starts its project (Kazuk's "Quote signed → the project builds itself").
  const linked = d.docType === "quotation" && d.status === "accepted" ? (await api<{ projectId: string | null; title: string | null }>(`projects/from-quote/${encodeURIComponent(id)}`)).data ?? null : null;
  // AGREEMENTS round 3: quotation → agreement → invoice, for who makes agreements (or once one exists).
  // A quotation counts once issued; the invoice it became shows the chain from its draft on ("check it below").
  const chain = ["quotation", "proforma", "invoice"].includes(d.docType) && !["cancelled", "declined"].includes(d.status) && (d.status !== "draft" || d.docType === "invoice")
    ? (await api<QuoteChainData>(`agreements/chain?documentId=${encodeURIComponent(id)}`)).data ?? null : null;
  // Billing's own path (a quotation invoiced with no agreement) shows no card: the chain is only where an agreement is, or can still be.
  const showChain = !!chain?.quote && (!!chain.agreement || (chain.can.make && !chain.invoice));
  // LAND-CAPTAIN-11 (the judge: "two main buttons"): when the card offers the next step, it is the page's one main
  // button, and the document's own next step (e.g. Make tax invoice) stays beside it as an ordinary button.
  const chainPage = d.docType === "invoice" ? "invoice" : "quote";
  const step = showChain && chain ? chainStep(chain, chainPage) : null;
  const cardLeads = !!(step?.action && !step.quiet);
  return <Page>
    <PageHeader title={draft ? d.number ? `${label.title} ${d.number}` : `New ${label.noun}` : `${label.title} ${d.number}`} back={{ href: "/erp/documents", label: "Documents" }} recent={{ title: d.number ?? `${label.title} draft` }}
      context={[d.buyer?.name || "No client yet", d.reference?.project ?? "", draft ? d.number ? `Revision ${d.revision ?? 1}: keeps its number` : `Draft: numbered when ${r.data.approvalMode === "none" ? "sent" : "approved"}` : (d.revision ?? 0) > 0 ? `Revision ${d.revision}` : ""]}
      // BILLING (owner, 4 Nov 2026): the project starts when the invoice is paid, so an accepted quotation only links to a
      // project that already exists (one started by hand before this change); its next step is the tax invoice.
      actions={linked?.projectId ? <QuoteToProject documentId={d.id} project={linked} people={r.data.canWrite ? r.data.assignees ?? [] : []} /> : undefined} />
    <ErpNav current="documents" own={r.data.ownOnly} detail />
    <ServiceQuoteAttribution document={d} />
    {showChain && chain ? <QuoteChain chain={chain} page={chainPage} /> : null}
    {draft && r.data.canWrite ? <DocumentEditor key={d.updatedAt} data={r.data} setup={setup.data} canApproveOwnerQuote={me.data?.role === "leadership"} /> : <IssuedDocument data={r.data} zone={await orgZone()} quietMain={cardLeads} />}
  </Page>;
}
