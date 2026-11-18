import { api } from "../../../lib/api";
import { day } from "../../../lib/format";
import { Badge, Message, Page, PageHeader } from "../../../ui";
import { WorkflowBuilder } from "../../builder";
import { RunList } from "../../run-list";
import { WorkflowRead } from "../../workflow-read";
import type { FormList, WorkflowDetail } from "../../types";
import css from "../../sops.module.css";

const WORD = { draft: "Draft", live: "Live", paused: "Paused", archived: "Archived" } as const;
const TONE = { draft: "neutral", live: "success", paused: "warning", archived: "neutral" } as const;

/** SOP-WORKFLOW part 2: one workflow. Leadership designs it here with Pip beside the flow; everyone else reads it and,
 *  when their role allows, starts a run. Its runs are listed under it. */
export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [r, roles, forms] = await Promise.all([api<WorkflowDetail>(`workflows/${id}`), api<{ roles: { role: string }[] }>("sops/roles"), api<FormList>("forms")]);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!, w = d.workflow;
  const running = d.runs.filter((x) => x.status === "running").length;
  return <Page>
    <PageHeader title={w.name} back={{ href: "/processes", label: "Processes" }} recent={{ title: w.name }}
      context={[w.triggerText, `${w.definition.steps.length} steps`, w.publishedAt ? `version ${w.version} · ${day(w.publishedAt)}` : "not published yet", running ? `${running} running` : null]}
      meta={<Badge tone={TONE[w.status]}>{WORD[w.status]}</Badge>} />
    {d.canEdit ? <WorkflowBuilder data={d} roles={roles.data?.roles.map((x) => x.role) ?? []} forms={(forms.data?.forms ?? []).filter((f) => f.status === "live").map((f) => ({ id: f.id, name: f.name, fields: f.fields }))} /> : <WorkflowRead data={d} />}
    <section className={css.box} aria-label="Runs" style={{ marginTop: 14 }}>
      <p className={css.sub}>Runs</p>
      <RunList runs={d.runs} showWorkflow={false} empty={w.status === "live" ? "No runs yet. Start one on a project." : "Runs start once the workflow is published."} />
    </section>
  </Page>;
}
