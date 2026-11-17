// FLOW-B: Runs. Every client or project going through a process, grouped by process: where each stands (open, waiting
// for data, late), its Day N and its next step. Runs of the older workflows follow, as they were.
import Link from "next/link";
import { ChartGantt, Gauge, Play, Users, Workflow } from "lucide-react";
import { Page } from "../ui";
import { ChipFilter, EmptyState, kit, PrimaryLink, QuietLink, SectionHeader, WorkHeader, WorkPage } from "../components/work-kit";
import { plural } from "../lib/format";
import { RunCard } from "../processes/[id]/runs";
import type { RunSummary } from "../processes/flow-types";
import { RunList } from "../sops/run-list";
import type { RunRow } from "../sops/types";
import css from "../processes/[id]/process.module.css";

export function FlowRuns({ runs, view, older }: { runs: RunSummary[]; counts: { running: number; late: number; alerts: number; done: number }; view: string; older: RunRow[] }) {
  const pick = (r: RunSummary, v = view) => v === "all" ? true : v === "running" ? r.status === "running" : v === "late" ? r.status === "running" && r.counts.late > 0 : v === "stuck" ? r.status === "running" && r.counts.waiting > 0 && !r.counts.open : r.status !== "running";
  const shown = runs.filter((r) => pick(r));
  const groups = new Map<string, { id: string; name: string; runs: RunSummary[] }>();
  for (const r of shown) { const g = groups.get(r.processId) ?? { id: r.processId, name: r.process, runs: [] }; g.runs.push(r); groups.set(r.processId, g); }
  const waiting = runs.filter((r) => r.status === "running").reduce((n, r) => n + r.counts.waiting, 0);
  // An older run is late when a step is past due, and only waiting when it is held up, the same tests as a flow run's.
  const oldPick = (x: RunRow, v = view) => v === "all" ? true : v === "running" ? x.status === "running" : v === "late" ? x.status === "running" && x.late > 0 : v === "stuck" ? x.status === "running" && !!x.stuck : x.status !== "running";
  const olderShown = older.filter((x) => oldPick(x));
  // UX-WORK (owner, 5 Nov 2026): My day's language. One set of numbers: chips with counts (no tiles repeating them), each
  // counting runs, and exactly the runs the view it opens lists; the runs of older workflows count too ("0 running" sat
  // above a running older run). Each process's runs sit under a plain heading; an empty view says what to do.
  const n = (v: string) => runs.filter((r) => pick(r, v)).length + older.filter((x) => oldPick(x, v)).length;
  const late = n("late"), stuck = n("stuck");
  const chip = (key: string, label: string, count?: number, tone?: "bad" | "warn") => ({ key, label, count, tone, href: key === "running" ? "/runs" : `/runs?view=${key}`, current: view === key });
  return <Page><WorkPage>
    <WorkHeader eyebrow="Work · every project going through a process" title="Runs"
      context={`${plural(n("running"), "run")} going${late ? `, ${late} with a late step` : ""}${waiting ? `; ${plural(waiting, "step")} waiting for data` : ""}.`}
      actions={<span className={kit.phoneHide}><QuietLink href="/runs/scorecard" icon={Gauge}>Scorecard</QuietLink><QuietLink href="/runs/capacity" icon={Users}>Capacity</QuietLink></span>}
      primary={<PrimaryLink href="/processes?show=live" icon={Play}>Start a run</PrimaryLink>} />
    <ChipFilter label="Show runs" items={[chip("running", "Running", n("running")), chip("late", "Late", late, late ? "bad" : undefined), chip("stuck", "Only waiting", stuck, stuck ? "warn" : undefined), chip("done", "Finished", n("done")), chip("all", "All", n("all"))]} />
    {groups.size ? [...groups.values()].map((g) => <section key={g.id} aria-label={g.name} className={css.runGroup}>
      <SectionHeader icon={Workflow} title={<Link href={`/processes/${encodeURIComponent(g.id)}`}>{g.name}</Link>} count={g.runs.length} />
      <ul className={css.runList}>{g.runs.map((r) => <li key={r.id}><RunCard r={r} fields={fieldsText(r)} /></li>)}</ul>
    </section>) : !olderShown.length ? <EmptyState icon={ChartGantt} title={view === "late" ? "Nothing is late" : view === "running" ? "Nothing is running" : view === "stuck" ? "Nothing is only waiting" : "No runs here"}
      text={view === "running" || view === "all" ? "A run is one project or client going through a process. Open a live process and press Start: its steps go to the right people." : "Runs show here when they match. Running shows everything still going."}
      action={view === "running" || view === "all" ? { href: "/processes?show=live", label: "Choose a live process" } : { href: "/runs", label: "Show what is running" }} /> : null}
    {olderShown.length ? <section aria-label="Runs of older workflows" className={css.runGroup}><SectionHeader title="Runs of older workflows" count={olderShown.length} /><RunList runs={olderShown} showWorkflow /></section> : null}
    {/* On a phone the reports are quiet links at the foot, so the first run is near the top. */}
    <p className={kit.phoneOnly}><QuietLink href="/runs/scorecard" icon={Gauge}>Scorecard</QuietLink><QuietLink href="/runs/capacity" icon={Users}>Capacity</QuietLink></p>
  </WorkPage></Page>;
}

/** A run's fields in words, from the API's labelled values: "Package: Sell-Out · Segment: Premium" (a "No" is left out). */
export function fieldsText(r: Pick<RunSummary, "fieldsText">, n = 2) {
  return (r.fieldsText ?? []).filter((f) => f.text && f.text !== "No").slice(0, n).map((f) => `${f.label}: ${f.text}`).join(" · ") || null;
}
