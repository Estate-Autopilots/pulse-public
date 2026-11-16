import { api } from "../lib/api";
import { Message, Page } from "../ui";
import { Workbench, type DocsData } from "./workbench";

export const dynamic = "force-dynamic";

/** DOCS-WORKBENCH (owner, 6 Nov 2026): the company's docs and files in folders, searchable, with templates and imports
 *  (services/api/src/docs.ts; who sees which doc is the database's rule).
 *  DOCS-DRIVE (owner, 8 Nov 2026): a file manager like Drive. My Docs is the top of the folder tree (docs in no folder);
 *  ?folder= opens a folder; ?view=shared|recent|starred and ?archived=1 are the places on the left; a search (?q=, ?tag=)
 *  takes the filters ?category= (type), ?owner=, ?from=, ?to= and ?folder= (anywhere under it). */
export default async function DocsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const view = q.view === "shared" || q.view === "recent" || q.view === "starred" ? q.view : null;
  const params = new URLSearchParams();
  for (const k of ["folder", "q", "archived", "mine", "tag", "category", "owner", "from", "to"]) if (q[k]) params.set(k, q[k]);
  if (view) params.set("view", view);
  const filtered = ["q", "tag", "category", "owner", "from", "to"].some((k) => q[k]);
  // My Docs: the folders at the top and the docs in no folder (Recent lists everything by time).
  if (!q.folder && !filtered && !view && !q.archived && !q.mine) params.set("folder", "root");
  const [r, receipts] = await Promise.all([api<DocsData>(`docs?${params.toString()}`), api<{ docReads: boolean; canChange: boolean }>("docs/settings")]);
  if (!r.data) return <Message text={r.error ?? "Docs are unavailable."} />;
  return <Page>
    <Workbench data={r.data} receipts={receipts.data?.canChange ? receipts.data : null} folder={q.folder ?? null} query={q.q ?? ""} archived={q.archived === "1"} mine={q.mine === "1"} tag={q.tag ?? null} view={view}
      filters={{ type: q.category ?? null, owner: q.owner ?? null, from: q.from ?? null, to: q.to ?? null }} />
  </Page>;
}
