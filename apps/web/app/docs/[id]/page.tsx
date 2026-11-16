import { api, missingProps, getMe, openElsewhere } from "../../lib/api";
import { organizationDisplayName } from "../../lib/branding-name";
import { Message, Page } from "../../ui";
import { RecordMissing } from "../../orgs/record-missing";
import { OpenedNote } from "../../orgs/tab-company";
import { DocView, type DocDetail } from "../doc-view";

export const dynamic = "force-dynamic";

/** DOCS-WORKBENCH: one doc: the editor (saved as it is typed), sharing, comments, history and export. */
// DOCS-INTERACTIVE: ?reads=1 (the sender's notification) opens who read it; ?send=1 the send panel; ?links=1 the linked work.
export default async function DocPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const q = await searchParams;
  const r = await api<DocDetail>(`docs/${encodeURIComponent(id)}`);
  if (!r.data) await openElsewhere(r, "doc", id, `/docs/${id}`);
  // ORG-PER-TAB: a doc that does not open here (and is in none of my other companies) says why and what to do.
  if (!r.data && r.status === 404) return <RecordMissing kind="doc" {...await missingProps()} />;
  if (!r.data) return <Message text={r.error ?? "This doc is unavailable."} />;
  // DOCS-DRIVE: the Docs page's details panel opens a doc on its sharing (?share=1), history (?history=1) or comments (?comments=1).
  const open = q.reads ? "reads" : q.send ? "send" : q.links ? "links" : q.share ? "share" : q.history ? "history" : q.comments ? "comments" : null;
  // DOCS-POLISH: the cover's line names the company (the shell's own sign-in read; cached for this request).
  const company = organizationDisplayName((await getMe()).data?.orgName);
  return <Page><OpenedNote /><DocView key={r.data.doc.id} initial={r.data} open={open} company={company} /></Page>;
}
