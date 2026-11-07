"use client";
// SOP-WORKFLOW part 2: a run of a workflow. Start one on a project; follow it on its flow (each step done, doing and by
// whom, waiting, skipped, late); answer an approval or a decision; give a step to someone else; stop the run.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { CircleAlert, CircleStop, ExternalLink, PenLine, Play, Workflow, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { PersonPicker, ProjectPicker, useWorkOptions } from "../create";
import { day, dayTime } from "../lib/format";
import { Modal, post } from "../records";
import { Avatar, styles } from "../ui";
import { FlowCanvas, type StepState } from "./flow";
import { SubmissionList } from "./submission-list";
import { KIND_LABEL, RUN_STATUS, type RunDetail, type RunStep } from "./types";
import css from "./sops.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

/** Start a run: on a project (its owner and people come first for each step), with values the branches look at. */
export function StartRun({ workflowId, name, fields = [], projectId, onClose }: { workflowId: string; name: string; fields?: string[]; projectId?: string; onClose: () => void }) {
  const router = useRouter(); const { data } = useWorkOptions();
  const [project, setProject] = useState<string | null>(projectId ?? null), [label, setLabel] = useState(""), [values, setValues] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function start() {
    setBusy(true); setError("");
    try {
      const context = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()).map(([k, v]) => [k, /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v.trim()]));
      const r = await post<{ id: string }>(`workflows/${workflowId}/start`, { projectId: project, name: label || null, context });
      notify({ id: "run", tone: "success", title: "Started: the first steps are with their people", timeout: 3500 }); router.push(`/runs/${r.id}`);
    } catch (e) { setError(msg(e)); setBusy(false); }
  }
  return <Modal title={`Start: ${name}`} sub="Each step becomes a task for the right person when the one before it is done." onClose={onClose} scroll
    foot={<div className={css.footer} style={{ position: "static", border: 0 }}>{error ? <span className={css.error} role="alert">{error}</span> : <span />}
      <button type="button" className={styles.btn} onClick={onClose}>Cancel</button><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void start()}><Play size={14} aria-hidden="true" />Start</button></div>}>
    <div className={css.panel}>
      {data ? <div className={css.field}><span>Project</span><ProjectPicker projects={data.projects} value={project} onChange={setProject} label="Project" /></div> : null}
      <label className={css.field}><span>Name (optional)</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="The project's name" maxLength={300} /></label>
      {fields.length ? <><p className={css.sub}>Values the branches look at</p>{fields.map((f) => <label key={f} className={css.field}><span>{f}</span><input value={values[f] ?? ""} onChange={(e) => setValues({ ...values, [f]: e.target.value })} /></label>)}</> : null}
    </div>
  </Modal>;
}

/** Answer an approval or a decision (with a note), as the person doing it, whoever started the run, or leadership. */
export function Decide({ stepId, choices, compact }: { stepId: string; choices: string[]; compact?: boolean }) {
  const router = useRouter(); const [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  async function decide(choice: string) {
    setBusy(true); try { await post(`workflows/steps/${stepId}/decide`, { choice, note: note || null }); notify({ id: "decide", tone: "success", title: `${choice}: the run moves on`, timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: "decide", tone: "error", title: "Not answered", message: msg(e) }); } finally { setBusy(false); }
  }
  return <div className={css.decide}>
    {compact ? null : <label className={css.field}><span>Note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What to change, or why" maxLength={500} /></label>}
    <span className={css.partActions}>{choices.map((c, i) => <button key={c} type="button" className={`${styles.btn} ${i === 0 ? styles.btnPrimary : ""}`} disabled={busy} onClick={() => void decide(c)}>{c}</button>)}</span>
  </div>;
}

export function RunView({ data }: { data: RunDetail }) {
  const r = data.run; const router = useRouter();
  const [sel, setSel] = useState<string | null>(data.steps.find((s) => s.status === "active" && s.canDecide)?.key ?? null);
  const persons = useMemo(() => Object.fromEntries(data.persons.map((p) => [p.id, p])), [data.persons]);
  const states = useMemo(() => Object.fromEntries(data.steps.map((s) => [s.key, { status: s.status, late: s.late && s.status === "active", outcome: s.outcome && s.kind !== "task" ? s.outcome : null,
    person: s.personId ? persons[s.personId] ?? { id: s.personId, name: s.person ?? "", photoAt: s.photoAt, pod: null } : null, text: s.status === "active" && s.stuck && !s.late ? s.stuck : null } as StepState])), [data.steps, persons]);
  const step = sel ? data.steps.find((s) => s.key === sel) ?? null : null;
  const [stopping, setStopping] = useState(false), [note, setNote] = useState("");
  async function stop() { try { await post(`workflows/runs/${r.id}/cancel`, { note: note || null }); setStopping(false); router.refresh(); } catch (e) { notify({ id: "run", tone: "error", title: "Not stopped", message: msg(e) }); } }
  return <div className={css.area} data-fill="">
    <div className={css.body} data-fill="">
      <FlowCanvas steps={data.definition.steps} people={data.people} persons={persons} selected={sel} onSelect={setSel} states={states} label={`${r.name}: the run`} />
      <aside className={css.side} aria-label={step ? step.title : "This run"}>
        {step ? <RunStepPanel step={step} onClose={() => setSel(null)} /> : <div className={`${css.panel} ${css.overview}`}>
          <div className={css.panelHead}><div><h3>{r.name}</h3><small>{r.workflow} · {RUN_STATUS[r.status]}</small></div>
            {r.late ? <span className={css.chip} data-tone="warning"><CircleAlert size={11} aria-hidden="true" />{r.late} late</span> : null}</div>
          <dl className={css.facts}>
            <dt>Progress</dt><dd>{r.done} of {r.steps} steps</dd>
            {r.project ? <><dt>Project</dt><dd><Link className={css.linkBtn} href={`/tasks/projects/${r.projectId}`}>{r.project}</Link></dd></> : r.client ? <><dt>Client</dt><dd>{r.client}</dd></> : null}
            <dt>Started</dt><dd>{dayTime(r.startedAt)}{r.startedBy ? ` by ${r.startedBy}` : ""}{r.via !== "manual" ? ` (${r.via === "package" ? "a new package" : r.via})` : ""}</dd>
            {r.finishedAt ? <><dt>{r.status === "done" ? "Finished" : "Stopped"}</dt><dd>{day(r.finishedAt)}{r.cancelledBy ? ` by ${r.cancelledBy}` : ""}{r.cancelNote ? `: ${r.cancelNote}` : ""}</dd></> : null}
          </dl>
          {r.active.length ? <section aria-label="Now"><p className={css.sub}>Now</p><ul className={css.flowLinks}>{r.active.map((a) => <li key={a.id}><button type="button" onClick={() => setSel(a.key)}>
            <b>{a.position}. {a.title}</b><small>{a.person ? <><Avatar name={a.person} id={a.personId ?? undefined} photoAt={a.photoAt} size={16} />{a.person}</> : null}{a.dueAt ? ` · due ${dayTime(a.dueAt)}` : ""}{a.stuck ? ` · ${a.stuck}` : ""}</small></button></li>)}</ul></section> : null}
          {data.canCancel ? stopping ? <div className={css.box}><label className={css.field}><span>Why stop it (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
            <span className={css.partActions}><button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={() => void stop()}><CircleStop size={14} aria-hidden="true" />Stop the run</button><button type="button" className={styles.btn} onClick={() => setStopping(false)}>Keep it</button></span>
            <p className={css.hint}>Open tasks of the current steps are cancelled; finished work stays.</p></div>
            : <button type="button" className={styles.btn} onClick={() => setStopping(true)}><CircleStop size={14} aria-hidden="true" />Stop this run</button> : null}
          {data.submissions.length ? <section aria-label="Sent forms"><p className={css.sub}>Sent forms</p><SubmissionList rows={data.submissions} showForm /></section> : null}
          <p className={css.hint}><Workflow size={13} aria-hidden="true" /><Link className={css.linkBtn} href={`/sops/workflows/${r.workflowId}`}>The workflow</Link></p>
        </div>}
      </aside>
    </div>
  </div>;
}

function RunStepPanel({ step, onClose }: { step: RunStep; onClose: () => void }) {
  const router = useRouter(); const { data } = useWorkOptions(); const [giving, setGiving] = useState(false);
  async function give(personId: string) {
    try { const r = await post<{ assigned: boolean; asked: { to: string } | null }>(`workflows/steps/${step.id}/assign`, { personId }); notify({ id: "give", tone: "success", title: r.assigned ? "Given" : r.asked ? `Asked ${r.asked.to}` : "Done", timeout: 3000 }); setGiving(false); router.refresh(); }
    catch (e) { notify({ id: "give", tone: "error", title: "Not given", message: msg(e) }); }
  }
  // WORKFLOW BUILDER: a Hand-off that could not start the other tab waits here; leadership tries again once it is fixed.
  async function retry() {
    try { await post(`workflows/steps/${step.id}/retry`); notify({ id: "retry", tone: "success", title: "Handed over", timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: "retry", tone: "error", title: "Not handed over", message: msg(e) }); router.refresh(); }
  }
  const word = { waiting: "Waiting for the steps before it", active: "In progress", done: "Done", skipped: "Skipped: its branch was not taken", cancelled: "Stopped" }[step.status];
  return <div className={css.panel}>
    <div className={css.panelHead}><div><small>Step {step.position} · {KIND_LABEL[step.kind]}</small><h3>{step.title}</h3></div><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={15} aria-hidden="true" /></button></div>
    <dl className={css.facts}>
      <dt>Status</dt><dd>{word}{step.outcome ? ` · ${step.outcome}` : ""}{step.rounds > 1 ? ` · round ${step.rounds}` : ""}</dd>
      {step.person ? <><dt>Who</dt><dd><Avatar name={step.person} id={step.personId ?? undefined} photoAt={step.photoAt} size={20} />{step.person}</dd></> : step.asked ? <><dt>Asked</dt><dd>{step.askedName}, waiting for an answer</dd></> : step.pooled ? <><dt>Who</dt><dd>In the pool</dd></> : null}
      {step.why ? <><dt>Why them</dt><dd>{step.why}</dd></> : null}
      {step.dueAt ? <><dt>Due</dt><dd style={step.late ? { color: "var(--theme-danger)", fontWeight: 650 } : undefined}>{dayTime(step.dueAt)}{step.late ? " · late" : ""}</dd></> : null}
      {step.doneAt ? <><dt>Finished</dt><dd>{dayTime(step.doneAt)}</dd></> : null}
      {step.note ? <><dt>Note</dt><dd>{step.note}</dd></> : null}
    </dl>
    {step.stuck ? <p className={css.flag} data-level="warn"><CircleAlert size={12} aria-hidden="true" />{step.stuck}</p> : null}
    {step.canFill ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href={`/sops/fill/${step.id}`}><PenLine size={14} aria-hidden="true" />Fill the form</Link> : null}
    {step.canDecide && step.choices.length ? <Decide stepId={step.id} choices={step.choices} /> : null}
    {step.taskId ? <Link className={styles.btn} href={`/tasks/${step.taskId}`}><ExternalLink size={13} aria-hidden="true" />Open the task</Link> : null}
    {step.status === "active" && step.note?.startsWith("Could not hand over") ? <button type="button" className={styles.btn} onClick={() => void retry()}>Hand over again</button> : null}
    {step.status === "active" && step.taskId ? giving && data ? <div className={css.field}><span>Give it to</span><PersonPicker people={data.people} value={null} onChange={(p) => p && void give(p.id)} me={data.me} label="Give it to" showAsk autoFocus /></div>
      : <button type="button" className={styles.btn} onClick={() => setGiving(true)}>Give it to someone else</button> : null}
  </div>;
}

/** On a task page: the workflow step this task is, and the answers when it is an approval or a decision. */
export function StepBanner({ step }: { step: { id: string; runId: string; position: number; of: number; kind: string; status: string; run: string; workflow: string; canDecide: boolean; choices: string[]; formId?: string | null; canFill?: boolean } }) {
  return <div className={css.banner} role="note" aria-label="Workflow step">
    <span><Workflow size={16} aria-hidden="true" />Step {step.position} of {step.of} in <Link className={css.linkBtn} href={`/runs/${step.runId}`}>{step.workflow} · {step.run}</Link>{step.kind === "approval" && step.status === "active" ? ": an approval" : ""}</span>
    {step.canFill ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href={`/sops/fill/${step.id}`}><PenLine size={14} aria-hidden="true" />Fill the form</Link> : null}
    {step.canDecide && step.choices.length ? <Decide stepId={step.id} choices={step.choices} compact /> : null}
  </div>;
}
