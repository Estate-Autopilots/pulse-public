"use client";
// FLOW-C: the frame every step's work screen shares. The work in the middle (a document, a meeting, a review …, chosen by
// the step's module); beside it the step itself: who and when, what it waits for, its checklist, what good looks like,
// Pip, and the part of the write-up that explains it. On a phone the four are tabs over one column. Finishing the work
// on the screen fills the step's Makes, and whatever waited for them opens.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { BookOpenText, CircleAlert, Clock3, ExternalLink, Hand, ListChecks, PenLine, Sparkles } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Avatar, styles } from "../ui";
import { flow, why } from "../processes/flow-client";
import { STEP_STATE_LABELS, type FlowRecord, type PersonRef, type RecordType } from "../processes/flow-types";
import type { FillForm } from "../sops/types";
import { KIND_SLOT, KIND_WORD, ModuleIcon } from "../processes/builder/kinds";
import { PipPanel, type PipFocus } from "./pip";
import { screenOf, dayText, type RecordDetail, type StepDetail } from "./types";
import { Surface } from "./surfaces";
import css from "./work.module.css";

/** What a work screen gets: the step, its record, the run's records and record types, and how to act on it. */
export type Work = {
  d: StepDetail; rec: RecordDetail | null; runRecords: FlowRecord[]; types: RecordType[];
  /** The person may act and the step is open: the screen is editable. */
  live: boolean;
  /** POST to the flow API; tells the person, refreshes the page's data, answers the API's reply (null when it failed). */
  act: <T = Record<string, unknown>>(path: string, body: unknown, done?: string | null) => Promise<T | null>;
  busy: boolean;
  /** Point Pip at what the person is working on (a section, a tab, the transcript). */
  focus: (f: PipFocus | null) => void;
  /** A Collect step's form, ready to fill; who can be named for each role (an Assign step). */
  form: FillForm | null; holders: Record<string, PersonRef[]>;
};

type Pane = "work" | "step" | "pip" | "how";

export function StepWork({ d, rec, runRecords, types, form = null, holders = {} }: { d: StepDetail; rec: RecordDetail | null; runRecords: FlowRecord[]; types: RecordType[]; form?: FillForm | null; holders?: Record<string, PersonRef[]> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [pane, setPane] = useState<Pane>("work"), [focus, setFocus] = useState<PipFocus | null>(null);
  const s = d.step, live = d.canAct && d.run.status === "running" && !["done", "skipped", "waiting"].includes(s.state);
  async function act<T = Record<string, unknown>>(path: string, body: unknown, done?: string | null): Promise<T | null> {
    setBusy(true);
    try {
      const r = await flow<T>(path, "POST", body ?? {});
      if (done) notify({ id: `step-${s.id}`, tone: "success", title: done, timeout: 2600 });
      router.refresh();
      return r;
    } catch (e) { notify({ id: `step-${s.id}`, tone: "error", title: "That did not happen", message: why(e) }); return null; }
    finally { setBusy(false); }
  }
  const w: Work = { d, rec, runRecords, types, live, act, busy, focus: setFocus, form, holders };
  const screen = screenOf(s.module);
  const panes: { key: Pane; label: string; icon: ReactNode }[] = [
    { key: "work", label: "Work", icon: <ModuleIcon name={s.icon} size={14} /> }, { key: "step", label: "Checklist", icon: <ListChecks size={14} aria-hidden="true" /> },
    { key: "pip", label: "Pip", icon: <Sparkles size={14} aria-hidden="true" /> }, { key: "how", label: "How", icon: <BookOpenText size={14} aria-hidden="true" /> },
  ];
  return <div className={css.work} data-pane={pane} data-screen={screen}>
    <div className={css.panes} role="tablist" aria-label="This step">{panes.map((p) => <button key={p.key} type="button" role="tab" aria-selected={pane === p.key} onClick={() => setPane(p.key)}>{p.icon}{p.label}</button>)}</div>
    <div className={css.main} data-p="work">
      <StepBar w={w} />
      <Surface screen={screen} w={w} />
    </div>
    <aside className={css.rail} aria-label="The step">
      <div data-p="step"><AboutStep w={w} /></div>
      <div data-p="pip">{d.module.pip.length ? <PipPanel stepId={s.id} actions={d.module.pip} focus={focus} /> : <p className={css.quiet}>Pip has no tools for this kind of step.</p>}</div>
      <div data-p="how"><HowItIsDone d={d} /></div>
    </aside>
  </div>;
}

/** Where the step stands: its state in words, when it is due, what it waits for (Nudge, or type it in when it is asked
 *  of you) and, once it is done, when. */
function StepBar({ w }: { w: Work }) {
  const { d } = w, s = d.step;
  const [input, setInput] = useState("");
  const asked = s.state === "waiting" && d.canAct && s.waitingFor.some((x) => !x.from);
  return <div className={css.bar}>
    <div className={css.barTop}>
      <span className={css.state} data-state={s.state}>{s.state === "waiting" || s.state === "skipped" ? s.stateText : STEP_STATE_LABELS[s.state]}</span>
      {s.due.text && s.state !== "done" && s.state !== "skipped" ? <span className={css.due} data-late={s.due.late ? "" : undefined}><Clock3 size={12} aria-hidden="true" />{s.due.text}</span> : null}
      {s.doneAt ? <span className={css.due}>{dayText(s.doneAt)}</span> : null}
      {s.rounds > 1 ? <span className={css.due}>{s.rounds - 1} round{s.rounds > 2 ? "s" : ""} of changes</span> : null}
      {d.module.engine !== "live" ? <span className={css.honest} title={d.module.status}>Partly built</span> : null}
      {s.taskId ? <Link className={css.taskLink} href={`/tasks/${s.taskId}`}><ExternalLink size={12} aria-hidden="true" />Its task</Link> : null}
    </div>
    {s.blocked ? <p className={css.blocked}><CircleAlert size={14} aria-hidden="true" />Blocked since {dayText(s.blocked.since)}{s.blocked.note ? `: ${s.blocked.note}` : ""}</p> : null}
    {s.state === "waiting" && s.waitingFor.length ? <ul className={css.waits}>{s.waitingFor.map((x) => <li key={x.port} data-k={KIND_SLOT[x.kind]}><i />
      <span><b>{x.label}</b><small>{KIND_WORD[x.kind]}{x.from ? ` · from “${x.from.title}”${x.from.who ? `, ${x.from.who.name}` : x.from.role ? `, the ${x.from.role}` : ""}` : x.owner ? ` · ${x.owner.name} brings it` : x.ownerRole ? ` · the ${x.ownerRole} brings it` : ""}</small></span>
      {x.from && d.canAct && d.run.status === "running" ? <button type="button" className={css.nudge} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/nudge`, {}, "Nudged")}><Hand size={12} aria-hidden="true" />Nudge</button> : null}</li>)}</ul> : null}
    {asked ? <form className={css.inputRow} onSubmit={(e) => { e.preventDefault(); const x = s.waitingFor.find((y) => !y.from)!; void w.act(`steps/${s.id}/input`, { port: x.port, value: input.trim() }, "Added: the step can start"); }}>
      <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type it in, or paste a link" aria-label="What the step waits for" maxLength={4000} />
      <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || !input.trim()}>Add it</button></form> : null}
    {s.state === "waiting" && !s.waitingFor.length ? <p className={css.quiet}>It opens when the steps before it are done.</p> : null}
    {!d.canAct && d.run.status === "running" && s.state !== "done" ? <p className={css.quiet}>You can read this step. Its person, the run&apos;s people and leadership work on it.</p> : null}
  </div>;
}

/** The step itself: what it is, who has it, what finishing it fills, its checklist and what good looks like. */
function AboutStep({ w }: { w: Work }) {
  const { d } = w, s = d.step;
  const [checks, setChecks] = useState<number[]>(s.checks);
  const canTick = d.canAct && d.run.status === "running" && s.state !== "waiting" && s.state !== "skipped";
  async function tick(i: number, on: boolean) {
    const before = checks; setChecks(on ? [...checks, i] : checks.filter((x) => x !== i));
    try { const r = await flow<{ checks: number[] }>(`steps/${s.id}/check`, "POST", { index: i, done: on }); setChecks(r.checks); }
    catch (e) { setChecks(before); notify({ id: "check", tone: "error", title: "Not ticked", message: why(e) }); }
  }
  return <>
    <section className={css.block} aria-label="Who and what">
      <p className={css.who}>{s.who ? <><Avatar name={s.who.name} id={s.who.id} photoAt={s.who.photoAt ?? null} size={26} /><span><b>{s.who.name}</b><small>{s.role ?? "Does this step"}</small></span></>
        : <><span className={css.nobody} /><span><b>{s.role ? `The ${s.role}` : "Nobody yet"}</b><small>nobody named on this run</small></span></>}</p>
      <p className={css.what}>{d.module.summary}</p>
      {s.makes.length ? <ul className={css.makes} aria-label="Finishing it fills">{s.makes.map((p) => <li key={p.key} data-k={KIND_SLOT[p.kind]} data-filled={p.filled ? "" : undefined}><i />{p.label}<small>{p.filled ? "made" : p.required === false ? "if any" : "made here"}</small></li>)}</ul> : null}
      {s.alerts.length ? <ul className={css.alerts}>{s.alerts.map((a) => <li key={a.rule + a.at}><CircleAlert size={13} aria-hidden="true" />{a.name}<small>{dayText(a.at)}</small></li>)}</ul> : null}
    </section>
    {s.checklist.length ? <section className={css.block} aria-label="Checklist">
      <h4>Checklist<small>{checks.length} of {s.checklist.length}</small></h4>
      <ul className={css.checklist}>{s.checklist.map((l, i) => <li key={i}><label><input type="checkbox" checked={checks.includes(i)} disabled={!canTick} onChange={(e) => void tick(i, e.target.checked)} />{l}</label></li>)}</ul>
    </section> : null}
    {d.qualityTest.length ? <section className={css.block} aria-label="What good looks like"><h4>What good looks like</h4><ul className={css.quality}>{d.qualityTest.map((q, i) => <li key={i}>{q}</li>)}</ul></section> : null}
  </>;
}

/** The part of the write-up that explains the step: the first paragraphs, the rest one tap away. */
function HowItIsDone({ d }: { d: StepDetail }) {
  const [all, setAll] = useState(false);
  if (!d.sop) return <section className={css.block} aria-label="How it is done"><h4>How it is done</h4><p className={css.quiet}>This step has no part of the write-up yet. Leadership links one in the process&apos;s builder.</p></section>;
  const paras = d.sop.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const shown = all ? paras : paras.slice(0, 4);
  return <section className={css.block} aria-label="How it is done">
    <h4>How it is done{d.sop.section ? <Link href={`/processes/${encodeURIComponent(d.sop.processId ?? d.run.processId)}?tab=writeup#part-${d.sop.section}`}><PenLine size={12} aria-hidden="true" />The write-up</Link> : null}</h4>
    {d.sop.title ? <b className={css.sopTitle}>{d.sop.title}</b> : null}
    <div className={css.sop}>{shown.map((p, i) => <p key={i}>{p}</p>)}</div>
    {paras.length > 4 ? <button type="button" className={css.more} onClick={() => setAll(!all)}>{all ? "Less" : `Read all ${paras.length} paragraphs`}</button> : null}
  </section>;
}
