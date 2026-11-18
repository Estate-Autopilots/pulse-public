import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import { SopEditor } from "../editor";
import type { Holder, Source } from "../types";

type Roles = { roles: { role: string; n: number }[]; holders: Record<string, Holder[]> };
/** SOP-WORKFLOW: a new SOP, written step by step or read from pasted text; `?source=<id>&part=<n>` edits a Drive
 *  document's reading before it is brought in. */
export default async function NewSop({ searchParams }: { searchParams: Promise<{ source?: string; part?: string }> }) {
  const q = await searchParams;
  const r = await api<Roles>("sops/roles");
  if (r.error) return <Message text={r.error} />;
  const roles = r.data!.roles.map((x) => x.role);
  if (q.source) {
    const s = await api<{ source: Source; people: Record<string, Holder[]> }>(`sops/drive/${encodeURIComponent(q.source)}`);
    if (s.error) return <Message text={s.error} />;
    const part = s.data!.source.parts[Number(q.part ?? 0)] ?? s.data!.source.parts[0];
    if (!part?.doc) return <Message text="Pulse found no steps in that document." />;
    return <Page>
      <PageHeader title={`Bring in: ${part.title}`} back={{ href: `/sops/drive/${s.data!.source.id}`, label: "From Drive" }} context={[s.data!.source.name]} recent={false} />
      <SopEditor mode={{ kind: "import", sourceId: s.data!.source.id, part: part.index }} roles={roles} holders={{ ...r.data!.holders, ...s.data!.people }} evidence={part.evidence}
        initial={{ title: part.title, purpose: part.purpose, ownerRole: part.ownerRole, doc: part.doc, confidence: part.confidence }} />
    </Page>;
  }
  return <Page>
    <PageHeader title="New SOP" back={{ href: "/processes", label: "Processes" }} recent={false} />
    <SopEditor mode={{ kind: "new" }} roles={roles} holders={r.data!.holders} initial={{ title: "", purpose: null, ownerRole: null, doc: { steps: [], phases: [], roles: [], outputs: [], watch: [] } }} />
  </Page>;
}
