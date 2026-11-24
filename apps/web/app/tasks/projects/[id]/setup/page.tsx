import { redirect } from "next/navigation";
import { api } from "../../../../lib/api";
import { Message, Page, PageHeader } from "../../../../ui";
import { SetupWizard, type WizardTemplate } from "./wizard";

/** PM-BUILD-3 (the Mac's screens 07 and 08, SPEC v1.1 §5.8): set up a project in four steps: the template (with the
 *  package sold), the dates (the invoice paid; Day 0 and going live follow from the template, shown as a live preview of
 *  the phases), the people (the lead and each role), then a preview and Create. The plan is laid out by the same
 *  functions as before (pulse.project_plan_set, pulse.project_plan_roles_set). */
export const dynamic = "force-dynamic";
type Pm = { plan: boolean; project: { id: string; title: string; client: string | null; leadId: string | null; lead: string | null; canRun: boolean } };

export default async function Setup({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [p, t, o] = await Promise.all([api<Pm>(`projects/${encodeURIComponent(id)}/pm`), api<{ templates: WizardTemplate[] }>("projects/templates?full=1"), api<{ people: { id: string; name: string }[] }>("tasks/options")]);
  if (p.error || !p.data) return <Message text={p.error ?? "This project is unavailable."} />;
  if (p.data.plan) redirect(`/tasks/projects/${id}`);
  if (!p.data.project.canRun) return <Message text="Only the project's lead, its manager and leadership set up its plan." />;
  const templates = t.data?.templates ?? [];
  if (!templates.length) return <Message text="Your company has no project template yet." />;
  return <Page>
    <PageHeader title={`Set up ${p.data.project.title}`} back={{ href: `/tasks/projects/${id}`, label: p.data.project.title }} context={[p.data.project.client]} />
    <SetupWizard projectId={id} templates={templates} people={(o.data?.people ?? []).map((x) => ({ id: x.id, name: x.name }))} leadId={p.data.project.leadId} />
  </Page>;
}
