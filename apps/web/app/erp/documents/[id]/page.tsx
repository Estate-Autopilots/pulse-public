import type { BillingSetup } from "../../settings/fields";
import { DOC_LABELS } from "@pulse/invoice-doc";
import { api, getMe } from "../../../lib/api";
import { orgZone } from "../../../lib/brand-server";
import { Empty, Message, Page, PageHeader, styles } from "../../../ui";
import { redirect } from "next/navigation";
import { FileText } from "lucide-react";
import { ErpNav } from "../../nav";
import type { DocumentData } from "../../types";
import { DocumentEditor } from "./editor";
import { IssuedDocument } from "./issued";
import { ServiceQuoteAttribution } from "../../service-quote";
import { QuoteToProject } from "../../../projects/quote-client";
import { QuoteChain, type QuoteChainData } from "../../../contracts/quote-chain";
import { chainStep } from "../../../lib/agreements.mjs";

export default async function ErpDocument({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ was?: string; chat?: string }> }) {
  const { id } = await params;
  const query = (await searchParams) ?? {};
  const [r, setup, me] = await Promise.all([api<DocumentData>(`erp/documents/${encodeURIComponent(id)}`), api<BillingSetup>("erp/setup"), getMe()]);
  if (!setup.data && setup.status !== 404) return <Message text={setup.error ?? "Billing setup is unavailable"} />;
  // REPLAY-FIXES #4 (REPLAY-INSIGHTS: "not found" / "This view is unavailable" from a quotation in Chats): a link to a
  // document that is gone leads to its newest version when there is one (a revision, or the chat's redrafted quotation),
  // and otherwise says what happened, with the way to the quotations; never a bare "not found".
  if (!r.data && r.status === 404) {
    const chat = typeof query.chat === "string" && /^[0-9a-f-]{36}$/i.test(query.chat) ? `?chat=${query.chat}` : "";
    const l = (await api<{ id: string | null; state: "here" | "replaced" | "deleted" | "unavailable" }>(`erp/documents/${encodeURIComponent(id)}/latest${chat}`)).data;
    if (l?.state === "replaced" && l.id && l.id !== id) redirect(`/erp/documents/${l.id}?was=${encodeURIComponent(id)}`);
    return <Page><section className={`${styles.panel} ${styles.message}`}><Empty icon={FileText} first heading
      title={l?.state === "deleted" ? "This draft was deleted" : "This document is not open to you"}
      text={l?.state === "deleted" ? "Someone deleted this draft and nothing replaced it. Your quotations, proformas and invoices are in Billing → Documents." : "It may belong to someone else's sales, or the link is wrong. Ask the person who sent it, or someone in Billing, to share it."}
      action={{ href: "/erp/documents?view=quotation", label: "Open quotations" }} /></section></Page>;
  }
  if (!r.data) return <Message text={r.error ?? "This document is unavailable"} />;
  const d = r.data.document, label = DOC_LABELS[d.docType];
  const draft = d.status === "draft";
  // KAZUK: an accepted quotation starts its project (Kazuk's "Quote signed → the project builds itself").
  // AGREEMENTS round 3: quotation → agreement → invoice, for who makes agreements (or once one exists).
  // A quotation counts once issued; the invoice it became shows the chain from its draft on ("check it below").
  // VITALS-SWEEP (speed): the two reads go out together (one waited for the other before).
  const [linked, chain] = await Promise.all([
    d.docType === "quotation" && d.status === "accepted" ? api<{ projectId: string | null; title: string | null }>(`projects/from-quote/${encodeURIComponent(id)}`).then((x) => x.data ?? null) : null,
    ["quotation", "proforma", "invoice"].includes(d.docType) && !["cancelled", "declined"].includes(d.status) && (d.status !== "draft" || d.docType === "invoice")
      ? api<QuoteChainData>(`agreements/chain?documentId=${encodeURIComponent(id)}`).then((x) => x.data ?? null) : null,
  ]);
  // Billing's own path (a quotation invoiced with no agreement) shows no card: the chain is only where an agreement is, or can still be.
  // QUOTE-FIXES (Mac test 21 Nov: after a proforma the only next step was "Make the agreement" → "Add an agreement template
  // first"): with no agreement template the card offers nothing, so it is not shown and the document's own step leads.
  const showChain = !!chain?.quote && (!!chain.agreement || (chain.can.make && chain.can.template !== false && !chain.invoice));
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
    {query.was && query.was !== id ? <p className={styles.muted} role="note" data-doc-moved="">The link you opened was for an older version. This is the newest.</p> : null}
    <ServiceQuoteAttribution document={d} />
    {showChain && chain ? <QuoteChain chain={chain} page={chainPage} /> : null}
    {draft && r.data.canWrite ? <DocumentEditor key={d.updatedAt} data={r.data} setup={setup.data} canApproveOwnerQuote={me.data?.role === "leadership"} /> : <IssuedDocument data={r.data} zone={await orgZone()} quietMain={cardLeads} />}
  </Page>;
}
