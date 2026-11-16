"use client";
// WORK-SPINE (owner, 10 Nov 2026): the pieces the goal, project and task screens share.
//  * Trail: Goals › goal › project › parent › task, links all the way (every task and project shows where it sits).
//  * DueChip: a due day with its state, and late always says why ("was due 9 Nov and is not done yet").
//  * TickRow: a task you can finish in one click from anywhere in the flow (a small celebration, and Undo).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowUpRight, Bot, CalendarDays, Check, ChevronRight, CornerDownRight, ListChecks, Paperclip, Pin, Target } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { Avatar } from "../ui";
import { Drawer, DrawerFooter, HelpHint } from "../kit";
import { celebrate, ProofForm } from "./client";
import { Threads } from "./threads";
import type { Comment as ThreadComment } from "./work-client";
import { activityWords, dueState, isDone, LATE_HELP, trail } from "../lib/work-spine.mjs";
import { parseNotes } from "../lib/task-sense.mjs";
import css from "./spine.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

export type TrailGoal = { id: string; title: string };
/** Where this sits: Goals › goal › project › parent tasks. The last link is the page you are on, so it is not repeated. */
export function Trail({ goals, project, parents, label = "Where this sits", compact }: { goals?: TrailGoal[]; project?: { id: string; name: string } | null; parents?: { id: string; title: string }[]; label?: string;
  /** One line, no "Goals" root: for a drawer's narrow header. */ compact?: boolean }) {
  const t = trail({ goals, project, parents });
  return <nav className={css.trail} aria-label={label} data-compact={compact ? "" : undefined}>
    {compact ? null : <Link href="/goals" className={css.trailRoot}><Target size={13} aria-hidden="true" />Goals</Link>}
    {!compact && t.items.length && t.items[0].kind !== "goal" ? <><ChevronRight size={13} aria-hidden="true" /><span className={css.trailNone}>No goal yet</span></> : null}
    {t.items.map((x, i) => <span key={x.href} className={css.trailStep}>{compact && !i ? (x.kind === "goal" ? <Target size={13} aria-hidden="true" /> : null) : <ChevronRight size={13} aria-hidden="true" />}<Link href={x.href} title={x.label} data-kind={x.kind}>{x.label}</Link></span>)}
    {t.moreGoals ? <small className={css.trailMore}>+{t.moreGoals} more {t.moreGoals === 1 ? "goal" : "goals"}</small> : null}
  </nav>;
}

/** The due day and its state. Late carries its reason, in words and in the (?) beside it. */
export function DueChip({ dueOn, today, status, help = true }: { dueOn: string | null | undefined; today: string; status: string; help?: boolean }) {
  const d = dueState(dueOn, today, status);
  if (!d.chip) return null;
  return <span className={css.due} data-state={d.state} title={d.why ?? undefined}>
    <CalendarDays size={12} aria-hidden="true" />{d.chip}
    {d.state === "late" && help ? <HelpHint label="What late means" title="Late">{d.why} {LATE_HELP}</HelpHint> : null}
  </span>;
}

export type TickTask = { id: string; title: string; status: string; dueOn: string | null; who?: string | null; whoId?: string | null; parentTitle?: string | null; projectName?: string | null; projectId?: string | null };
/** One task, finished in one click. Undo puts it back. */
export function TickRow({ task, today, canTick = true, showProject = false }: { task: TickTask; today: string; canTick?: boolean; showProject?: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle"), [peek, setPeek] = useState(false);
  const finished = state === "done" || ["done", "accepted", "in_review"].includes(task.status);
  async function done(e: React.MouseEvent<HTMLButtonElement>) {
    if (finished || state === "busy") return;
    const origin = e.currentTarget; setState("busy");
    try {
      const before = task.status === "unknown" ? "open" : task.status;
      const r = await post<{ weekDone?: number; streak?: number; released?: number }>(`tasks/${task.id}/move`, { status: "done" });
      setState("done");
      celebrate(r, task.title, null, () => { void post(`tasks/${task.id}/move`, { status: before }).then(() => { setState("idle"); router.refresh(); })
        .catch((x) => notify({ id: "undo", tone: "error", title: "Not undone", message: msg(x) })); }, { origin });
      setTimeout(() => router.refresh(), 700);
    } catch (x) { setState("idle"); notify({ id: "task-move", tone: "error", title: "Not marked done", message: msg(x) }); }
  }
  return <li className={css.tick} data-done={finished ? "" : undefined}>
    <button type="button" className={css.box} onClick={(e) => void done(e)} disabled={!canTick || finished || state === "busy"} data-done={finished ? "" : undefined}
      aria-label={finished ? `${task.title}: done` : `Mark “${task.title}” done`} title={finished ? "Done" : canTick ? "Mark done" : "Only the people on it can finish it"}>
      <Check size={13} strokeWidth={3} aria-hidden="true" /></button>
    <span className={css.tickMain}>
      <Link href={`/tasks/${task.id}`} className={css.tickTitle} title={task.title} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); setPeek(true); }}>{task.title}</Link>
      <span className={css.tickMeta}>
        {task.parentTitle ? <span className={css.sub} title={`Part of “${task.parentTitle}”`}><CornerDownRight size={11} aria-hidden="true" />{task.parentTitle}</span> : null}
        {showProject && task.projectName && task.projectId ? <Link href={`/tasks/projects/${task.projectId}`} className={css.sub}>{task.projectName}</Link> : null}
        {!finished ? <DueChip dueOn={task.dueOn} today={today} status={task.status} /> : <span className={css.doneWord}>Done</span>}
      </span>
    </span>
    {task.who ? <span className={css.who} title={task.who}><Avatar name={task.who} id={task.whoId ?? undefined} size={24} /></span> : null}
    {peek ? <TaskPeek id={task.id} today={today} onClose={() => setPeek(false)} /> : null}
  </li>;
}

type Peek = { task: { id: string; title: string; status: string; dueOn: string | null; notes: string | null; projectId: string | null; projectName: string | null; assigneeName: string | null; assigneeId: string | null };
  parents: { id: string; title: string }[]; goals?: { id: string; title: string }[]; checks?: { key: string; label: string }[]; events: { kind: string; from: string | null; to: string | null; by: string | null; at: string }[];
  project: { projectType?: string | null } | null; can: { edit: boolean }; me: string | null;
  children?: { id: string; title: string; status: string }[]; comments?: { id: string; body: string; authorName: string | null; at: string }[] };
/** WORK-SPINE (concept "task drawer"): a task beside the page you are on: where it sits (Goal › Project), when it is
 *  due and why it is late, Mark done, its checklist (the numbered steps in its notes), and what happened. */
export function TaskPeek({ id, today, onClose }: { id: string; today: string; onClose: () => void }) {
  const router = useRouter();
  const [d, setD] = useState<Peek | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [ticked, setTicked] = useState<Set<string>>(new Set());
  const [step, setStep] = useState(""), [adding, setAdding] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`/api/v0/tasks/${encodeURIComponent(id)}`, { cache: "no-store" }).then(async (r) => { const j = await r.json(); if (!live) return; if (!r.ok) setError(j?.error ?? "This task did not open."); else { setD(j); setTicked(new Set((j.checks ?? []).map((c: { key: string }) => c.key))); } })
      .catch(() => { if (live) setError("This task did not open. Try again."); });
    return () => { live = false; };
  }, [id]);
  const t = d?.task, done = !!t && isDone(t.status), may = !!d && (d.can.edit || (!!d.me && d.me === t?.assigneeId));
  const parsed = parseNotes(t?.notes ?? "") as { intro: string[]; steps: { n: number; text: string; key: string }[] };
  const steps = parsed.steps;
  // A new step is a numbered line in the task's notes (how Pulse keeps a checklist).
  async function addStep(e: React.FormEvent) {
    e.preventDefault(); const text = step.trim(); if (!t || !text) return; setAdding(true);
    const notes = `${(t.notes ?? "").replace(/\s+$/, "")}${steps.length ? "\n" : (t.notes ?? "").trim() ? "\n\nSteps:\n" : "Steps:\n"}${steps.length + 1}. ${text}`;
    try { await post(`tasks/${t.id}`, { notes }); setD((x) => x ? { ...x, task: { ...x.task, notes } } : x); setStep(""); }
    catch (x) { notify({ id: "steps", tone: "error", title: "Not added", message: msg(x) }); } finally { setAdding(false); }
  }
  async function finish(e: React.MouseEvent<HTMLButtonElement>) {
    if (!t || done) return; const origin = e.currentTarget; setBusy(true);
    try {
      const before = t.status === "unknown" ? "open" : t.status;
      const r = await post<{ weekDone?: number; streak?: number; released?: number }>(`tasks/${t.id}/move`, { status: "done" });
      setD((x) => x ? { ...x, task: { ...x.task, status: "done" } } : x);
      celebrate(r, t.title, null, () => { void post(`tasks/${t.id}/move`, { status: before }).then(() => router.refresh()).catch((x) => notify({ id: "undo", tone: "error", title: "Not undone", message: msg(x) })); }, { origin });
      router.refresh();
    } catch (x) { notify({ id: "task-move", tone: "error", title: "Not marked done", message: msg(x) }); } finally { setBusy(false); }
  }
  async function tick(key: string, label: string) {
    if (!t) return; const on = !ticked.has(key), before = ticked;
    setTicked((s) => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n; });
    try { await post(`tasks/${t.id}/checks`, { key, label, done: on }); } catch (x) { setTicked(before); notify({ id: "steps", tone: "error", title: "Not saved", message: msg(x) }); }
  }
  const due = t ? dueState(t.dueOn, today, t.status) : null;
  return <Drawer title={t?.title ?? "Task"} label={t ? `Task: ${t.title}` : "Task"} onClose={onClose} size="md"
    context={d ? <Trail compact goals={d.goals ?? []} project={t?.projectId ? { id: t.projectId, name: t.projectName ?? "Project" } : null} label="Where this task sits" /> : null}
    footer={<DrawerFooter status={error ?? undefined}>
      {t ? <Link href={`/tasks/${t.id}`} className={css.peekOpen}>Open full page<ArrowUpRight size={14} aria-hidden="true" /></Link> : null}</DrawerFooter>}>
    {!d && !error ? <p className={css.peekQuiet} role="status">Opening the task…</p> : null}
    {t ? <>
      <dl className={css.peekFacts}>
        <div><dt>When</dt><dd>{due?.chip ? <DueChip dueOn={t.dueOn} today={today} status={t.status} /> : done ? <span className={css.doneWord}>Done</span> : "No due day"}</dd></div>
        <div><dt>Who</dt><dd>{t.assigneeName ? <span className={css.peekWho}><Avatar name={t.assigneeName} id={t.assigneeId ?? undefined} size={20} />{t.assigneeName}</span> : "Nobody yet"}</dd></div>
        {t.projectId ? <div><dt>Project</dt><dd><Link href={`/tasks/projects/${t.projectId}`}>{t.projectName ?? "Project"}</Link></dd></div> : null}
      </dl>
      <button type="button" className={css.peekDone} onClick={(e) => void finish(e)} disabled={busy || done || !may}>
        <Check size={15} strokeWidth={3} aria-hidden="true" />{done ? "Done" : busy ? "Saving…" : "Mark done"}</button>
      {due?.state === "late" ? <p className={css.peekWhy}>{due.why} {LATE_HELP}</p> : null}
      {parsed.intro.length ? <p className={css.peekNotes}>{parsed.intro.join(" ")}</p> : null}
      <section className={css.peekSection} aria-label="Checklist"><h3>{steps.length ? `Checklist · ${steps.filter((x) => ticked.has(x.key)).length} of ${steps.length}` : "Checklist"}</h3>
        {steps.length ? <ul className={css.peekSteps}>{steps.map((x) => <li key={x.key}><label><input type="checkbox" checked={ticked.has(x.key)} disabled={!may || done} onChange={() => void tick(x.key, x.text)} /><span>{x.text}</span></label></li>)}</ul>
          : <p className={css.peekQuiet}><ListChecks size={14} aria-hidden="true" /> No steps yet. Break it into small steps you can tick.</p>}
        {d?.can.edit && !done ? <form className={css.peekAdd} onSubmit={(e) => void addStep(e)}>
          <input value={step} onChange={(e) => setStep(e.target.value)} placeholder="Add a step" aria-label="Add a step" maxLength={200} />
          <button type="submit" disabled={adding || !step.trim()}>{adding ? "Adding…" : "Add"}</button></form> : null}
      </section>
      {d?.children?.length ? <section className={css.peekSection} aria-label="Subtasks"><h3>Subtasks · {d.children.filter((c) => isDone(c.status)).length} of {d.children.length} done</h3>
        <ul className={css.peekEvents}>{d.children.map((c) => <li key={c.id}><Link href={`/tasks/${c.id}`} className={isDone(c.status) ? css.peekDoneItem : undefined}>{isDone(c.status) ? "✓ " : ""}{c.title}</Link></li>)}</ul></section> : null}
      {d ? <section className={css.peekSection} aria-label="Discussion"><h3>Discussion</h3>
        <div className={css.peekThreads}><Threads taskId={t.id} comments={(d.comments ?? []) as unknown as ThreadComment[]} canComment={!!d.me} canResolve={false} /></div></section> : null}
      {d && d.events.length > 1 ? <section className={css.peekSection} aria-label="What happened"><h3>What happened</h3>
        <ul className={css.peekEvents}>{d.events.slice(0, 5).map((e, i) => <li key={`${e.at}-${i}`}>{activityWords({ src: "task", kind: e.kind, from: e.from, to: e.to, by: e.by, taskTitle: null }).replace(" a task", " it")}</li>)}</ul>
      </section> : null}
    </> : null}
  </Drawer>;
}

/** WORK-SPINE: a project an AI employee or an automation started sits under "Started by AI" until a person keeps it. */
export function KeepProject({ projectId, startedBy, onGoal, compact }: { projectId: string; startedBy: "person" | "ai"; onGoal: boolean; /** Just the button (a list row). */ compact?: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function set(next: "person" | "ai") {
    setBusy(true);
    try { await post(`work/projects/${projectId}`, { startedBy: next }); notify({ id: `keep:${projectId}`, tone: "success", title: next === "person" ? "Kept in your projects" : "Moved to Started by AI", timeout: 2800 }); router.refresh(); }
    catch (e) { notify({ id: `keep:${projectId}`, tone: "error", title: "Not moved", message: msg(e) }); } finally { setBusy(false); }
  }
  if (compact && startedBy === "ai") return <button type="button" className={css.keep} onClick={() => void set("person")} disabled={busy}><Pin size={14} aria-hidden="true" />Keep in my projects</button>;
  if (startedBy === "person") return <button type="button" className={css.keep} onClick={() => void set("ai")} disabled={busy}><Bot size={14} aria-hidden="true" />Move to Started by AI</button>;
  return <div className={css.keepNote}><Bot size={16} aria-hidden="true" /><span>{onGoal ? "An AI started this project. It shows in your list because a goal holds it." : "An AI started this project, so it is kept under “Started by AI” and out of your list."}</span>
    <button type="button" className={css.keep} onClick={() => void set("person")} disabled={busy}><Pin size={14} aria-hidden="true" />Keep in my projects</button></div>;
}

/** WORK-SPINE: a project's files live on its tasks. Pick the task, then add a file or a link to it. */
export function AddProjectFile({ tasks }: { tasks: { id: string; title: string }[] }) {
  const [open, setOpen] = useState(false), [task, setTask] = useState(tasks[0]?.id ?? "");
  if (!tasks.length) return null;
  if (!open) return <button type="button" className={css.dropZone} onClick={() => setOpen(true)}><Paperclip size={18} aria-hidden="true" /><span><b>Add a file or a link</b><small>Pick which task it belongs to.</small></span><span className={css.dropBtn} aria-hidden="true">Add</span></button>;
  return <div className={css.addFile}>
    <label className={css.addFileTask}><span>On which task</span>
      <select value={task} onChange={(e) => setTask(e.target.value)}>{tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
    {task ? <ProofForm key={task} taskId={task} compact to="attachments" /> : null}
  </div>;
}

/** WORK-SPINE: "Mark done" as the view's one primary button (the goal's next thing to do). Undo puts it back. */
export function DoneButton({ id, title, status = "open" }: { id: string; title: string; status?: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done">(isDone(status) ? "done" : "idle");
  async function done(e: React.MouseEvent<HTMLButtonElement>) {
    if (state !== "idle") return; const origin = e.currentTarget; setState("busy");
    try {
      const r = await post<{ weekDone?: number; streak?: number; released?: number }>(`tasks/${id}/move`, { status: "done" });
      setState("done");
      celebrate(r, title, null, () => { void post(`tasks/${id}/move`, { status: status === "unknown" ? "open" : status }).then(() => { setState("idle"); router.refresh(); })
        .catch((x) => notify({ id: "undo", tone: "error", title: "Not undone", message: msg(x) })); }, { origin });
      setTimeout(() => router.refresh(), 700);
    } catch (x) { setState("idle"); notify({ id: "task-move", tone: "error", title: "Not marked done", message: msg(x) }); }
  }
  return <button type="button" className={css.peekDone} onClick={(e) => void done(e)} disabled={state !== "idle"}>
    <Check size={15} strokeWidth={3} aria-hidden="true" />{state === "done" ? "Done" : state === "busy" ? "Saving…" : "Mark done"}</button>;
}
