"use client";
// FLOW-B: My steps. On the left, the steps open for me in every run (late first, then today, this week, later), what
// others wait on me to type in, and what is coming my way. A step opens on the right: its run and state, what it needs
// (and whose it is when it waits), its checklist, the part of the write-up that explains it, and Pip beside it (what the
// module's Pip can do: draft, critique, summarise, extract, check). Its own work screen (a document, a meeting, a media
// review) comes with each module; until then the step is moved and finished from here.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, BookOpenText, Check, CircleAlert, Clock3, ExternalLink, Hand, Play, Send, Sparkles, Workflow } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Empty, styles } from "../../ui";
import { flow, why } from "../../processes/flow-client";
import { STEP_STATE_LABELS, type IntakeItem, type ModuleManifest, type MyStep, type PipAction, type RunDetail, type RunStep } from "../../processes/flow-types";
import type { AssistResult } from "../../../../../services/api/src/ai/flow-assist";
import { KIND_SLOT, KIND_WORD, ModuleIcon } from "../../processes/builder/kinds";
import css from "./steps.module.css";

export type StepDetail = { run: Omit<RunDetail, "steps" | "values">; step: RunStep; module: ModuleManifest; settings: Record<string, unknown>; qualityTest: string[]; intake: IntakeItem[];
  sop: { processId: string | null; section: string | null; title: string | null; body: string } | null; canAct: boolean };
type Mine = { steps: MyStep[]; upcoming: MyStep[]; asked: MyStep[] };

/** FLOW-C: what each kind of step opens (its own work screen at /steps/<id>). */
const WORK_WORD: Partial<Record<ModuleManifest["surface"], string>> = { doc: "The document", meeting: "The meeting", media: "The media review", review: "The review", board: "The board", form: "The form", money: "The quote or invoice", task: "The to-do" };
const PIP_WORD: Record<PipAction, string> = { draft: "Draft it", critique: "Critique it", summarise: "Summarise", extract: "Pull out facts", check: "Check it", suggest: "Suggest" };

export function MySteps({ mine, chosen, detail, detailError }: { mine: Mine; chosen: MyStep | null; detail: StepDetail | null; detailError: string | null }) {
  const path = usePathname();
  const total = mine.steps.length + mine.asked.length + mine.upcoming.length;
  if (!total) return <Empty icon={Workflow} first title="No step is waiting for you" text="When a process gives you a step, it appears here and in My tasks, with what it needs, its checklist and Pip." action={{ href: "/processes", label: "See the processes" }} />;
  const groups: { label: string; note?: string; steps: MyStep[] }[] = [
    { label: "Late", steps: mine.steps.filter((s) => s.due.late) },
    { label: "Today", steps: mine.steps.filter((s) => !s.due.late && s.due.days === 0) },
    { label: "This week", steps: mine.steps.filter((s) => !s.due.late && s.due.days !== null && s.due.days > 0 && s.due.days <= 7) },
    { label: "Later", steps: mine.steps.filter((s) => !s.due.late && (s.due.days === null || s.due.days > 7)) },
    { label: "Asked of you", note: "Someone's step waits for what you type in or upload", steps: mine.asked },
    { label: "Coming your way", note: "Yours when their data is in", steps: mine.upcoming },
  ].filter((g) => g.steps.length);
  return <div className={css.wrap} data-open={chosen ? "" : undefined}>
    <nav className={css.list} aria-label="My steps">{groups.map((g) => <section key={g.label} aria-label={g.label}>
      <h3>{g.label}<small>{g.steps.length}</small></h3>{g.note ? <p className={css.note}>{g.note}</p> : null}
      <ul>{g.steps.map((s) => <li key={s.id}><Link href={`${path}?step=${encodeURIComponent(s.id)}`} scroll={false} className={css.item} aria-current={chosen?.id === s.id ? "page" : undefined}
        data-late={s.due.late ? "" : undefined} data-waiting={s.state === "waiting" ? "" : undefined}>
        <span className={css.itemIcon}><ModuleIcon name={s.icon} size={15} /></span>
        <span className={css.itemText}><b>{s.title}</b><small>{s.run}{s.role ? ` · as ${s.role}` : ""}{s.demo ? " · demo" : ""}</small>
          <small className={css.itemState}>{s.state === "waiting" ? s.stateText : s.due.text || STEP_STATE_LABELS[s.state]}</small></span>
      </Link></li>)}</ul></section>)}
    </nav>
    <div className={css.pane}>{chosen ? detail ? <StepWork key={detail.step.id} d={detail} mine={chosen} /> : <p className={css.note}>{detailError ?? "This step did not load."}</p>
      : <div className={css.pick}><Sparkles size={18} aria-hidden="true" /><b>Choose a step</b><span>It opens here with what it needs, its checklist, how it is done and Pip.</span></div>}</div>
  </div>;
}

function StepWork({ d, mine }: { d: StepDetail; mine: MyStep }) {
  const router = useRouter(), path = usePathname();
  const s = d.step, m = d.module;
  const [checks, setChecks] = useState<number[]>(s.checks), [busy, setBusy] = useState(false), [input, setInput] = useState("");
  const asked = mine.state === "waiting" && s.waitingFor.some((w) => !w.from);
  async function act(path2: string, body: unknown, done: string) {
    setBusy(true);
    try { await flow(path2, "POST", body); notify({ id: `step-${s.id}`, tone: "success", title: done, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: `step-${s.id}`, tone: "error", title: "That did not happen", message: why(e) }); }
    finally { setBusy(false); }
  }
  async function tick(i: number, on: boolean) {
    const before = checks; setChecks(on ? [...checks, i] : checks.filter((x) => x !== i));
    try { const r = await flow<{ checks: number[] }>(`steps/${s.id}/check`, "POST", { index: i, done: on }); setChecks(r.checks); } catch (e) { setChecks(before); notify({ id: "check", tone: "error", title: "Not ticked", message: why(e) }); }
  }
  const canWork = d.canAct && d.run.status === "running";
  const answers = m.finish === "verdict" ? (m.key === "decision" ? m.makes.map((p) => p.label) : ["Confirmed", "Changes asked"]) : [];
  return <article className={css.work} aria-label={s.title}>
    <Link className={css.back} href={path} scroll={false}><ArrowLeft size={14} aria-hidden="true" />My steps</Link>
    <header className={css.head}>
      <span className={css.headIcon}><ModuleIcon name={s.icon} size={18} /></span>
      <span><b>{s.title}</b><small><Link href={`/runs/${d.run.id}?step=${s.id}`}>{d.run.name}</Link> · {d.run.process}{s.stage ? ` · ${d.run.stages.find((g) => g.key === s.stage)?.label ?? ""}` : ""}</small></span>
    </header>
    <div className={css.status}>
      <span className={css.state} data-state={s.state}>{s.state === "waiting" || s.state === "skipped" ? s.stateText : STEP_STATE_LABELS[s.state]}</span>
      {s.due.text ? <span className={css.due} data-late={s.due.late ? "" : undefined}><Clock3 size={12} aria-hidden="true" />{s.due.text}</span> : null}
      <span className={css.module}>{m.name}{m.engine !== "live" ? ` · ${m.engine === "stub" ? "its screen comes later" : "partly built"}` : ""}</span>
    </div>

    {canWork ? <div className={css.actions}>
      {s.state === "open" ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void act(`steps/${s.id}/move`, { to: "in_progress" }, "Started")}><Play size={14} aria-hidden="true" />Start</button> : null}
      {(s.state === "open" || s.state === "in_progress") && m.finish !== "verdict" && (m.surface === "doc" || m.surface === "review" || m.surface === "media") ? <button type="button" className={styles.btn} disabled={busy}
        onClick={() => void act(`steps/${s.id}/move`, { to: "in_review" }, "Sent for review")}><Send size={14} aria-hidden="true" />Sent for review</button> : null}
      {answers.length && s.state !== "waiting" ? answers.map((a, i) => <button key={a} type="button" className={`${styles.btn} ${i === 0 ? styles.btnPrimary : ""}`} disabled={busy}
        onClick={() => void act(`steps/${s.id}/verdict`, { answer: i === 0 && m.key !== "decision" ? "confirmed" : i === 1 && m.key !== "decision" ? "changes" : a }, `${a}: recorded`)}>{a}</button>)
        : s.state !== "waiting" && m.finish !== "auto" ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void act(`steps/${s.id}/finish`, {}, "Done: whatever waited on it opens")}><Check size={14} aria-hidden="true" />Done</button> : null}
      {s.taskId ? <Link className={styles.btn} href={`/tasks/${s.taskId}`}><ExternalLink size={14} aria-hidden="true" />Its task</Link> : null}
    </div> : null}
    {s.surface !== "none" && s.state !== "skipped" ? <Link className={css.openWork} href={`/steps/${encodeURIComponent(s.id)}?from=me`}><ModuleIcon name={s.icon} size={16} />
      <span><b>Open the work</b><small>{WORK_WORD[m.surface] ?? "Its own screen"}, with the checklist, how it is done and Pip beside it</small></span><ArrowRight size={16} aria-hidden="true" /></Link> : null}

    {s.waitingFor.length ? <Block title="Waiting for">
      <ul className={css.waits}>{s.waitingFor.map((w) => <li key={w.port} data-k={KIND_SLOT[w.kind]}><i /><span><b>{w.label}</b><small>{KIND_WORD[w.kind]}{w.from ? ` · from “${w.from.title}”${w.from.who ? `, ${w.from.who.name}` : w.from.role ? `, the ${w.from.role}` : ""}` : w.owner ? ` · ${w.owner.name} brings it` : w.ownerRole ? ` · the ${w.ownerRole} brings it` : ""}</small></span>
        {w.from && canWork ? <button type="button" className={css.nudge} disabled={busy} onClick={() => void act(`steps/${s.id}/nudge`, {}, "Nudged")}><Hand size={12} aria-hidden="true" />Nudge</button> : null}</li>)}</ul>
      {asked && canWork ? <form className={css.inputRow} onSubmit={(e) => { e.preventDefault(); const w = s.waitingFor.find((x) => !x.from)!; void act(`steps/${s.id}/input`, { port: w.port, value: input.trim() }, "Added: the step can start"); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type it in, or paste a link" aria-label="What the step waits for" maxLength={4000} />
        <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !input.trim()}>Add it</button></form> : null}
    </Block> : null}

    {s.checklist.length ? <Block title={`Checklist · ${checks.length} of ${s.checklist.length}`}>
      <ul className={css.checklist}>{s.checklist.map((l, i) => <li key={i}><label><input type="checkbox" checked={checks.includes(i)} disabled={!canWork} onChange={(e) => void tick(i, e.target.checked)} />{l}</label></li>)}</ul>
    </Block> : null}
    {d.qualityTest.length ? <Block title="What good looks like"><ul className={css.quality}>{d.qualityTest.map((q, i) => <li key={i}>{q}</li>)}</ul></Block> : null}

    {d.sop ? <Block title="How it is done" aside={d.sop.section ? <Link href={`/processes/${encodeURIComponent(d.sop.processId ?? d.run.processId)}?tab=writeup#part-${d.sop.section}`}><BookOpenText size={13} aria-hidden="true" />The whole write-up</Link> : null}>
      {d.sop.title ? <b className={css.sopTitle}>{d.sop.title}</b> : null}
      <SopText body={d.sop.body} />
    </Block> : null}

    {m.pip.length ? <Pip stepId={s.id} actions={m.pip} /> : null}
    {s.alerts.length ? <Block title="Alerts"><ul className={css.alerts}>{s.alerts.map((a) => <li key={a.rule + a.at}><CircleAlert size={13} aria-hidden="true" />{a.name}</li>)}</ul></Block> : null}
  </article>;
}

function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return <section className={css.block} aria-label={title}><h4>{title}{aside ? <span>{aside}</span> : null}</h4>{children}</section>;
}

/** The write-up's part for the step: the first lines, the rest one tap away. */
function SopText({ body }: { body: string }) {
  const [all, setAll] = useState(false);
  const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const shown = all ? paras : paras.slice(0, 3);
  return <div className={css.sop}>{shown.map((p, i) => <p key={i}>{p}</p>)}{paras.length > 3 ? <button type="button" onClick={() => setAll(!all)}>{all ? "Less" : `Read all ${paras.length} paragraphs`}</button> : null}</div>;
}

/** Pip beside the step: what this module's Pip can do, grounded on the step's write-up and the run's records. Pip
 *  suggests; the person decides. */
function Pip({ stepId, actions }: { stepId: string; actions: PipAction[] }) {
  const [busy, setBusy] = useState<PipAction | null>(null), [out, setOut] = useState<{ action: PipAction; result: AssistResult } | null>(null), [text, setText] = useState("");
  async function ask(action: PipAction) {
    setBusy(action);
    try { const r = await flow<{ result: AssistResult }>(`steps/${stepId}/pip`, "POST", { action, text: text.trim() || undefined }); setOut({ action, result: r.result }); }
    catch (e) { notify({ id: "pip", tone: "error", title: "Pip could not help just now", message: why(e) }); }
    finally { setBusy(null); }
  }
  const r = out?.result;
  return <section className={css.pip} aria-label="Pip">
    <h4><span className={css.pipFace} aria-hidden="true"><Sparkles size={12} /></span>Pip<small>suggests; you decide</small></h4>
    <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste what you are working on (a draft, a transcript), or leave it empty" aria-label="What Pip works on" maxLength={120000} />
    <div className={css.pipActions}>{actions.map((a) => <button key={a} type="button" disabled={!!busy} onClick={() => void ask(a)} aria-pressed={out?.action === a}>{busy === a ? "Working…" : PIP_WORD[a]}</button>)}</div>
    {r ? <div className={css.pipOut} aria-live="polite">
      {r.summary?.length ? <List title="Summary" items={r.summary} /> : null}
      {r.followups?.length ? <List title="Follow-ups" items={r.followups} /> : null}
      {r.findings?.length ? <ul className={css.findings}>{r.findings.map((f, i) => <li key={i} data-level={f.level}><b>{f.text}</b>{f.suggestion ? <span>{f.suggestion}</span> : null}<small>{f.rule}{f.where ? ` · ${f.where}` : ""}</small></li>)}</ul> : null}
      {r.checks?.length ? <ul className={css.findings}>{r.checks.map((c, i) => <li key={i} data-level={c.verdict === "looks ok" ? "ok" : c.verdict === "missing" ? "fix" : "check"}><b>{c.test}: {c.verdict}</b><small>{c.why}</small></li>)}</ul> : null}
      {r.facts?.length ? <List title="Facts" items={r.facts.map((f) => `${f.statement}${f.source ? ` (${f.source})` : ""}`)} /> : null}
      {r.openItems?.length ? <List title="Open questions" items={r.openItems.map((o) => `${o.question} · ${o.tag}`)} /> : null}
      {r.quotes?.length ? <List title="Quotes" items={r.quotes} /> : null}
      {r.tags?.length ? <List title="Tags" items={r.tags.map((t) => `${t.tag}: ${t.line}`)} /> : null}
      {r.outline ? <pre className={css.outline}>{r.outline}</pre> : null}
      {r.basis?.length ? <p className={css.basis}>Based on: {r.basis.join(" · ")}</p> : null}
    </div> : null}
  </section>;
}
const List = ({ title, items }: { title: string; items: string[] }) => <div><b className={css.listTitle}>{title}</b><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>;
