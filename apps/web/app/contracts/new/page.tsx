import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import type { ContractsData } from "../parts";
import { NewAgreement, type DocChoice, type TemplateChoice } from "./new-agreement";
import css from "../contracts.module.css";

export const dynamic = "force-dynamic";

/** CONTRACTS-2 (owner, 8 Nov 2026): a new agreement, on its own page (it used to squeeze into the header's menu).
 *  Start from a quotation or invoice: the agreement fills itself from it and the company's template. */
export default async function NewAgreementPage() {
  const [docs, tpl, choices] = await Promise.all([
    api<{ documents: DocChoice[] }>("contracts/documents"),
    api<{ templates: TemplateChoice[]; canEdit: boolean }>("contracts/templates"),
    api<ContractsData>("contracts"),
  ]);
  if (!choices.data) return <Message text={choices.error ?? "Agreements are unavailable. Try again in a moment."} />;
  if (!choices.data.canMake) return <Message text="Admins, leadership, Finance and Sales make agreements. Ask one of them to send this one." />;
  return <Page><div className={css.wrap}>
    <PageHeader title="New agreement" back={{ href: "/contracts", label: "Agreements" }} context={["From a quotation or invoice, or a blank one"]} />
    <NewAgreement documents={docs.data?.documents ?? []} templates={tpl.data?.templates ?? []} canManage={choices.data.canManage} choices={choices.data} docsError={docs.data ? null : docs.error ?? "Could not load your quotations and invoices."} />
  </div></Page>;
}
