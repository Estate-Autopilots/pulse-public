import { api, apiV1 } from "../../lib/api";
import { Badge, Message, Page, PageHeader } from "../../ui";
import { OPEN_STATES, STEP_STATE_LABELS, type FlowRecord, type ProcessDetail, type RecordType } from "../../processes/flow-types";
import type { FillForm } from "../../sops/types";
import { StepWork } from "../work";
import { ownsRecord, screenOf, type RecordDetail, type StepDetail } from "../types";

/** FLOW-C: one step's own work screen (a document, a meeting, an asset, a review …), opened from My steps, a run or a
 *  Work task. The work in the middle; the step's checklist, its part of the write-up and Pip beside it. The first time a
 *  step that works on a record is opened by someone who may act on it, its record is made (POST open). */
export default async function StepPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> }) {
  const { id } = await params, from = (await searchParams).from ?? null;
  const path = `/v1/flow/steps/${encodeURIComponent(id)}`;
  const got = await apiV1<StepDetail>(path);
  if (!got.data) return <Message text={got.error ?? "This step did not load."} />;
  let d: StepDetail = got.data;
  if (d.canAct && !d.record && ownsRecord(d.module) && OPEN_STATES.includes(d.step.state) && d.run.status === "running") {
    const opened = await apiV1<StepDetail>(`${path}/open`, { method: "POST" });
    if (opened.data) d = opened.data;
  }
  const screen = screenOf(d.step.module), formId = typeof d.settings.formId === "string" && /^[0-9a-f-]{36}$/i.test(d.settings.formId) ? d.settings.formId : null;
  const [rec, runRecords, types, form, proc] = await Promise.all([
    d.record ? apiV1<RecordDetail>(`/v1/flow/records/${d.record.id}`) : null,
    apiV1<{ records: FlowRecord[] }>(`/v1/flow/records?runId=${encodeURIComponent(d.run.id)}`),
    apiV1<{ recordTypes: RecordType[] }>("/v1/flow/record-types"),
    screen === "collect" && formId && d.canAct ? api<{ form: FillForm }>(`forms/${formId}/blank`) : null,
    screen === "assign" && d.canAct ? apiV1<ProcessDetail>(`/v1/flow/processes/${encodeURIComponent(d.run.processId)}`) : null,
  ]);
  const s = d.step, stage = d.run.stages.find((g) => g.key === s.stage)?.label ?? null;
  const back = from === "me" ? { href: `/me/steps?step=${encodeURIComponent(s.id)}`, label: "My steps" } : from?.startsWith("task:") ? { href: `/tasks/${encodeURIComponent(from.slice(5))}`, label: "The task" }
    : { href: `/runs/${d.run.id}?step=${encodeURIComponent(s.id)}`, label: d.run.name };
  const tone = s.state === "done" || s.state === "confirmed" ? "success" : s.state === "waiting" ? "warning" : s.state === "skipped" ? "neutral" : "accent";
  return <Page>
    <PageHeader title={s.title} back={back} recent={{ title: s.title }}
      context={[back.label === d.run.name ? null : d.run.name, d.run.process, stage, d.module?.name ?? s.moduleName, d.run.mode === "demo" ? "A demo run: nobody is told" : null]}
      meta={<Badge tone={tone}>{s.state === "waiting" ? "Waiting for data" : STEP_STATE_LABELS[s.state]}</Badge>} />
    <StepWork key={d.step.id} d={d} rec={rec?.data ?? null} runRecords={runRecords.data?.records ?? []} types={types.data?.recordTypes ?? []}
      form={form?.data?.form ?? null} holders={proc?.data?.roleHolders ?? {}} />
  </Page>;
}
