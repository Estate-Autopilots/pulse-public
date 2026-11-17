import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import type { DocChoice } from "../new/new-agreement";
import { TemplatesEditor, type TemplatesData } from "./templates-editor";
import css from "../contracts.module.css";

export const dynamic = "force-dynamic";

/** CONTRACTS-2 (owner, 8 Nov 2026): the company's agreement templates. One standard agreement for everyone, and a
 *  version for one client when needed. Import a Word file, a PDF or pasted text; click a blank to add it; see it filled
 *  from a real quotation. Also: what happens after a quotation is accepted, and which clauses clients ask to change. */
export default async function TemplatesPage() {
  const [r, docs] = await Promise.all([api<TemplatesData>("contracts/templates"), api<{ documents: DocChoice[] }>("contracts/documents")]);
  if (!r.data) return <Message text={r.error ?? "Agreement templates are unavailable. Try again in a moment."} />;
  return <Page><div className={css.wrap}>
    <PageHeader title="Agreement templates" back={{ href: "/contracts", label: "Agreements" }} context={["The words every agreement starts from"]} />
    <TemplatesEditor data={r.data} documents={docs.data?.documents ?? []} />
  </div></Page>;
}
