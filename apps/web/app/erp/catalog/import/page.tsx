import { api } from "../../../lib/api";
import { Message, Page, PageHeader } from "../../../ui";
import { ImportPriceList, type PastImport } from "./import";

export const metadata = { title: "Import a price list · Billing" };
export const dynamic = "force-dynamic";

/** GROWTH-LOOP slice 5 (owner, 8 Nov 2026): build the catalogue from a sheet, a file or a pasted table. Leadership and
 *  the Finance role (Billing's full seat); everyone else is told who can. */
export default async function ImportCatalogue() {
  const r = await api<{ imports: PastImport[] }>("erp/catalog/imports");
  if (r.status === 403) return <Message notice="Importing a price list is for leadership and the Finance role. Ask them to add your items." />;
  if (!r.data) return <Message text={r.error ?? "Billing is unavailable"} />;
  return <Page>
    <PageHeader title="Import a price list" context={["Billing", "Catalogue"]} back={{ href: "/erp/catalog", label: "Catalogue" }} />
    <ImportPriceList past={r.data.imports} />
  </Page>;
}
