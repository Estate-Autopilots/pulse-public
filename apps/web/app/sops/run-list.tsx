// SOP-WORKFLOW: runs as a list: where each one stands, who has the current step, what is late or stuck. Server-safe.
import Link from "next/link";
import { CircleAlert, Hourglass } from "lucide-react";
import { dayTime } from "../lib/format";
import { Avatar, Badge } from "../ui";
import type { RunRow } from "./types";
import css from "./sops.module.css";

export function RunList({ runs, showWorkflow = true, empty }: { runs: RunRow[]; showWorkflow?: boolean; empty?: string }) {
  if (!runs.length) return <p className={css.hint}>{empty ?? "No runs yet."}</p>;
  return <ul className={css.runs}>{runs.map((r) => <li key={r.id} data-status={r.status}>
    <span className={css.runMain}>
      <Link className={css.runTitle} href={`/runs/${r.id}`}>{r.name}</Link>
      <small>{[showWorkflow ? r.workflow : null, r.project && r.project !== r.name ? r.project : null, `started ${dayTime(r.startedAt)}`].filter(Boolean).join(" · ")}</small>
      <span className={css.progress} aria-label={`${r.done} of ${r.steps} steps done`}><i style={{ width: `${Math.round((r.done / Math.max(1, r.steps)) * 100)}%` }} /></span>
    </span>
    <span className={css.runNow}>{r.status !== "running" ? <Badge tone={r.status === "done" ? "success" : "neutral"}>{r.status === "done" ? "Done" : "Stopped"}</Badge>
      : r.active.slice(0, 2).map((a) => <span key={a.id} className={css.nowStep} data-late={a.late ? "" : undefined} title={a.why ?? undefined}>
        {a.person ? <Avatar name={a.person} id={a.personId ?? undefined} photoAt={a.photoAt} size={20} /> : <Hourglass size={14} aria-hidden="true" />}
        <span><b>{a.position}. {a.title}</b><small>{a.person ?? (a.kind === "wait" ? "Waiting" : "Nobody yet")}{a.dueAt ? ` · due ${dayTime(a.dueAt)}` : ""}</small></span></span>)}</span>
    <span className={css.runFlags}>{r.status === "running" && r.late ? <span className={css.chip} data-tone="danger"><CircleAlert size={11} aria-hidden="true" />{r.late} late</span> : null}
      {r.status === "running" && r.stuck ? <span className={css.chip} data-tone="warning">{r.stuck}</span> : null}</span>
  </li>)}</ul>;
}
