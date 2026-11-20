"use client";
// AI-TASKS (owner, 25 Oct 2026): an AI employee's task queue on its profile: its open tasks in the order it works them
// (priority, then due date), what it is doing with each (working now, waiting for someone, with its reviewer), and its
// plan's progress. Read from /api/v0/agents/:id/queue (agent_task_queue: only tasks the viewer may see).
// AI-AGENTS-2 (owner, 17 Nov 2026: "no task queue for an AI: show waiting, running, done, failed with time and cost"):
// the pane is "Work & queue": four counts at the top (waiting, working now, done today, failed today), what today and
// this month cost in tokens (and rupees where Pulse has a price for the engine; never a made-up figure), the open tasks,
// then its latest runs with when, how long and how many tokens; a failed run says why.
// AI-FIX-5 (BC-172, 20 Nov 2026): the latest runs come from its run history (agent_runs_page), as History's do, so each
// shows what was asked and where; the profile's own list has neither, so every chat run read “A question”. A run with no
// text says what it was about (a missed call, a colleague's answer…), and a failed run its manager may retry has Try again.
import Link from "next/link";
import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, CircleX, Clock3, ListChecks, LoaderCircle, RotateCcw } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { StatTile, StatTiles } from "../../../components/calm";
import { canRetry, runAbout } from "../../../lib/ai-runs.mjs";
import { post } from "../../../records";
import { styles } from "../../../ui";
import { modelName } from "./model";
import type { Cost, Workload } from "../workload-types";
import css from "./profile.module.css";

type Item = { id: string; title: string; status: string; statusLabel: string; priority: string; dueOn: string | null; phase: string; waitingOn: string | null; running: boolean;
  givenBy: string | null; reviewer: string | null; steps: number; stepsDone: number };
/** A run as the profile has it (the latest 25, newest first); its run history adds what was asked, where, and `retry`. */
export type QueueRun = { id: string; at: string; state: string; model: string; tokens: number | null; seconds: number | null; errorCode: string | null; error?: string | null;
  kind: string; taskId: string | null; taskTitle: string | null; ask?: string | null; channelName?: string | null; retry?: boolean };
const PHASE: Record<string, string> = { queued: "Next up", working: "Working on it", waiting: "Waiting", in_review: "With its reviewer", returned: "Returned: picking it up", stopped: "Stopped" };
const ZONE = "Asia/Kolkata";
const dayKey = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone: ZONE });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: ZONE });
const when = (iso: string, today: string) => dayKey(Date.parse(iso)) === today ? clock(iso) : new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: ZONE });
const trim = (n: number) => (Math.round(n * 10) / 10).toString();
const tokens = (n: number) => n >= 10000000 ? `${trim(n / 10000000)} crore` : n >= 100000 ? `${trim(n / 100000)} lakh` : n >= 1000 ? `${trim(n / 1000)}k` : String(Math.round(n));
const rupees = (n: number) => `₹${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString("en-IN")}`;
const took = (s: number | null) => !s ? "" : s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
/** Why a run stopped, in plain words (the runtime's own reason first when it gave one). */
const WHY: Record<string, string> = { model_error: "The AI answered with an error.", no_answer: "It finished without an answer.", stuck: "It got stuck and was stopped.",
  out_of_quota: "The AI's plan was out of quota; it starts again when the plan resets.", needs_budget: "Its daily limit was used up.", runaway: "It used far more than a run should and was stopped.",
  timeout: "It took too long and was stopped." };

export function AiQueue({ id, canGive, runs = [] }: { id: string; canGive: boolean; runs?: QueueRun[] }) {
  const [items, setItems] = useState<Item[] | null>(null), [error, setError] = useState("");
  const [cost, setCost] = useState<Cost | null>(null);
  const [today] = useState(() => dayKey(Date.now()));
  const [page, setPage] = useState<QueueRun[] | null>(null), [busy, setBusy] = useState<string | null>(null), [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    // The latest runs with what was asked and whether the viewer may retry one (the profile's list until it arrives).
    const latestRuns = () => fetch(`/api/v0/agents/${encodeURIComponent(id)}/runs?limit=8`, { cache: "no-store" }).then(async (r) => {
      if (!r.ok || !live) return; const x = await r.json().catch(() => null) as { runs?: QueueRun[] } | null;
      if (live && Array.isArray(x?.runs)) setPage(x.runs);
    }).catch(() => {});
    const read = () => fetch(`/api/v0/agents/${encodeURIComponent(id)}/queue`, { cache: "no-store" }).then(async (r) => {
      const d = await r.json().catch(() => ({})); if (!live) return;
      if (!r.ok) { setError(d.error ?? "Could not load its queue"); return; }
      setItems(d.queue ?? []); setError("");
    }).catch(() => { if (live) setError("Could not load its queue"); });
    // Its cost today and this month (FIX-AI-EMPLOYEES 2011), with the Autopilots' own access; nothing shows without it.
    const costs = () => fetch("/api/v0/agents/workload", { cache: "no-store" }).then(async (r) => {
      if (!r.ok || !live) return; const w = await r.json().catch(() => null) as Workload | null;
      const mine = w?.agents?.find((a) => a.id === id)?.cost ?? null; if (live) setCost(mine);
    }).catch(() => {});
    void read(); void costs(); void latestRuns(); const t = setInterval(() => { void read(); void costs(); void latestRuns(); }, 20000);
    return () => { live = false; clearInterval(t); };
  }, [id, tick]);
  async function retry(run: string) {
    setBusy(run);
    try { await post(`agents/${id}/runs/${run}/retry`, {}); notify({ id: "ai-retry", tone: "success", title: "Asked again", message: "It runs as soon as its AI is free.", timeout: 2600 }); setTick((n) => n + 1); }
    catch (e) { notify({ id: "ai-retry", tone: "error", title: "Not tried again", message: (e as Error).message }); } finally { setBusy(null); }
  }
  const todays = runs.filter((r) => dayKey(Date.parse(r.at)) === today);
  const doneToday = todays.filter((r) => r.state === "done").length, failedToday = todays.filter((r) => r.state === "error").length;
  const open = items ?? [];
  const working = open.some((t) => t.running) || cost?.running || runs.some((r) => r.state === "dispatching") ? Math.max(1, open.filter((t) => t.running).length) : 0;
  const waiting = open.filter((t) => !t.running).length + (cost?.queued ?? 0);
  const spend = (s: Cost["today"] | undefined) => s ? `${tokens(s.tokens)} tokens${s.inr !== null && s.inr !== undefined ? ` · ${rupees(s.inr)}` : ""}` : "";
  const latest = (page ?? runs).slice(0, 8);
  return <section className={css.pane} role="tabpanel" id="ai-pane-queue" aria-labelledby="ai-tab-queue">
    <header className={css.paneHead}><div><h3>Work &amp; queue</h3><p>What waits for it, what it is doing now, and what it finished or could not finish, with the time and tokens each took.</p></div></header>
    <div className={css.paneBody}>
      <StatTiles label="Its work at a glance">
        <StatTile label="Waiting" value={items === null ? "…" : waiting} sub={waiting ? "tasks and messages" : "nothing waiting"} />
        <StatTile label="Working now" value={working} sub={working ? "on it now" : "free"} tone={working ? "good" : undefined} />
        <StatTile label="Done today" value={doneToday} sub={cost ? spend(cost.today) : undefined} />
        <StatTile label="Failed today" value={failedToday} sub={failedToday ? "see why below" : "none"} tone={failedToday ? "bad" : undefined} />
      </StatTiles>
      {cost ? <p className={css.help} data-ai-cost="">This month so far: <b>{spend(cost.month)}</b>.{cost.month.inr === null ? " Cost shows in tokens until a price is set for its AI." : ""}</p> : null}
      <div className={css.fieldGroup}>
        <div className={css.groupHead}><span>Open tasks</span><small className={css.help}>Most important first, then the soonest due.</small></div>
        {error ? <p className={css.roNote}>{error}</p> : items === null ? <p className={styles.muted}><LoaderCircle size={15} aria-hidden="true" /> Loading…</p>
          : items.length ? <ul className={css.list}>{items.map((t) => <li key={t.id} className={css.item}>
            <em className={css.pill} data-status={t.status === "blocked" ? "bad" : t.status === "in_review" ? "done" : t.running ? "run" : "wait"}>{t.running ? "Working now" : PHASE[t.phase] ?? t.statusLabel}</em>
            <span className={css.itemMain}><Link href={`/tasks/${t.id}`}><b>{t.title}</b></Link>
              <small>{[t.statusLabel, t.phase === "waiting" && t.waitingOn ? `waiting for ${t.waitingOn}` : null, t.steps ? `${t.stepsDone} of ${t.steps} steps` : null,
                t.priority !== "normal" ? `${t.priority} priority` : null, t.dueOn ? `due ${t.dueOn}` : null, t.givenBy ? `from ${t.givenBy}` : null, t.reviewer ? `reviewer ${t.reviewer}` : null].filter(Boolean).join(" · ")}</small></span>
          </li>)}</ul>
          : <p className={styles.muted}><ListChecks size={15} aria-hidden="true" /> Nothing open. {canGive ? "Give it a task from Work (+ Create, Who does it), from a chat (@its name … Send as task) or from a group's review queue." : null}</p>}
      </div>
      <div className={css.fieldGroup}>
        <div className={css.groupHead}><span>Latest runs</span><small className={css.help}>{runs.length ? "Every run is in History." : ""}</small></div>
        {latest.length ? <ul className={css.list} data-ai-runs="">{latest.map((r) => {
          const state = r.state === "done" ? "done" : r.state === "error" ? (r.errorCode === "out_of_quota" ? "wait" : "bad") : "run";
          return <li key={r.id} className={css.run} data-state={state}>
            <span className={css.runIcon} aria-label={state === "done" ? "Done" : state === "bad" ? "Failed" : state === "wait" ? "Out of quota" : "Running"}>
              {state === "done" ? <CircleCheck size={16} aria-hidden="true" /> : state === "bad" ? <CircleX size={16} aria-hidden="true" /> : state === "wait" ? <Clock3 size={16} aria-hidden="true" /> : <LoaderCircle size={16} aria-hidden="true" />}</span>
            <span className={css.itemMain}>
              <span className={css.runTitle}>{r.taskTitle && r.taskId ? <Link href={`/tasks/${r.taskId}`}>{r.taskTitle}</Link> : r.ask ? <span className={css.ask}>“{r.ask}”</span> : <span className={css.muted}>{runAbout(r.kind, !!r.channelName)}</span>}
                {r.channelName ? <span className={css.where}> in {r.channelName}</span> : null}</span>
              <small>{[when(r.at, today), took(r.seconds), r.tokens === null ? null : `${tokens(r.tokens)} tokens`, r.model ? modelName(r.model) : null].filter(Boolean).join(" · ")}</small>
              {r.state === "error" ? <span className={css.reason}><CircleAlert size={13} aria-hidden="true" />{r.error?.trim() || (r.errorCode ? WHY[r.errorCode] ?? `It stopped (${r.errorCode.replaceAll("_", " ")}).` : "It stopped without saying why.")}</span> : null}
            </span>
            {canRetry(r) ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy === r.id} onClick={() => void retry(r.id)} data-ai-retry="">
              <RotateCcw size={14} aria-hidden="true" />{busy === r.id ? "Trying again…" : "Try again"}</button> : null}
          </li>; })}</ul>
          : <p className={styles.muted}><Clock3 size={15} aria-hidden="true" /> No runs yet. They show here when it is asked something or given a task.</p>}
      </div>
      <p className={css.help}><Link href="/people/ai/tasks">Tasks and cost of every AI employee</Link></p>
    </div>
  </section>;
}
