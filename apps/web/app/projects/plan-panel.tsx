import Link from "next/link";
import { CalendarRange, MessageCircle, Users } from "lucide-react";
import { api } from "../lib/api";
import { Badge, Panel, styles } from "../ui";
import { CreativeMove, PlanSetup, TargetsEdit } from "./plan-client";
import css from "./overview.module.css";

/** KAZUK (28 Oct 2026): a project's page, as in the Projects tab screen 2, when the project has a delivery plan (1370):
 *  the stage and team line, the clocks (handover, kick-off, first research day, live date, foundation check), the
 *  stages with their gates, the tasks with step, owner, start → due, status and where each came from, the creatives
 *  by asset code, and what reached the project from the chats. Without a plan it offers to set one up. */
type PT = { id: string; title: string; step: string | null; phase: string | null; status: string; due: string | null; start: string | null; doneOn: string | null; who: string | null;
  role: string | null; source: string; createdBy: string | null; createdOn: string | null; chat: { channel: string; kind: string; by: string | null; on: string } | null };
type Gate = { id: string; label: string; short: string; stage: number; taskId: string | null; done: boolean; due: string | null; stuck: boolean; checks: number };
type State = { stage: number; stageLabel: string | null; stageOf: number; progress: number; daysInStage: number; dayN: number; kickoff: string; adsLiveOn: string | null; adsPlanned: string | null;
  foundationDue: string | null; foundationLeft: number | null; foundationRisk: boolean; gates: Gate[]; stages: { n: number; label: string; total: number; done: number; late: number }[] };
type TemplateLite = { key: string; name: string; packages: { key: string; label: string }[]; categories: { key: string; label: string; units: number }[]; bandwidth: { role: string } };
type Data = { today: string; canRun: boolean; tasks: PT[]; templates?: TemplateLite[];
  plan: null | { templateKey: string; package: string | null; category: string | null; kickoff: string;
    template: { key: string; name: string; stages: { n: number; label: string }[]; packages: { key: string; label: string }[]; categories: { key: string; label: string; units: number }[];
      bandwidth: { role: string; short: string }; creativeColumns: string[] | null; labels: Record<string, string>; targets: { key: string; label: string; unit?: string; dueStep?: string }[] };
    targets?: Record<string, string> };
  state?: State; creatives?: { id: string; code: string; title: string; who: string | null; due: string | null; column: string }[]; team?: { role: string; people: string[] }[] };
type Group = { id: string; name: string; clientSide: number; member: boolean; canRead: boolean };

const DONE = new Set(["done", "accepted"]);
const short = (d: string | null) => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }) : "—";
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysLate = (due: string, today: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000);

function statusOf(t: PT, today: string): { label: string; tone: "danger" | "warning" | "success" | "neutral" | "accent" } {
  if (DONE.has(t.status)) return { label: "Done", tone: "success" };
  if (t.due && t.due < today) { const n = daysLate(t.due, today); return { label: `${n} ${n === 1 ? "day" : "days"} late`, tone: "danger" }; }
  if (t.status === "blocked") return { label: "Blocked", tone: "danger" };
  if (t.status === "in_review") return { label: "In review", tone: "accent" };
  if (t.status === "in_progress") return { label: "In progress", tone: "accent" };
  return { label: "Not started", tone: "neutral" };
}
function cameFrom(t: PT, teamChat: string) {
  if (t.chat) return `${t.chat.channel}${t.chat.by ? ` · ${t.chat.by}` : ""}, ${short(t.chat.on)}`;
  if (t.source === "template") return "Delivery plan";
  if (t.source === "quote") return "Quotation";
  if (t.source === "imported") return "Imported";
  return t.createdBy ? `${t.createdBy}, ${short(t.createdOn)}` : teamChat;
}

export async function ProjectPlan({ projectId, tab }: { projectId: string; tab?: string }) {
  const r = await api<Data>(`projects/${encodeURIComponent(projectId)}/plan`);
  if (!r.data) return null;
  const d = r.data;
  if (!d.plan || !d.state) {
    if (!d.canRun || !d.templates?.length) return null;
    return <div className={css.planCallout}><CalendarRange size={18} aria-hidden="true" />
      <div><b>Set up the delivery plan</b><span>Choose the package and category: Pulse lays out the stages, steps and due days from the kick-off, and counts the lead&apos;s bandwidth.</span></div>
      <PlanSetup projectId={projectId} templates={d.templates} /></div>;
  }
  const p = d.plan, s = d.state, t = p.template, L = t.labels ?? {};
  const groups = (await api<{ groups: Group[] }>(`chats/hub/linked?project=${encodeURIComponent(projectId)}`)).data?.groups ?? [];
  const clientGroup = groups.find((g) => g.clientSide > 0 && (g.member || g.canRead)), teamChat = groups.find((g) => !g.clientSide && (g.member || g.canRead));
  const step = (id: string) => d.tasks.find((x) => x.step === id);
  const firstWork = d.tasks.filter((x) => x.phase && x.start).map((x) => x.start!).sort()[0] ?? null;
  const handover = s.gates[0] ? step(s.gates[0].id) : null;
  const tiles = [
    { k: `D0 · ${s.gates[0]?.short.replace(/^\S+\s/, "") ?? "Handover"}`, v: short(handover?.doneOn ?? handover?.due ?? null) },
    { k: "K · Kick-off", v: short(s.kickoff) },
    { k: "Day 1 · first work", v: short(firstWork ?? plus(s.kickoff, 1)) },
    { k: L.adsLive ?? "Live", v: s.adsLiveOn ? short(s.adsLiveOn) : s.adsPlanned ? `Target ${short(s.adsPlanned)}` : "—" },
    { k: `${L.foundation ?? "Foundation"} due`, v: s.foundationDue ? `${short(s.foundationDue)}${s.foundationLeft !== null ? ` · ${s.foundationLeft < 0 ? `${-s.foundationLeft} days late` : `${s.foundationLeft} days`}` : ""}` : "—", risk: s.foundationRisk },
  ];
  const planned = d.tasks.filter((x) => x.step || x.phase);
  const shown = (tab === "late" ? planned.filter((x) => !DONE.has(x.status) && x.due && x.due < d.today) : tab === "done" ? planned.filter((x) => DONE.has(x.status))
    : planned.filter((x) => !DONE.has(x.status))).slice(0, 60);
  const openN = planned.filter((x) => !DONE.has(x.status)).length, lateN = planned.filter((x) => !DONE.has(x.status) && x.due && x.due < d.today).length, doneN = planned.length - openN;
  const byPerson = tab === "person" ? [...planned.filter((x) => !DONE.has(x.status)).reduce((m, x) => m.set(x.who ?? "Nobody yet", [...(m.get(x.who ?? "Nobody yet") ?? []), x]), new Map<string, PT[]>())] : [];
  const cols = t.creativeColumns ?? ["Script", "Making", "Review", "Ready", "Live"];
  const tabHref = (k: string) => `/tasks/projects/${projectId}?pt=${k}#plan-tasks`;
  // WORK-UX (29 Oct 2026): a task is one row that fits beside the rail (the table cut off Came from and squeezed the
  // titles to four lines): the step code, the task with where it came from under it, its owner, the dates and the status.
  const row = (x: PT) => { const st = statusOf(x, d.today); return <li key={x.id} className={css.trow} data-tone={st.tone}>
    <span className={css.tStep}>{x.step ?? "—"}</span>
    <span className={css.tMain}><Link href={`/tasks/${x.id}`} className={css.tTitle}>{x.step ? x.title.replace(new RegExp(`^${x.step}\\s`), "") : x.title}</Link>
      <small><span className={css.tWho} data-none={x.who ? undefined : ""}>{x.who ?? x.role ?? "Nobody yet"}</span> · {cameFrom(x, L.teamChat ?? "Team chat")}</small></span>
    <span className={css.tDates}>{x.start && x.start !== x.due ? `${short(x.start)} → ` : ""}{DONE.has(x.status) ? `Done ${short(x.doneOn)}` : short(x.due)}</span>
    <span className={css.tStatus}><Badge tone={st.tone}>{st.label}</Badge></span>
  </li>; };
  return <div className={css.plan}>
    <section className={css.planHead}>
      <p className={css.planLine}><b>Stage {s.stage} of {s.stageOf} · {s.stageLabel}</b>{p.package ? ` · ${t.packages.find((x) => x.key === p.package)?.label ?? p.package}` : ""}{p.category ? ` · ${t.categories.find((x) => x.key === p.category)?.label ?? p.category}` : ""}</p>
      {d.team?.length ? <p className={css.planTeam}><Users size={13} aria-hidden="true" />{d.team.map((x) => `${x.role} ${x.people.join(", ")}`).join(" · ")}</p> : null}
      <span className={css.planActions}>
        {clientGroup ? <Link className={styles.btn} href={`/chats?channel=${clientGroup.id}`}><MessageCircle size={13} aria-hidden="true" />Open {L.clientGroup ?? "client group"}</Link> : null}
        {/* WORK-UX: one primary action per page (Add task in the header); the chats are ordinary buttons. */}
        {teamChat ? <Link className={styles.btn} href={`/chats?channel=${teamChat.id}`}><MessageCircle size={13} aria-hidden="true" />Open {L.teamChat ?? "team chat"}</Link> : null}
      </span>
    </section>
    <div className={css.clockTiles}>{tiles.map((x) => <div key={x.k} className={css.clockTile} data-risk={x.risk ? "" : undefined}><small>{x.k}</small><b>{x.v}</b></div>)}</div>
    <Panel title="Stages">
      <div className={css.stagesBar} style={{ ["--n" as string]: t.stages.length }}>{t.stages.map((st) => { const c = s.stages.find((x) => x.n === st.n); const pct = st.n < s.stage ? 100 : c && c.total ? Math.round((c.done / c.total) * 100) : 0;
        return <div key={st.n} className={css.stageSeg} data-state={st.n < s.stage ? "done" : st.n === s.stage ? "now" : "later"} title={`${st.n} · ${st.label}${c ? `: ${c.done} of ${c.total} done${c.late ? `, ${c.late} late` : ""}` : ""}`}>
          <i><em style={{ width: `${pct}%` }} /></i><b>{st.n}</b><span>{st.label}</span></div>; })}</div>
      <div className={css.gates}>{s.gates.map((g) => <Badge key={g.id} tone={g.done ? "success" : g.stuck ? "danger" : "warning"}>{g.short}{g.done ? " ✓" : g.checks ? ` · ${g.checks} checks` : ""}</Badge>)}</div>
    </Panel>
    <section id="plan-tasks"><Panel title="Tasks" tools={<div className={styles.segmented} role="group" aria-label="Which tasks">
      <Link href={tabHref("open")} className={styles.segment} aria-current={!tab || tab === "open" ? "true" : undefined}>Open ({openN})</Link>
      <Link href={tabHref("late")} className={styles.segment} aria-current={tab === "late" ? "true" : undefined}>Late ({lateN})</Link>
      <Link href={tabHref("done")} className={styles.segment} aria-current={tab === "done" ? "true" : undefined}>Done ({doneN})</Link>
      <Link href={tabHref("person")} className={styles.segment} aria-current={tab === "person" ? "true" : undefined}>By person</Link>
    </div>}>
      <ul className={css.tlist} aria-label="Tasks by step">
        <li className={css.thead} aria-hidden="true"><span>Step</span><span>Task · owner · came from</span><span>Start → due</span><span>Status</span></li>
        {tab === "person" ? byPerson.flatMap(([who, list]) => [<li key={who} className={css.tgroup}>{who} · {list.length}</li>, ...list.map(row)]) : shown.map(row)}
      </ul>
      {!shown.length && tab !== "person" ? <p className={css.empty}>Nothing here.</p> : null}
    </Panel></section>
    {d.creatives?.length ? <Panel title="Creatives" sub="One card per asset code">
      <div className={css.board} style={{ ["--cols" as string]: cols.length }}>{cols.map((c) => <div key={c} className={css.boardCol}><h4>{c}</h4>
        {d.creatives!.filter((x) => x.column === c).map((x) => <Link key={x.id} href={`/tasks/${x.id}`} className={css.card}><b>{x.code}</b><span>{x.title}</span><small>{[x.who, x.due ? `due ${short(x.due)}` : null].filter(Boolean).join(", ")}</small></Link>)}
        {d.canRun ? d.creatives!.filter((x) => x.column === c).map((x) => <CreativeMove key={`m-${x.id}`} projectId={projectId} taskId={x.id} code={x.code} state={x.column} columns={cols} />) : null}
      </div>)}</div>
    </Panel> : null}
  </div>;
}

/** What reached the project from the chats: tasks sent in a chat, newest first (the chats the viewer may read). */
export async function FromTheChats({ projectId, className, headClassName }: { projectId: string; className: string; headClassName: string }) {
  const d = (await api<Data>(`projects/${encodeURIComponent(projectId)}/plan`)).data;
  const items = (d?.tasks ?? []).filter((x) => x.chat).sort((a, b) => b.chat!.on.localeCompare(a.chat!.on)).slice(0, 8);
  if (!items.length) return null;
  return <section className={className} aria-label="From the chats" data-fixed="">
    <div className={headClassName}><h3><MessageCircle size={14} aria-hidden="true" /> From the chats</h3></div>
    <ul className={css.needs}>{items.map((x) => <li key={x.id}><Link href={`/tasks/${x.id}`} className={css.needTitle}>{x.chat!.by ?? "Someone"} sent “{x.title}”{x.who ? ` to ${x.who}` : ""}</Link>
      <span className={css.needMeta}>{x.chat!.channel} · {short(x.chat!.on)}{DONE.has(x.status) ? " · done" : ""}</span></li>)}</ul>
  </section>;
}

/** Targets from the handover (Kazuk's screen 2): the template's list with the project's values; a target whose step is
 *  past due and still unset reads late. */
export async function HandoverTargets({ projectId, className, headClassName }: { projectId: string; className: string; headClassName: string }) {
  const d = (await api<Data>(`projects/${encodeURIComponent(projectId)}/plan`)).data;
  const list = d?.plan?.template.targets ?? [];
  if (!d?.plan || !list.length) return null;
  const vals = d.plan.targets ?? {};
  const lateOf = (step?: string) => { const x = step ? d.tasks.find((t) => t.step === step) : null; return x?.due && x.due < d.today ? daysLate(x.due, d.today) : 0; };
  return <section className={className} aria-label="Targets from the handover" data-fixed="">
    <div className={headClassName}><h3>Targets from the handover</h3>{d.canRun ? <TargetsEdit projectId={projectId} targets={list} values={vals} /> : null}</div>
    <ul className={css.scope}>{list.map((t) => { const v = vals[t.key]; const late = !v ? lateOf(t.dueStep) : 0;
      return <li key={t.key}><span>{t.label}</span><b data-late={late ? "" : undefined}>{v ? `${t.unit === "₹" ? "₹" : ""}${v}${t.unit && t.unit !== "₹" ? ` ${t.unit}` : ""}` : late ? `Not set · ${late} days late` : "Not set"}</b></li>; })}</ul>
  </section>;
}
