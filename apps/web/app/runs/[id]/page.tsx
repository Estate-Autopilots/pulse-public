import Link from "next/link";
import { Suspense } from "react";
import { api, apiV1 } from "../../lib/api";
import { Badge, Message, Page, PageHeader, styles } from "../../ui";
import { RunView } from "../../sops/run-parts";
import type { RunDetail as OldRun } from "../../sops/types";
import type { ProcessDetail, RunDetail } from "../../processes/flow-types";
import { FlowRun } from "../flow-run";
import { fieldsText } from "../flow-runs";
import css from "../run.module.css";

/** One run: a process's run (FLOW-B: stages, states in words, Pip's line, Nudge), or an older workflow's run drawn on
 *  its flow (SOP-WORKFLOW part 2). */
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const f = await apiV1<RunDetail>(`/v1/flow/runs/${encodeURIComponent(id)}`);
  if (f.data) {
    const run = f.data, fields = fieldsText(run, 3);
    // Who can be named for each role (the process's role holders), for leadership and the run's people.
    const p = run.canEdit && run.mode === "live" ? await apiV1<ProcessDetail>(`/v1/flow/processes/${encodeURIComponent(run.processId)}`) : null;
    return <Page>
      <PageHeader title={run.name} back={{ href: `/processes/${encodeURIComponent(run.processId)}`, label: run.process }} recent={{ title: run.name }}
        // FIX-DOCS-WORK: where it stands is a word in the line under the name (the pill crowded it on a phone), and the
        // process is a small link there, not a big button above the steps.
        context={[<Link key="p" className={css.headLink} href={`/processes/${encodeURIComponent(run.processId)}`}>{run.process}</Link>, run.status === "running" ? "Running" : run.status === "done" ? "Done" : "Stopped",
          fields, run.mode === "demo" ? "A practice run: nobody is told" : null]} />
      <Suspense><FlowRun run={run} holders={p?.data?.roleHolders ?? {}} /></Suspense>
    </Page>;
  }
  const r = await api<OldRun>(`workflows/runs/${id}`);
  if (r.error) return <Message text={f.status === 404 || !f.error ? r.error : f.error} />;
  const d = r.data!, run = d.run;
  return <Page fit>
    <PageHeader title={run.name} back={{ href: "/runs", label: "Runs" }} recent={{ title: run.name }}
      context={[run.workflow, `${run.done} of ${run.steps} steps`, run.late ? `${run.late} late` : null, run.stuck]}
      meta={<Badge tone={run.status === "running" ? "accent" : run.status === "done" ? "success" : "neutral"}>{run.status === "running" ? "Running" : run.status === "done" ? "Done" : "Stopped"}</Badge>}
      actions={<Link className={styles.btn} href={`/sops/workflows/${run.workflowId}`}>The process</Link>} />
    <RunView data={d} />
  </Page>;
}
