"use client";
// FLOW-B: one run of a process (one client or project). Pip's line on top (what is late, what is due next, what it waits
// on and from whom); where it stands; the critical inputs when the process has a sprint clock; then its steps by stage
// (columns) or by date. Each step says its state in words ("Waiting for the brochure from Vikram"), who has it and when
// it is due, with Nudge where it waits on someone. A step opens beside the board: what it needs and makes, its
// checklist, the part of the write-up that explains it, its alerts and its dates.
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, BellRing, BookOpenText, Check, CircleAlert, CircleDashed, Clock3, ExternalLink, Hand, Inbox, Sparkles, Users } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Drawer, DrawerFooter, DrawerSection } from "../kit";
import { Avatar, styles } from "../ui";
import { flow, why } from "../processes/flow-client";
import type { PersonRef, RunDetail, RunStep, StepState } from "../processes/flow-types";
import { KIND_SLOT, KIND_WORD, ModuleIcon } from "../processes/builder/kinds";
import css from "./run.module.css";
import { SelectField } from "../kit/select-field";

const STATE: Record<StepState, { word: string; tone: string }> = {
  waiting: { word: "Waiting for data", tone: "wait" }, open: { word: "Open", tone: "open" }, in_progress: { word: "In progress", tone: "doing" }, in_review: { word: "Sent for review", tone: "review" },
  confirmed: { word: "Confirmed", tone: "ok" }, done: { word: "Done", tone: "done" }, skipped: { word: "Skipped", tone: "skip" },
};

export function FlowRun({ run, holders }: { run: RunDetail; holders: Record<string, PersonRef[]> }) {
  const router = useRouter(), path = usePathname(), params = useSearchParams();
  const [view, setView] = useState<"stages" | "dates">("stages");
  const [checks, setChecks] = useState<Record<string, number[]>>({});
  const open = params.get("step");
  const step = run.steps.find((s) => s.id === open || s.key === open) ?? null;
  const show = (s: RunStep | null) => router.replace(s ? `${path}?step=${encodeURIComponent(s.id)}` : path, { scroll: false });
  const c = run.counts;
  const lanes = useMemo(() => {
    const keyed = run.stages.map((g) => ({ key: g.key, label: g.label, steps: run.steps.filter((s) => s.stage === g.key) }));
    const loose = run.steps.filter((s) => !s.stage || !run.stages.some((g) => g.key === s.stage));
    return [...(loose.length ? [{ key: "", label: run.stages.length ? "Other steps" : "Steps", steps: loose }] : []), ...keyed].filter((l) => l.steps.length);
  }, [run.steps, run.stages]);

  async function nudge(s: RunStep) {
    try { await flow(`steps/${s.id}/nudge`, "POST", {}); notify({ id: `nudge-${s.id}`, tone: "success", title: "Nudged", message: `${who(s.waitingFor[0]?.from?.who?.name ?? s.waitingFor[0]?.owner?.name) ?? "Whoever owes the data"} has a reminder.`, timeout: 3000 }); }
    catch (e) { notify({ id: `nudge-${s.id}`, tone: "error", title: "Not nudged", message: why(e) }); }
  }
  // Name who holds a role on this run: their open steps of that role (with nobody) move to them, with a task.
  async function nameRole(role: string, personId: string) {
    try { await flow(`runs/${run.id}/people`, "POST", { role, personId }); notify({ id: `role-${role}`, tone: "success", title: "Named", message: "Their open steps of that role are with them now.", timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: `role-${role}`, tone: "error", title: "Not named", message: why(e) }); }
  }
  async function tick(s: RunStep, i: number, on: boolean) {
    const before = checks[s.id] ?? s.checks; setChecks({ ...checks, [s.id]: on ? [...before, i] : before.filter((x) => x !== i) });
    try { const r = await flow<{ checks?: number[] }>(`steps/${s.id}/check`, "POST", { index: i, done: on }); if (r.checks) setChecks((x) => ({ ...x, [s.id]: r.checks! })); }
    catch (e) { setChecks((x) => ({ ...x, [s.id]: before })); notify({ id: "check", tone: "error", title: "Not ticked", message: why(e) }); }
  }

  return <div className={css.run}>
    <p className={css.pip} data-tone={c.late ? "late" : run.status === "done" ? "done" : undefined}><span className={css.pipFace} aria-hidden="true"><Sparkles size={14} /></span>{run.pip}</p>
    <div className={css.facts}>
      <Fact label={run.day ? `Day ${run.day}` : "Day 1 not yet"} sub={run.day1 ? `Day 1 was ${dayText(run.day1)}` : "Starts when the inputs are in"} />
      <Fact label={`${c.done} of ${c.total - c.skipped}`} sub="steps done" bar={(c.total - c.skipped) ? c.done / (c.total - c.skipped) : 0} />
      <Fact label={String(c.open)} sub="open now" />
      <Fact label={String(c.waiting)} sub="waiting for data" tone={c.waiting ? "wait" : undefined} />
      <Fact label={String(c.late)} sub={c.late === 1 ? "step late" : "steps late"} tone={c.late ? "late" : undefined} />
      {run.alerts.length ? <Fact label={String(run.alerts.length)} sub={run.alerts.length === 1 ? "alert" : "alerts"} tone="late" /> : null}
    </div>

    {run.intake.length && run.intake.every((i) => i.receivedOn || !i.critical) ? <details className={css.intake}>
      <summary><Inbox size={14} aria-hidden="true" /><b>{run.intake.filter((i) => i.receivedOn).length === run.intake.length ? `All ${run.intake.length} inputs are in` : "Every critical input is in"}</b>
        <small>{run.day1 ? `Day 1 was ${dayText(run.day1)}` : ""}</small><em>Show them</em></summary>
      <ul>{run.intake.map((i) => <li key={i.key} data-in={i.receivedOn ? "" : undefined}>{i.receivedOn ? <Check size={13} aria-hidden="true" /> : <CircleDashed size={13} aria-hidden="true" />}<span>{i.label}</span>
        <small>{i.receivedOn ? dayText(i.receivedOn) : "not in yet"}</small></li>)}</ul>
    </details> : run.intake.length ? <section className={css.intake} aria-label="Critical inputs">
      <h3><Inbox size={14} aria-hidden="true" />Inputs{run.day1 ? "" : <small>Day 1 starts when the critical ones are in</small>}</h3>
      <ul>{run.intake.map((i) => <li key={i.key} data-in={i.receivedOn ? "" : undefined} data-critical={i.critical ? "" : undefined}>
        {i.receivedOn ? <Check size={13} aria-hidden="true" /> : <CircleDashed size={13} aria-hidden="true" />}<span>{i.label}</span>
        <small>{i.receivedOn ? dayText(i.receivedOn) : i.owner ? `from the ${roleWord(run, i.owner)}` : "not in yet"}</small></li>)}</ul>
    </section> : null}

    <div className={css.bar}>
      <div className={css.switch} role="group" aria-label="Show the steps">
        <button type="button" aria-pressed={view === "stages"} onClick={() => setView("stages")}>By stage</button>
        <button type="button" aria-pressed={view === "dates"} onClick={() => setView("dates")}>By date</button>
      </div>
      <span className={css.legend}>{(["waiting", "open", "in_progress", "in_review", "done"] as StepState[]).map((k) => <span key={k} data-tone={STATE[k].tone}><i />{STATE[k].word}</span>)}</span>
    </div>

    {view === "stages" ? <div className={css.lanes}>{lanes.map((l) => {
      const done = l.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
      return <section key={l.key || "loose"} className={css.lane} aria-label={l.label}>
        <header><b>{l.label}</b><small>{done === l.steps.length ? "All done" : `${done} of ${l.steps.length}`}</small></header>
        <ol>{l.steps.map((s) => <li key={s.id}><StepCard s={s} run={run} onOpen={() => show(s)} onNudge={() => void nudge(s)} /></li>)}</ol>
      </section>;
    })}</div> : <ByDate run={run} onOpen={show} onNudge={(s) => void nudge(s)} />}

    <div className={css.below}>
      {run.alerts.length ? <section className={css.box} aria-label="Alerts"><h3><BellRing size={14} aria-hidden="true" />Alerts</h3>
        <ul className={css.alerts}>{run.alerts.map((a) => { const s = run.steps.find((x) => x.key === a.step);
          return <li key={a.key}><b>{a.name}</b><small>{s ? <button type="button" onClick={() => show(s)}>{s.title}</button> : null}{s ? " · " : ""}{dayText(a.at)}{a.notified.length ? ` · told ${a.notified.join(", ")}` : ""}</small></li>; })}</ul></section> : null}
      <section className={css.box} aria-label="People"><h3><Users size={14} aria-hidden="true" />Who is on it</h3>
        <ul className={css.people}>{run.roles.map((r) => { const p = run.people[r.key]; const name = p && "name" in p ? p.name : null;
          const pick = run.canEdit && run.mode === "live" && run.status === "running" && (holders[r.key] ?? []).length > 0;
          return <li key={r.key}>{name ? <Avatar name={name} id={p && "id" in p ? p.id : undefined} photoAt={p && "photoAt" in p ? p.photoAt : null} size={24} /> : <span className={css.nobody} />}
            <span>{pick ? <SelectField className={css.pick} aria-label={`Who is the ${r.label}`} value={p && "id" in p ? p.id : ""} onChange={(e) => { if (e.target.value) void nameRole(r.key, e.target.value); }}>
              {!name ? <option value="">Name someone</option> : null}{(holders[r.key] ?? []).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</SelectField> : <b>{name ?? "Nobody named"}</b>}<small>{r.label}</small></span></li>; })}</ul></section>
    </div>

    {step ? <StepDrawer s={step} run={run} checks={checks[step.id] ?? step.checks} onTick={(i, on) => void tick(step, i, on)} onClose={() => show(null)} onNudge={() => void nudge(step)} /> : null}
  </div>;
}

function Fact({ label, sub, tone, bar }: { label: string; sub: string; tone?: string; bar?: number }) {
  return <div className={css.fact} data-tone={tone}><b>{label}</b><small>{sub}</small>{bar !== undefined ? <span className={css.factBar}><i style={{ width: `${Math.round(bar * 100)}%` }} /></span> : null}</div>;
}

function StepCard({ s, run, onOpen, onNudge }: { s: RunStep; run: RunDetail; onOpen: () => void; onNudge: () => void }) {
  const st = STATE[s.state], person = s.who?.name ?? null;
  return <div className={css.step} data-tone={st.tone} data-late={s.due.late ? "" : undefined}>
    <button type="button" className={css.stepMain} onClick={onOpen} aria-label={`${s.title}: ${s.stateText}`}>
      <span className={css.stepTop}><span className={css.stepIcon}><ModuleIcon name={s.icon} size={14} /></span><b>{s.title}</b>{s.alerts.length ? <BellRing className={css.alertDot} size={13} aria-label={`${s.alerts.length} alert`} /> : null}</span>
      <span className={css.state} data-tone={st.tone}>{s.state === "waiting" || s.state === "skipped" ? s.stateText : st.word}</span>
      <span className={css.stepMeta}>
        {person ? <span className={css.who}><Avatar name={person} id={s.who?.id} photoAt={s.who?.photoAt ?? null} size={18} />{first(person)}</span> : s.role ? <span className={css.who}><span className={css.nobody} />{s.role}</span> : null}
        {s.due.text && s.state !== "skipped" ? <span className={css.due} data-late={s.due.late ? "" : undefined}><Clock3 size={11} aria-hidden="true" />{s.due.text.split(" · ")[0]}</span> : null}
      </span>
    </button>
    {s.state === "waiting" && s.waitingFor.length && run.status === "running" ? <button type="button" className={css.nudge} onClick={onNudge}><Hand size={12} aria-hidden="true" />Nudge {who(s.waitingFor[0].from?.who?.name ?? s.waitingFor[0].owner?.name) ?? "them"}</button> : null}
  </div>;
}

function ByDate({ run, onOpen, onNudge }: { run: RunDetail; onOpen: (s: RunStep) => void; onNudge: (s: RunStep) => void }) {
  const live = run.steps.filter((s) => s.state !== "skipped");
  const groups: { label: string; steps: RunStep[] }[] = [
    { label: "Late", steps: live.filter((s) => s.due.late) },
    { label: "Due in the next 7 days", steps: live.filter((s) => !s.due.late && s.state !== "done" && s.due.days !== null && s.due.days <= 7) },
    { label: "Later", steps: live.filter((s) => !s.due.late && s.state !== "done" && s.due.days !== null && s.due.days > 7) },
    { label: "No date yet", steps: live.filter((s) => s.state !== "done" && s.due.days === null) },
    { label: "Done", steps: live.filter((s) => s.state === "done") },
  ].map((g) => ({ ...g, steps: [...g.steps].sort((a, z) => (a.due.on ?? "9") < (z.due.on ?? "9") ? -1 : 1) })).filter((g) => g.steps.length);
  return <div className={css.dates}>{groups.map((g) => <section key={g.label} aria-label={g.label}><h3>{g.label}<small>{g.steps.length}</small></h3>
    <ul>{g.steps.map((s) => <li key={s.id}><StepCard s={s} run={run} onOpen={() => onOpen(s)} onNudge={() => onNudge(s)} /></li>)}</ul></section>)}</div>;
}

function StepDrawer({ s, run, checks, onTick, onClose, onNudge }: { s: RunStep; run: RunDetail; checks: number[]; onTick: (i: number, on: boolean) => void; onClose: () => void; onNudge: () => void }) {
  const st = STATE[s.state], stage = run.stages.find((g) => g.key === s.stage)?.label;
  const dates = [["Opened", s.openedAt], ["Started", s.startedAt], ["Sent for review", s.sentAt], ["Confirmed", s.confirmedAt], ["Done", s.doneAt]].filter(([, v]) => v) as [string, string][];
  return <Drawer title={s.title} onClose={onClose} size="md" icon={<ModuleIcon name={s.icon} size={18} />} context={<span className={css.ctx}>{s.moduleName}{stage ? ` · ${stage}` : ""}</span>}
    footer={<DrawerFooter>
      {s.surface !== "none" && s.state !== "skipped" ? <Link className={`${styles.btn} ${s.state === "waiting" ? "" : styles.btnPrimary}`} href={`/steps/${encodeURIComponent(s.id)}`}><ArrowRight size={14} aria-hidden="true" />Open the work</Link> : null}
      {s.taskId ? <Link className={styles.btn} href={`/tasks/${s.taskId}`}><ExternalLink size={14} aria-hidden="true" />Open its task</Link> : null}
      {s.state === "waiting" && s.waitingFor.length && run.status === "running" ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onNudge}><Hand size={14} aria-hidden="true" />Nudge {who(s.waitingFor[0].from?.who?.name ?? s.waitingFor[0].owner?.name) ?? "them"}</button> : null}
    </DrawerFooter>}>
    <div className={css.vars}>
    <DrawerSection>
      <div className={css.dState}><span className={css.state} data-tone={st.tone}>{st.word}</span>{s.due.text ? <span className={css.due} data-late={s.due.late ? "" : undefined}><Clock3 size={12} aria-hidden="true" />{s.due.text}</span> : null}</div>
      <p className={css.dWho}>{s.who ? <><Avatar name={s.who.name} id={s.who.id} photoAt={s.who.photoAt ?? null} size={22} /><b>{s.who.name}</b>{s.role ? <small>{s.role}</small> : null}</> : <><span className={css.nobody} /><b>{s.role ? `The ${s.role}` : "Nobody yet"}</b><small>no one named on this run</small></>}</p>
      {s.blocked ? <p className={css.blocked}><CircleAlert size={14} aria-hidden="true" />Blocked since {dayText(s.blocked.since)}{s.blocked.note ? `: ${s.blocked.note}` : ""}</p> : null}
      {s.skippedWhy ? <p className={css.muted}>{s.skippedWhy}</p> : null}
    </DrawerSection>
    {s.waitingFor.length ? <DrawerSection title="Waiting for">
      <ul className={css.waits}>{s.waitingFor.map((w) => <li key={w.port} data-k={KIND_SLOT[w.kind]}><i /><span><b>{w.label}</b><small>{KIND_WORD[w.kind]}{w.from ? ` · from “${w.from.title}”` : ""}{w.from?.who ? `, ${w.from.who.name}` : w.from?.role ? `, the ${w.from.role}` : w.owner ? ` · ${w.owner.name} brings it` : w.ownerRole ? ` · the ${w.ownerRole} brings it` : ""}</small></span></li>)}</ul>
    </DrawerSection> : null}
    <DrawerSection title="Needs and makes">
      <ul className={css.ports}>{s.needs.map((p) => <li key={`n${p.key}`} data-k={KIND_SLOT[p.kind]} data-filled={p.filled ? "" : undefined}><i />{p.label}<small>{p.filled ? "in" : p.required ? "needed" : "optional"}</small></li>)}
        {s.makes.map((p) => <li key={`m${p.key}`} data-k={KIND_SLOT[p.kind]} data-filled={p.filled ? "" : undefined} data-make=""><i />{p.label}<small>{p.filled ? "made" : "makes"}</small></li>)}</ul>
    </DrawerSection>
    {s.checklist.length ? <DrawerSection title={`Checklist · ${checks.length} of ${s.checklist.length}`}>
      <ul className={css.checklist}>{s.checklist.map((l, i) => <li key={i}><label><input type="checkbox" checked={checks.includes(i)} disabled={run.status !== "running"} onChange={(e) => onTick(i, e.target.checked)} />{l}</label></li>)}</ul>
    </DrawerSection> : null}
    {s.sop?.section ? <DrawerSection title="How it is done">
      <Link className={css.sop} href={`/processes/${encodeURIComponent(s.sop.processId ?? run.processId)}?tab=writeup#part-${s.sop.section}`}><BookOpenText size={14} aria-hidden="true" />{s.sop.title ?? "Its part of the write-up"}</Link>
    </DrawerSection> : null}
    {s.alerts.length ? <DrawerSection title="Alerts"><ul className={css.alerts}>{s.alerts.map((a) => <li key={a.rule + a.at}><b>{a.name}</b><small>{dayText(a.at)}</small></li>)}</ul></DrawerSection> : null}
    {dates.length || s.rounds > 1 ? <DrawerSection title="When"><dl className={css.when}>{dates.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{dayText(v)}</dd></div>)}
      {s.rounds > 1 ? <div><dt>Rounds of changes</dt><dd>{s.rounds - 1}</dd></div> : null}</dl></DrawerSection> : null}
    </div>
  </Drawer>;
}

const first = (name: string) => name.split(" ")[0];
const who = (name: string | null | undefined) => name ? first(name) : null;
const roleWord = (run: RunDetail, key: string) => run.roles.find((r) => r.key === key)?.label ?? key;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dayText(iso: string) { const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso); return Number.isNaN(d.getTime()) ? iso : `${WEEK[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`; }
