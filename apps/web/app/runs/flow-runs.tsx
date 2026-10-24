// FLOW-B: Runs. Every client or project going through a process, grouped by process: where each stands (open, waiting
// for data, late), its Day N and its next step. Runs of the older workflows follow, as they were.
import Link from "next/link";
import { ChartGantt } from "lucide-react";
import { Empty, Kpi, Page, PageHeader, QueryTabs, Tiles } from "../ui";
import { RunCard } from "../processes/[id]/runs";
import type { RunSummary } from "../processes/flow-types";
import { RunList } from "../sops/run-list";
import type { RunRow } from "../sops/types";
import css from "../processes/[id]/process.module.css";

export function FlowRuns({ runs, counts, view, older }: { runs: RunSummary[]; counts: { running: number; late: number; alerts: number; done: number }; view: string; older: RunRow[] }) {
  const pick = (r: RunSummary) => view === "all" ? true : view === "running" ? r.status === "running" : view === "late" ? r.status === "running" && r.counts.late > 0 : view === "stuck" ? r.status === "running" && r.counts.waiting > 0 && !r.counts.open : r.status !== "running";
  const shown = runs.filter(pick);
  const groups = new Map<string, { id: string; name: string; runs: RunSummary[] }>();
  for (const r of shown) { const g = groups.get(r.processId) ?? { id: r.processId, name: r.process, runs: [] }; g.runs.push(r); groups.set(r.processId, g); }
  const waiting = runs.filter((r) => r.status === "running").reduce((n, r) => n + r.counts.waiting, 0);
  const olderShown = older.filter((x) => view === "all" ? true : view === "running" || view === "late" || view === "stuck" ? x.status === "running" : x.status !== "running");
  return <Page>
    <PageHeader title="Runs" context={[`${counts.running} running`, counts.late ? `${counts.late} late ${counts.late === 1 ? "step" : "steps"}` : null, counts.alerts ? `${counts.alerts} ${counts.alerts === 1 ? "alert" : "alerts"}` : null]} />
    <div className={css.runs}>
      <Tiles count={4}>
        <Kpi label="Running" value={counts.running} note="Projects going through a process" href="/runs?view=running" />
        <Kpi label="Late steps" value={counts.late} note="Past their due day" tone={counts.late ? "danger" : undefined} href="/runs?view=late" />
        <Kpi label="Waiting for data" value={waiting} note="Steps that start when their data is in" tone={waiting ? "warning" : undefined} href="/runs?view=stuck" />
        <Kpi label="Finished" value={counts.done} note="Every step done" href="/runs?view=done" />
      </Tiles>
      <QueryTabs sub base="/runs" param="view" current={view} items={[{ key: "running", label: "Running", count: counts.running }, { key: "late", label: "Late" }, { key: "stuck", label: "Only waiting" }, { key: "done", label: "Finished" }, { key: "all", label: "All" }]} />
      {groups.size ? [...groups.values()].map((g) => <section key={g.id} aria-label={g.name} className={css.runGroup}>
        <h2><Link href={`/processes/${encodeURIComponent(g.id)}`}>{g.name}</Link><small>{g.runs.length}</small></h2>
        <ul className={css.runList}>{g.runs.map((r) => <li key={r.id}><RunCard r={r} fields={fieldsText(r)} /></li>)}</ul>
      </section>) : <Empty icon={ChartGantt} compact title={view === "late" ? "Nothing late" : view === "running" ? "Nothing running" : "No runs here"}
        text={view === "running" ? "Start one from a live process: open it in Processes, then Start on its Runs tab." : "Runs show here when they match."} action={view === "running" ? { href: "/processes?show=live", label: "Live processes" } : undefined} />}
      {olderShown.length ? <section aria-label="Runs of older workflows" className={css.runGroup}><h2>Runs of older workflows<small>{olderShown.length}</small></h2><RunList runs={olderShown} showWorkflow /></section> : null}
    </div>
  </Page>;
}

/** A run's fields in words, from the API's labelled values: "Package: Sell-Out · Segment: Premium" (a "No" is left out). */
export function fieldsText(r: Pick<RunSummary, "fieldsText">, n = 2) {
  return (r.fieldsText ?? []).filter((f) => f.text && f.text !== "No").slice(0, n).map((f) => `${f.label}: ${f.text}`).join(" · ") || null;
}
