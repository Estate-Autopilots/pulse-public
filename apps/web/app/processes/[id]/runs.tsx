// FLOW-B: a process's runs: every client or project going through it, where each stands (open, waiting, late, done),
// its next step and Day N; and, once it is live, Start a run with its fields (the package and the like).
import Link from "next/link";
import { CircleAlert, Hourglass, Play } from "lucide-react";
import { day } from "../../lib/format";
import { Empty, Message } from "../../ui";
import type { ProcessDetail, RunSummary } from "../flow-types";
import { StartRun } from "./start-run";
import css from "./process.module.css";

export function ProcessRuns({ process, runs, error }: { process: ProcessDetail; runs: RunSummary[] | null; error: string | null }) {
  const word = process.terms?.run ?? "Run", words = process.terms?.runs ?? "Runs";
  const start = (process.canStart && process.status === "live") || (process.canEdit && process.steps > 0) ? <StartRun process={process} /> : null;
  return <div className={css.runs}>
    <div className={css.runsBar}><p>{process.status === "live" ? `Each ${word.toLowerCase()} follows the version that was live when it started.` : `Runs start once the process is live (Go live on Steps).`}</p>{start}</div>
    {error ? <Message text={error} /> : !runs?.length ? <Empty icon={Play} compact title={`No ${words.toLowerCase()} yet`} text={process.status === "live" ? `Start one for a client or project: its first steps go straight to their people.` : "Finish the steps, press Go live, then start the first one here."} />
      : <ul className={css.runList}>{runs.map((r) => <li key={r.id}><RunCard r={r} fields={fieldsLine(r)} /></li>)}</ul>}
  </div>;
}

/** One run as a card: its name, Day N, its fields, how far it is, what is open, waiting and late, and its next step. */
export function RunCard({ r, fields, process }: { r: RunSummary; fields: string | null; process?: string }) {
  const c = r.counts, pct = c.total ? Math.round(((c.done + c.skipped) / c.total) * 100) : 0;
  return <Link href={`/runs/${r.id}`} className={css.run} data-status={r.status}>
    <span className={css.runHead}><b>{r.name}</b>{r.mode === "demo" ? <em>Demo</em> : null}{r.status !== "running" ? <em>{r.status === "done" ? "Done" : "Stopped"}</em> : null}
      <small>{[process, r.day ? `Day ${r.day}` : r.status === "running" ? "Not on Day 1 yet" : null, fields, `started ${day(r.startedAt)}`].filter(Boolean).join(" · ")}</small></span>
    <span className={css.meter} aria-label={`${pct}% done`}><i style={{ width: `${pct}%` }} /></span>
    <span className={css.runCounts}>
      <span>{c.done} of {c.total - c.skipped} done</span>
      {c.open ? <span>{c.open} open</span> : null}
      {c.waiting ? <span className={css.waiting}><Hourglass size={12} aria-hidden="true" />{c.waiting} waiting for data</span> : null}
      {c.late ? <span className={css.late}><CircleAlert size={12} aria-hidden="true" />{c.late} late</span> : null}
    </span>
    {r.next && r.status === "running" ? <span className={css.next}>Next: <b>{r.next.title}</b>{r.next.who ? ` · ${r.next.who.name}` : ""}{r.next.due.text ? ` · ${r.next.due.text}` : ""}</span> : null}
  </Link>;
}

/** A run's first fields in words: "Package: Sell-Out · Segment: Premium". */
const fieldsLine = (r: RunSummary) => (r.fieldsText ?? []).filter((f) => f.text && f.text !== "No").slice(0, 2).map((f) => `${f.label}: ${f.text}`).join(" · ") || null;
