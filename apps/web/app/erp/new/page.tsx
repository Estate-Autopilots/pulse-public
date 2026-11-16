import type { DocType } from "@pulse/invoice-doc";
import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import { ErpNav } from "../nav";
import type { Overview } from "../types";
import { NewDocument } from "./new";

const TYPES: DocType[] = ["invoice", "proforma", "quotation", "credit_note"];

export default async function NewErpDocument({ searchParams }: { searchParams: Promise<{ project?: string; type?: string }> }) {
  const q = await searchParams;
  const r = await api<Overview>("erp");
  if (!r.data) return <Message text={r.error ?? "Billing is unavailable"} />;
  if (!r.data.canWrite) return <Message text="Creating documents is for leadership and the Finance role." />;
  const project = q.project && /^[0-9a-f-]{36}$/.test(q.project) ? q.project : null;
  // KAZUK-FLOW (G1, Kazuk: "no blank-invoice path for sales"): a salesperson starts quotations; the tax invoice is made
  // from their accepted quotation (the database refuses any other, 1670).
  const own = !!r.data.ownOnly;
  if (own && ((q.type && q.type !== "quotation") || project)) return <Message notice="A salesperson starts a quotation here. The tax invoice is made from the accepted quotation: open it and choose Create invoice." />;
  return <Page>
    <PageHeader title="New document" back={{ href: "/erp", label: "Billing" }} context={["Start blank, or pick the client from Clients and Contacts: their details fill in"]} />
    <ErpNav current="documents" inventory={r.data.settings.inventoryEnabled} own={own} />
    <NewDocument initialProject={project} initialType={TYPES.includes(q.type as DocType) ? q.type as DocType : project ? "invoice" : "quotation"} assignees={r.data.assignees}
      quotationsOnly={own} approvalMode={r.data.approvalMode} />
  </Page>;
}
