import { api } from "../../../lib/api";
import { Message, Page, PageHeader } from "../../../ui";
import { SopEditor } from "../../editor";
import type { Holder, SopDetail } from "../../types";

/** SOP-WORKFLOW: change an SOP's steps (leadership and admins). Saving keeps a version. */
export default async function EditSop({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [r, roles] = await Promise.all([api<SopDetail>(`sops/${id}`), api<{ roles: { role: string }[]; holders: Record<string, Holder[]> }>("sops/roles")]);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!;
  if (!d.canEdit) return <Message text="Leadership and admins change SOPs." />;
  return <Page>
    <PageHeader title={`Edit: ${d.sop.title}`} back={{ href: `/sops/${id}`, label: d.sop.title }} context={[`Version ${d.sop.version}`]} recent={false} />
    <SopEditor mode={{ kind: "edit", id }} roles={roles.data?.roles.map((x) => x.role) ?? []} holders={{ ...(roles.data?.holders ?? {}), ...d.people }}
      initial={{ title: d.sop.title, purpose: d.sop.purpose, ownerRole: d.sop.ownerRole, doc: d.sop.doc, confidence: d.sop.confidence }} />
  </Page>;
}
