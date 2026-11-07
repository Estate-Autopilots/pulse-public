import { api } from "../../lib/api";
import { Message, Page } from "../../ui";
import { DocView, type DocDetail } from "../doc-view";

export const dynamic = "force-dynamic";

/** DOCS-WORKBENCH: one doc: the editor (saved as it is typed), sharing, comments, history and export. */
export default async function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<DocDetail>(`docs/${encodeURIComponent(id)}`);
  if (!r.data) return <Message text={r.error ?? "This doc is unavailable."} />;
  return <Page><DocView key={r.data.doc.id} initial={r.data} /></Page>;
}
