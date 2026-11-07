import { api } from "../lib/api";
import { Message, Page, PageHeader } from "../ui";
import { Workbench, type DocsData } from "./workbench";

export const dynamic = "force-dynamic";

/** DOCS-WORKBENCH (owner, 6 Nov 2026): the company's docs and files in folders, searchable, with templates and imports
 *  (services/api/src/docs.ts; who sees which doc is the database's rule). */
export default async function DocsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const params = new URLSearchParams();
  for (const k of ["folder", "q", "archived", "mine"]) if (q[k]) params.set(k, q[k]);
  const r = await api<DocsData>(`docs?${params.toString()}`);
  if (!r.data) return <Message text={r.error ?? "Docs are unavailable."} />;
  return <Page>
    <PageHeader title="Docs" context={["Notes, briefs, plans and files, in folders, linked to the work they are about"]} />
    <Workbench data={r.data} folder={q.folder ?? null} query={q.q ?? ""} archived={q.archived === "1"} mine={q.mine === "1"} />
  </Page>;
}
