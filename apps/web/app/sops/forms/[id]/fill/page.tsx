import { api } from "../../../../lib/api";
import { Message, Page, PageHeader } from "../../../../ui";
import { FormFill } from "../../../fill";
import { ProjectChoice } from "../../../form-builder";
import type { FillForm } from "../../../types";

/** SOP-WORKFLOW part 3: a live form filled on its own (for a project, or to start the workflows it starts). */
export default async function FillFormPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ project?: string }> }) {
  const { id } = await params; const q = await searchParams;
  const r = await api<{ form: FillForm }>(`forms/${id}/blank`);
  if (r.error) return <Message text={r.error} />;
  const form = r.data!.form;
  return <Page>
    <PageHeader title={form.name} back={{ href: `/sops/forms/${id}`, label: "The form" }} recent={false} context={[form.purpose]} />
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
      <ProjectChoice formId={id} value={q.project ?? null} />
      <FormFill form={form} projectId={q.project ?? null} done={{ href: `/sops/forms/${id}`, label: "Back to the form" }} />
    </div>
  </Page>;
}
