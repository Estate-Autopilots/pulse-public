import { api } from "../../../lib/api";
import { dayTime } from "../../../lib/format";
import { Message, Page, PageHeader } from "../../../ui";
import { FormFill } from "../../fill";
import type { FillStep } from "../../types";
import f from "../../forms.module.css";

/** SOP-WORKFLOW part 3: a workflow step's form, on the phone. Sending it finishes the step. */
export default async function FillStepPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<FillStep>(`forms/fill/${id}`);
  if (r.error) return <Message text={r.error} />;
  const { step, form } = r.data!;
  return <Page>
    <PageHeader title={form.name} back={step.taskId ? { href: `/tasks/${step.taskId}`, label: "The task" } : { href: "/sops/forms", label: "Forms" }} recent={false}
      context={[step.project ?? step.run, step.dueAt ? `due ${dayTime(step.dueAt)}` : null]} />
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className={f.stepHead}><b>{step.title}</b><small>{step.workflow} · {step.project ?? step.run}{step.client ? ` · ${step.client}` : ""}</small>{form.purpose ? <small>{form.purpose}</small> : null}</div>
      {step.status !== "active" ? <Message notice={step.sentAt ? `This form was sent ${dayTime(step.sentAt)}; the step is done.` : "This step is not waiting for its form."} />
        : !step.canFill ? <Message text="This step is someone else's. Whoever does it fills its form." />
        : <FormFill form={form} stepId={step.id} done={{ href: `/runs/${step.runId}`, label: "See the run" }} />}
    </div>
  </Page>;
}
