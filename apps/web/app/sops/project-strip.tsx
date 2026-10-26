"use client";
// SOP-WORKFLOW part 4: on a project's page, its workflow runs in one line each (where they stand, who has the step,
// late or held up), and Start a workflow for whoever may start one.
import Link from "next/link";
import { useState } from "react";
import { CircleAlert, Play, Workflow } from "lucide-react";
import { styles } from "../ui";
import { StartRun } from "./run-parts";
import type { RunRow, WorkflowList } from "./types";
import css from "./sops.module.css";

export function ProjectWorkflows({ projectId, runs, canStart }: { projectId: string; runs: RunRow[]; canStart: boolean }) {
  const [choosing, setChoosing] = useState(false), [list, setList] = useState<WorkflowList["workflows"] | null>(null), [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);
  const running = runs.filter((r) => r.status === "running");
  if (!running.length && !canStart) return null;
  async function open() { setChoosing(true); if (!list) { const r = await fetch("/api/v0/workflows"); const d = await r.json().catch(() => null); setList((d?.workflows ?? []).filter((w: { status: string }) => w.status === "live")); } }
  return <div className={css.strip} role="region" aria-label="Workflows on this project">
    <Workflow size={16} aria-hidden="true" />
    <span className={css.stripRuns}>{running.length ? running.slice(0, 2).map((r) => { const a = r.active[0];
      return <Link key={r.id} href={`/runs/${r.id}`}><b>{r.workflow}</b> · step {r.done + 1} of {r.steps}{a ? `: ${a.title}${a.person ? ` (${a.person.split(" ")[0]})` : ""}` : ""}
        {r.late ? <em data-tone="danger"><CircleAlert size={11} aria-hidden="true" />late</em> : r.stuck ? <em data-tone="warning">{r.stuck}</em> : null}</Link>; })
      : <span className={css.hint}>No workflow running on this project.</span>}
      {runs.length ? <Link href={`/runs?project=${projectId}&view=all`}>All runs and sent forms</Link> : null}</span>
    {canStart ? choosing ? <span className={css.partActions}>{list === null ? <small>Loading…</small> : list.length ? <select aria-label="Workflow to start" defaultValue="" onChange={(e) => { const w = list.find((x) => x.id === e.target.value); if (w) setChosen({ id: w.id, name: w.name }); }}>
        <option value="" disabled>Choose a workflow</option>{list.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select> : <small>No live workflows yet</small>}
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setChoosing(false)}>Cancel</button></span>
      : <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void open()}><Play size={13} aria-hidden="true" />Start a workflow</button> : null}
    {chosen ? <StartRun workflowId={chosen.id} name={chosen.name} projectId={projectId} onClose={() => { setChosen(null); setChoosing(false); }} /> : null}
  </div>;
}
