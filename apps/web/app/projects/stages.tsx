import Link from "next/link";
import { StripeCard } from "../components/work-kit";
import { CircleCheck, LayoutTemplate, UserRound } from "lucide-react";
import { api } from "../lib/api";
import { plural } from "../lib/format";
import { Empty, Panel } from "../ui";
import { DelayActions, DelayAnswer, StageOwnerPick, StarterPick, type StarterLite } from "./stages-client";
import css from "./stages.module.css";

/** PROJECTS-STAGES (owner, 4 Nov 2026; Kazuk's 3 Nov meeting B1-B9, migration 1485): the server parts of projects run in
 *  stages. The starter offer for a company with no delivery template, the journey (each stage with its owner, work and
 *  dates), late work with its reasons for whoever acts on it, the doer's question on a late task, and each person's load. */
export type Delay = { id: string; taskId: string; title: string; projectId: string; project: string; dueOn: string; daysLate: number; whoId: string; who: string | null;
  reason: string | null; reasonLabel: string | null; note: string | null; canBy: string | null; answeredAt: string | null; askedAt: string; action: string | null; actedAt: string | null;
  chases: number; escalatedId: string | null; escalated: string | null; stage: number | null; canAct: boolean; mine: boolean; needsMe: boolean };
export type Delays = { reasons: Record<string, string>; toAct: Delay[]; mine: Delay[]; all?: Delay[] };
type Starters = { pack: string | null; templates: number; canAdopt: boolean; starters: StarterLite[] };

const short = (d: string | null) => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }) : "—";
const ago = (iso: string, today: string) => { const n = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(iso.slice(0, 10) + "T00:00:00Z")) / 86400000)); return n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`; };

/** B7/B8: a company without a delivery template chooses one from the starters for its industry. */
export async function StarterCallout({ projectId, compact }: { projectId?: string; compact?: boolean }) {
  const r = (await api<Starters>(`projects/starters${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`)).data;
  if (!r || r.templates > 0 || !r.canAdopt || !r.starters.length) return null;
  return <section className={css.starterCallout} aria-label="Choose how projects run">
    <div><b><LayoutTemplate size={15} aria-hidden="true" /> Run {projectId ? "this project" : "your projects"} in stages</b>
      <span>Pick the template closest to how your company delivers. Pulse lays out its stages and steps from each project&apos;s kick-off; you can rename anything later.</span></div>
    {compact ? null : <StarterPick starters={r.starters} projectId={projectId} />}
  </section>;
}

type JTask = { id: string; step: string | null; phase: string | null; status: string; due: string | null; start: string | null };
const DONE = new Set(["done", "accepted"]);
/** B1: the project's journey, one row per stage: its owner (the stage's manager), its work done and late, its dates. */
export function Journey({ projectId, stages, tasks, current, owners, canRun, today, stageOf }: { projectId: string; stages: { n: number; label: string }[]; tasks: JTask[]; current: number;
  owners: { stage: number; id: string; name: string }[]; canRun: boolean; today: string; stageOf: (t: JTask) => number | null }) {
  return <ol className={css.journey} aria-label="Stages">{stages.map((s) => {
    const mine = tasks.filter((t) => t.status !== "cancelled" && stageOf(t) === s.n);
    const done = mine.filter((t) => DONE.has(t.status)).length, late = mine.filter((t) => !DONE.has(t.status) && t.due && t.due < today).length;
    const starts = mine.map((t) => t.start ?? t.due).filter(Boolean).sort() as string[], ends = mine.map((t) => t.due).filter(Boolean).sort() as string[];
    const o = owners.find((x) => x.stage === s.n) ?? null;
    // Done only when its work is finished; a stage the project moved past whose tasks the viewer cannot open reads "Passed"
    // (row security: a member sees only the work they may open, so "Done · No tasks yet" would be wrong).
    const state = mine.length > 0 && done === mine.length ? "done" : s.n === current ? "now" : s.n < current ? "passed" : "later";
    return <li key={s.n} className={css.jrow} data-state={state}>
      <span className={css.jNo} aria-hidden="true">{state === "done" ? "✓" : s.n}</span>
      <span className={css.jName}><b>{s.label}</b><small>{{ now: "Now", done: "Done", passed: "Passed", later: "Later" }[state]} · stage {s.n}</small></span>
      <span className={css.jOwner}>{canRun ? <StageOwnerPick projectId={projectId} stage={s.n} label={s.label} ownerId={o?.id ?? null} owner={o?.name ?? null} />
        : <span className={css.ownerName}><UserRound size={13} aria-hidden="true" />{o?.name ?? "No owner"}</span>}</span>
      <span className={css.jWork}>{mine.length ? <><b>{done}</b> of {mine.length} done{late ? <span data-late=""> · {late} late</span> : null}</> : "No tasks yet"}</span>
      <span className={css.jDates}>{starts.length ? `${short(starts[0])} → ${short(ends.at(-1) ?? null)}` : mine.length ? "No dates" : ""}</span>
    </li>; })}</ol>;
}

function DelayRow({ d, today, showProject }: { d: Delay; today: string; showProject?: boolean }) {
  const why = d.reasonLabel ? <><b>{d.reasonLabel}</b>{d.note ? `: ${d.note}` : ""}{d.canBy ? ` · can be done by ${short(d.canBy)}` : ""}</> : null;
  const state = d.action === "chased" ? ` · chased ${ago(d.actedAt ?? d.askedAt, today)}` : d.action === "escalated" ? ` · escalated to ${d.escalated ?? "someone"}` : "";
  // UX-WORK (owner, 5 Nov 2026): each late task is a striped card: red until its doer says why, amber once they have.
  return <StripeCard as="li" className={css.delay} tone={d.answeredAt ? "warn" : "bad"}>
    <div className={css.delayHead}><Link href={`/tasks/${d.taskId}`}>{d.title}</Link><span className={css.lateBy}>{d.daysLate} {d.daysLate === 1 ? "day" : "days"} late</span></div>
    <p className={css.delayWhy} data-none={why ? undefined : ""}>{d.who ?? "Nobody"}{showProject ? <> · <Link href={`/tasks/projects/${d.projectId}`}>{d.project}</Link></> : null} · {why ?? `asked ${ago(d.askedAt, today)}, no answer yet`}{state}</p>
    {d.canAct && d.needsMe ? <DelayActions delay={{ id: d.id, title: d.title, who: d.who, daysLate: d.daysLate, canBy: d.canBy, answeredAt: d.answeredAt, action: d.action, dueOn: d.dueOn }} today={today} /> : null}
  </StripeCard>;
}

/** B4/B5 on a project's page: every late task with its reason; the lead and stage owners act from here. */
export async function ProjectDelays({ projectId, today }: { projectId: string; today: string }) {
  const r = (await api<Delays>(`projects/delays?project=${encodeURIComponent(projectId)}`)).data;
  const all = r?.all ?? [];
  if (!all.length) return null;
  const answered = all.filter((d) => d.answeredAt).length;
  return <Panel title="Late work" sub={`${plural(all.length, "task")} · ${answered} with a reason`}>
    <ul className={css.delays}>{all.map((d) => <DelayRow key={d.id} d={d} today={today} />)}</ul>
  </Panel>;
}

/** B5 on Work → Projects: late work waiting on the viewer to act, and the viewer's own late work to explain. */
export async function DelaysRail({ today, always }: { today: string; always?: boolean }) {
  const r = (await api<Delays>("projects/delays")).data;
  if (!r) return null;
  return <>
    {r.mine.length ? <Panel title="Say why it is late" sub={plural(r.mine.length, "task")}>
      <ul className={css.delays}>{r.mine.slice(0, 6).map((d) => <StripeCard as="li" key={d.id} className={css.delay} tone="bad">
        <div className={css.delayHead}><Link href={`/tasks/${d.taskId}#late`}>{d.title}</Link><span className={css.lateBy}>{d.daysLate} {d.daysLate === 1 ? "day" : "days"} late</span></div>
        <p className={css.delayWhy}><Link href={`/tasks/projects/${d.projectId}`}>{d.project}</Link>{d.action === "chased" ? " · asked again" : ""} · <Link href={`/tasks/${d.taskId}#late`}>Answer</Link></p>
      </StripeCard>)}</ul>
    </Panel> : null}
    {r.toAct.length || always ? <Panel title="Late: needs you to act" sub={r.toAct.length ? plural(r.toAct.length, "task") : undefined}>
      {r.toAct.length ? <ul className={css.delays}>{r.toAct.slice(0, 8).map((d) => <DelayRow key={d.id} d={d} today={today} showProject />)}</ul>
        : <Empty icon={CircleCheck} compact title="Nothing late waits on you" text="Late work in the projects you lead or the stages you own shows here until you chase it, give it a date or escalate it." />}
    </Panel> : null}
  </>;
}

/** B4 on the task page: the doer is asked why it is late; whoever acts on it sees the answer and the three actions. */
export function LateOnTask({ delay, reasons, today }: { delay: Delay; reasons: Record<string, string>; today: string }) {
  // A chase opens the doer's answer again (1485): the earlier answer shows, and they give a new reason and date.
  const again = delay.action === "chased" && !delay.answeredAt;
  return <section id="late" className={css.lateBox} aria-label="Late">
    <p><b>{delay.daysLate} {delay.daysLate === 1 ? "day" : "days"} late</b> (was due {short(delay.dueOn)}).{" "}
      {delay.reasonLabel ? <>{delay.mine ? again ? "You said earlier" : "You said" : `${delay.who ?? "The doer"} said${again ? " earlier" : ""}`}: {delay.reasonLabel}{delay.note ? `, “${delay.note}”` : ""}{delay.canBy ? `; can be done by ${short(delay.canBy)}` : ""}.</>
        : delay.mine ? "Say why, and when it can be done: the project's lead sees it." : `${delay.who ?? "The doer"} was asked why ${ago(delay.askedAt, today)}.`}
      {again ? delay.mine ? <> You were asked again {ago(delay.actedAt ?? delay.askedAt, today)}: say why now, and when it can be done.</> : <> Asked again {ago(delay.actedAt ?? delay.askedAt, today)}.</> : null}</p>
    {delay.mine && !delay.answeredAt ? <DelayAnswer taskId={delay.taskId} reasons={reasons} today={today} /> : null}
    {delay.canAct && delay.needsMe ? <DelayActions delay={{ id: delay.id, title: delay.title, who: delay.who, daysLate: delay.daysLate, canBy: delay.canBy, answeredAt: delay.answeredAt, action: delay.action, dueOn: delay.dueOn }} today={today} /> : null}
  </section>;
}

type Load = { id: string; name: string; role: string | null; pod: string | null; open: number; late: number; week: number; inProjects: number; leads: number; stages: number; share: number; state: string };
/** B6: each person's load, from onboarding to delivery: projects they lead, stages they own, open, late and this week. */
export async function TeamLoad({ pod, projectsWord }: { pod?: string | null; projectsWord: string }) {
  const r = (await api<{ scope: string; people: Load[] }>(`projects/load${pod ? `?pod=${encodeURIComponent(pod)}` : ""}`)).data;
  if (!r || !r.people.length) return null;
  const facts = (p: Load) => [p.leads ? `leads ${p.leads}` : null, p.stages ? `owns ${plural(p.stages, "stage")}` : null].filter(Boolean).join(" · ");
  return <Panel title={r.scope === "mine" ? "Your load" : "Team load"} sub={`Open work per person · ${projectsWord} led and stages owned`}>
    <ul className={css.load}>{r.people.slice(0, 15).map((p) => <li key={p.id} className={css.loadRow} data-state={p.state}>
      <span className={css.loadWho}><Link href={`/people/${p.id}`}>{p.name}</Link><small>{[p.role, p.pod].filter(Boolean).join(" · ") || facts(p) || "No role set"}</small></span>
      <span className={css.loadBar} role="img" aria-label={`${p.open} open`}><i style={{ width: `${Math.max(p.open ? 4 : 0, p.share)}%` }} /></span>
      <span className={css.loadFacts}><b>{p.open}</b> open{p.late ? <span data-late=""> · {p.late} late</span> : null}{p.week ? ` · ${p.week} this week` : ""}{facts(p) && (p.role || p.pod) ? ` · ${facts(p)}` : ""}</span>
    </li>)}</ul>
  </Panel>;
}
