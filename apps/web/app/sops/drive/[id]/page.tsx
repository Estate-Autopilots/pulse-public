import { api } from "../../../lib/api";
import { Message, Page, PageHeader } from "../../../ui";
import { DriveReview } from "../../drive-review";
import type { Holder, Source } from "../../types";

/** SOP-WORKFLOW: one Drive document read into SOPs, drawn, beside the text it came from; bring it in or edit it first. */
export default async function DriveSource({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<{ source: Source; people: Record<string, Holder[]> }>(`sops/drive/${id}`);
  if (r.error) return <Message text={r.error} />;
  const s = r.data!.source;
  return <Page>
    <PageHeader title={s.name} back={{ href: "/sops/drive", label: "From Drive" }} context={[s.parts.length === 1 ? "Reads as one SOP" : `Reads as ${s.parts.length} SOPs`, s.status === "imported" ? "Brought in" : s.status === "dismissed" ? "Not an SOP" : "Waiting"]} recent={false} />
    <DriveReview source={s} people={r.data!.people} />
  </Page>;
}
