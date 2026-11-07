import Link from "next/link";
import { CircleAlert, Gauge, Hourglass, Timer, Users } from "lucide-react";
import { api, apiV1 } from "../lib/api";
import type { RunSummary } from "../processes/flow-types";
import { FlowRuns } from "./flow-runs";
import { dayTime } from "../lib/format";
import { hoursText } from "../lib/sop-flow.mjs";
import { Avatar, Empty, Kpi, Message, Page, PageHeader, QueryTabs, Tiles, styles } from "../ui";
import { RunList } from "../sops/run-list";
import { SubmissionList } from "../sops/submission-list";
import type { RunRow, RunsOverview, SubmissionRow } from "../sops/types";
import css from "../sops/sops.module.css";

const VIEWS = ["running", "late", "stuck", "done", "all"] as const;

/** SOP-WORKFLOW part 4: where every run stands (FLOW-B: its own place in the sidebar, /runs). Runs grouped by project; steps past their SLA (who has them, how late);
 *  runs held up and why (nobody to do it, waiting for someone to accept, in the pool, blocked, not started); and where
 *  runs of each workflow wait longest. `?project=` narrows to one project, with the forms sent for it. */
export default async function RunsPage({ searchParams }: { searchParams: Promise<{ view?: string; project?: string; workflow?: string }> }) {
  const q = await searchParams; const view = (VIEWS as readonly string[]).includes(q.view ?? "") ? q.view! : "running";
  // FLOW-B: the processes' runs first (the flow API), then any runs of older workflows. A project's or a workflow's own
  // view (?project=, ?workflow=) stays the older page.
  if (!q.project && !q.workflow) {
    const [f, old] = await Promise.all([apiV1<{ runs: RunSummary[]; counts: { running: number; late: number; alerts: number; done: number } }>("/v1/flow/runs"), api<RunsOverview>("workflows/runs?view=all")]);
    if (f.data) return <FlowRuns runs={f.data.runs} counts={f.data.counts} view={view} older={old.data?.runs ?? []} />;
  }
  const filter = [q.project ? `projectId=${encodeURIComponent(q.project)}` : null, q.workflow ? `workflowId=${encodeURIComponent(q.workflow)}` : null].filter(Boolean).join("&");
  const [r, sent] = await Promise.all([api<RunsOverview>(`workflows/runs${filter ? `?${filter}` : ""}`),
    q.project ? api<{ submissions: SubmissionRow[] }>(`forms/submissions?projectId=${encodeURIComponent(q.project)}`) : Promise.resolve(null)]);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!, k = d.counts;
  const lateRuns = new Set(d.late.map((x) => x.runId)), stuckRuns = new Set(d.stuck.map((x) => x.runId));
  const shown = d.runs.filter((x) => view === "all" ? true : view === "running" ? x.status === "running" : view === "late" ? lateRuns.has(x.id) : view === "stuck" ? stuckRuns.has(x.id) : x.status !== "running");
  // Grouped by project (runs without one by client, else by workflow).
  const groups = new Map<string, { title: string; href: string | null; runs: RunRow[] }>();
  for (const x of shown) { const key = x.projectId ?? x.clientId ?? `w:${x.workflowId}`; const g = groups.get(key) ?? { title: x.project ?? x.client ?? x.workflow, href: x.projectId ? `/tasks/projects/${x.projectId}` : null, runs: [] }; g.runs.push(x); groups.set(key, g); }
  const projectName = q.project ? d.runs.find((x) => x.projectId === q.project)?.project ?? "This project" : null;
  const keep = [q.project ? `project=${q.project}` : null, q.workflow ? `workflow=${q.workflow}` : null].filter(Boolean).join("&") || undefined;
  return <Page>
    <PageHeader title={projectName ? `Runs: ${projectName}` : "Runs"} back={q.project ? { href: `/tasks/projects/${q.project}`, label: projectName ?? "Project" } : undefined}
      context={[`${k.running} running`, k.late ? `${k.late} late step${k.late === 1 ? "" : "s"}` : null, k.stuck ? `${k.stuck} held up` : null]}
      actions={<><Link className={styles.btn} href="/runs/scorecard"><Gauge size={14} aria-hidden="true" />Scorecard</Link><Link className={styles.btn} href="/runs/capacity"><Users size={14} aria-hidden="true" />Capacity</Link></>} />
    <div className={css.area}>
      <Tiles count={4}>
        <Kpi label="Running" value={k.running} note="Runs not finished yet" href={`/runs?view=running${keep ? `&${keep}` : ""}`} />
        <Kpi label="Past their SLA" value={k.late} note="Steps late right now" tone={k.late ? "danger" : undefined} href={`/runs?view=late${keep ? `&${keep}` : ""}`} />
        <Kpi label="Held up" value={k.stuck} note="Runs waiting on something" tone={k.stuck ? "warning" : undefined} href={`/runs?view=stuck${keep ? `&${keep}` : ""}`} />
        <Kpi label="Finished this week" value={k.finishedWeek} note="In the last 7 days" />
      </Tiles>
      <QueryTabs sub base="/runs" param="view" current={view} keep={keep} items={[{ key: "running", label: "Running", count: k.running }, { key: "late", label: "Late", count: k.late }, { key: "stuck", label: "Held up", count: k.stuck },
        { key: "done", label: "Finished" }, { key: "all", label: "All" }]} />
      <div className={css.body}>
        <div className={css.overview}>
          {groups.size ? [...groups.values()].map((g) => <section key={g.title + g.runs[0].id} className={css.box} aria-label={g.title}>
            <p className={css.sub}>{g.href ? <Link className={css.linkBtn} href={g.href}>{g.title}</Link> : g.title}{g.runs.length > 1 ? ` · ${g.runs.length} runs` : ""}</p>
            <RunList runs={g.runs} showWorkflow /></section>)
            : <Empty icon={Timer} compact title={view === "late" ? "Nothing late" : view === "stuck" ? "Nothing held up" : "No runs here"} text={view === "running" ? "Start a process on a project from the process's page: its steps go to the right people." : "Runs show here when they match."} />}
          {sent?.data?.submissions.length ? <section className={css.box} aria-label="Sent forms"><p className={css.sub}>Forms sent for {projectName}</p><SubmissionList rows={sent.data.submissions} showForm /></section> : null}
        </div>
        <aside className={css.side} aria-label="Where runs wait"><div className={`${css.panel} ${css.overview}`}>
          <section aria-label="Past their SLA"><p className={css.sub}>Past their SLA</p>
            {d.late.length ? <ul className={css.flowLinks}>{d.late.slice(0, 8).map((x) => <li key={x.id}><Link href={`/runs/${x.runId}`} className={css.lateRow}>
              <b>{x.title}</b><small>{x.person ? <><Avatar name={x.person} id={x.personId ?? undefined} photoAt={x.photoAt} size={16} />{x.person}</> : "Nobody yet"} · {x.project ?? x.run}</small>
              <em><CircleAlert size={11} aria-hidden="true" />{hoursText(x.lateHours)} late · was due {dayTime(x.dueAt!)}</em></Link></li>)}</ul> : <p className={css.hint}>No step is past its SLA.</p>}</section>
          <section aria-label="Held up"><p className={css.sub}>Held up</p>
            {d.stuck.length ? <ul className={css.flowLinks}>{d.stuck.slice(0, 8).map((x) => <li key={x.runId}><Link href={`/runs/${x.runId}`} className={css.lateRow} data-tone="warning">
              <b>{x.run}</b><small>Step {x.position}: {x.step}</small><em><Hourglass size={11} aria-hidden="true" />{x.why}</em></Link></li>)}</ul> : <p className={css.hint}>Every running step has someone on it.</p>}</section>
          <section aria-label="Where runs wait longest"><p className={css.sub}>Where runs wait longest</p>
            {d.slow.length ? <ul className={css.flowLinks}>{d.slow.map((x) => <li key={x.workflowId + x.title}><Link href={`/sops/workflows/${x.workflowId}`} className={css.lateRow} data-tone="neutral">
              <b>{x.title}</b><small>{x.workflow} · {x.n} done</small><em>Usually {hoursText(x.hours)}{x.sla ? ` (SLA ${hoursText(x.sla)})` : ""}{x.late ? ` · late ${x.late} of ${x.n}` : ""}</em></Link></li>)}</ul>
              : <p className={css.hint}>Once steps finish, Pulse shows which take longest and which miss their SLA.</p>}</section>
        </div></aside>
      </div>
    </div>
  </Page>;
}
