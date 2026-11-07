import Link from "next/link";
import { Activity, CalendarDays, CheckCheck, Flame, Hourglass, Lightbulb, ListTree, MessageSquare, Package, Sparkles, Target, Users } from "lucide-react";
import { api } from "../../../lib/api";
import { plural } from "../../../lib/format";
import { Message, Page, PageHeader, styles } from "../../../ui";
import { KindChip, kindOf } from "../../../work-kind";
import { TaskRow } from "../../client";
import { Chip, STATUS, shortDay } from "../../parts";
import type { Person, Task } from "../../types";
import { SuggestedPeople, type Fit } from "../../fit-panel";
import { AskBanner, AskToJoin, EditProject, NewTaskButton, ProjectPeople, SetUpButton, WatchButton, type Ask, type Comment } from "../../work-client";
import { Threads } from "../../threads";
import { DeleteProjectButton } from "../../delete";
import { ProjectChip } from "../../chips";
import { ProjectStyle } from "../../categories";
import { ProjectWorkflows } from "../../../sops/project-strip";
import type { RunsOverview } from "../../../sops/types";
import { TaskViews } from "../../views/task-views";
import { readConfig, type ViewPrefs } from "../../views/model";
import css from "../../tasks.module.css";
import pcss from "../project.module.css";
import pp from "./project-page.module.css";
import { EmptyState } from "@pulse/design-system/ui";
import { StatTiles } from "../../../components/work-kit";
import { orgZone } from "../../../lib/brand-server";
import { zoneDay } from "../../../lib/zone.mjs";
import { ProjectStatusButton } from "../../../projects/run-client";
import { ScopePanel } from "../../../projects/scope-panel";
import { FromTheChats, HandoverTargets, ProjectPlan } from "../../../projects/plan-panel";
import { ProjectVisibility, VisibleTo, type Visibility } from "../../visibility";
import { AssignClient, type Assign } from "../../../projects/assign-client";
import { ProjectTypePick } from "./type-pick";
import { Portfolio, type PortfolioRow } from "./portfolio";

type Goal = { id: string; title: string; status: string; targetOn: string | null; progress: { progress?: number | null } | null };
type Work = { kind: string; status: string; pod: string | null; startsOn: string | null; dueOn: string | null; summary: string | null; templateKey: string | null; setUp: boolean;
  ownerId: string | null; ownerName: string | null; ownerPhotoAt: string | null; projectKind: string; packageStatus: string; scope: string | null; clientId: string | null; clientName: string | null;
  canManage: boolean; inside: boolean; onIt: boolean; members: { id: string; name: string; role: string; photoAt: string | null; pod: string | null }[]; asks: Ask[]; watching: boolean; comments: Comment[];
  category?: string | null; categoryLabel?: string | null; color?: string | null; icon?: string | null; categorySet?: boolean;
  /** PRIVACY: who sees it, in words, and whether the viewer may change it. */ visibility?: Visibility; visibleTo?: string; canSetVisibility?: boolean; canLeadershipOnly?: boolean; workstream?: string | null;
  /** PERSONAL-WORKSPACE (1640): client delivery, internal or personal; the organisation's kind; its active people; the goals it serves. */
  projectType?: "client_delivery" | "internal" | "personal"; orgKind?: "company" | "personal"; staffCount?: number; goals?: Goal[] };
type Data = { project: { id: string; name: string; status: string; requiresProof: boolean; clientName: string | null; registryNo: number | null }; tasks: Task[];
  links: { taskId: string; blockerId: string; blockerTitle: string; blockerStatus: string; blockerOwnerId: string | null; blockerOwner: string | null; outside: boolean; since: string }[]; timeline: Task[]; people: Person[]; canEdit: boolean; canProof: boolean; work: Work | null };
const FINISHED = ["done", "accepted", "in_review", "cancelled"];
const STATE: Record<string, string> = { planned: "Planned", active: "Active", paused: "Paused", done: "Done", cancelled: "Cancelled" };
const TABS = [{ key: "overview", label: "Overview" }, { key: "list", label: "List" }, { key: "board", label: "Board" }, { key: "timeline", label: "Timeline" }, { key: "calendar", label: "Calendar" }] as const;
const DAY = 86400000;
const pctOf = (g: Goal) => typeof g.progress?.progress === "number" ? Math.round(g.progress.progress * 100) : null;

/** A work project. PERSONAL-WORKSPACE (owner, 6 Nov 2026): the page opens on the project's idea first (what it is for, its
 *  status, progress and the goal it serves), then its tasks in the view you choose (list, board, timeline, calendar); the
 *  people and their load sit in the side, only when more than one person works here; the client-delivery panels (the
 *  package, its plan, scope, handover targets, "not set up yet") show only for a client-delivery project. */
export default async function ProjectTasks({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params; const q = await searchParams;
  const [r, prefs, list, port] = await Promise.all([api<Data>(`tasks/projects/${encodeURIComponent(id)}`), api<ViewPrefs>("work/views?place=project"),
    api<{ rows: Task[]; me: string | null }>(`work/list?scope=project&project=${encodeURIComponent(id)}`), api<{ rows: PortfolioRow[] }>("work/projects?show=all")]);
  const p = prefs.data ?? null;
  // The design target's tabs: Overview first, then the tasks as a list, a board, a timeline or a calendar.
  const tab = TABS.find((t) => t.key === q.tab)?.key ?? "overview";
  const initial = readConfig(tab === "overview" ? q : { ...q, layout: tab }, p?.config ?? null, "project", p?.defaultLayout ?? p?.layout ?? null);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!; const zone = await orgZone(), today = zoneDay(zone); const w = d.work;
  const kind = kindOf(w?.kind ?? (d.project.clientName ? "fulfilment" : "internal"), w?.projectType ?? null);
  const delivery = kind === "fulfilment";
  const personalOrg = w?.orgKind === "personal";
  // The people here: more than one person in the organisation, or anyone besides the owner on the project.
  const team = (w?.staffCount ?? 2) > 1 || (w?.members ?? []).some((m) => m.role === "member");
  // LIFECYCLE: project staffing. Who fits best, for the owner, the pod head and leadership (a team only).
  const fit = w?.canManage && team && !personalOrg ? (await api<{ people: Fit[] }>(`fit?project=${encodeURIComponent(id)}&limit=6`)).data?.people ?? [] : [];
  // SOP-WORKFLOW: the project's workflow runs, and Start a workflow for whoever manages it.
  const runs = (await api<RunsOverview>(`workflows/runs?projectId=${encodeURIComponent(id)}`)).data?.runs ?? [];
  // BILLING (owner, 4 Nov 2026): a project its paid invoice started waits for a project head's owner and client category.
  const assign = delivery ? (await api<Assign>(`projects/${encodeURIComponent(id)}/assign`)).data ?? null : null;
  const byParent = new Map<string | null, Task[]>(); const ids = new Set(d.tasks.map((t) => t.id));
  for (const t of d.tasks) { const key = t.parentId && ids.has(t.parentId) ? t.parentId : null; byParent.set(key, [...(byParent.get(key) ?? []), t]); }
  const rank = (t: Task) => t.status === "blocked" || t.openBlockers ? 0 : t.status === "in_progress" ? 1 : ["open", "unknown"].includes(t.status) ? 2 : 3;
  for (const items of byParent.values()) items.sort((a, b) => rank(a) - rank(b) || String(b.doneAt ?? b.workOn ?? "").localeCompare(String(a.doneAt ?? a.workOn ?? "")) || a.title.localeCompare(b.title));
  const waits = (t: Task) => d.links.filter((l) => l.taskId === t.id && !FINISHED.includes(l.blockerStatus));
  const blocked = d.tasks.filter((t) => t.status === "blocked" || t.openBlockers > 0);
  const counted = d.tasks.filter((t) => t.status !== "cancelled");
  const finished = counted.filter((t) => FINISHED.includes(t.status)).length, open = counted.length - finished;
  const pct = counted.length ? Math.round((100 * finished) / counted.length) : 0;
  const late = counted.filter((t) => !FINISHED.includes(t.status) && t.dueAt && String(t.dueAt).slice(0, 10) < today).length;
  const nextUp = counted.filter((t) => !FINISHED.includes(t.status)).sort((a, b) => rank(a) - rank(b) || String(a.dueAt ?? "9999").localeCompare(String(b.dueAt ?? "9999")))[0] ?? null;
  // Overview: the milestones (tasks with a due day: the open ones soonest first, then the latest finished) on a small
  // timeline with a Today line; the key open tasks; what happened lately; and, for your own project, a focus streak.
  const dated = counted.filter((t) => t.dueAt || t.dueOn).map((t) => ({ t, due: String(t.dueOn ?? t.dueAt).slice(0, 10), done: FINISHED.includes(t.status) }));
  const miles = [...dated.filter((x) => !x.done).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 5), ...dated.filter((x) => x.done).sort((a, b) => b.due.localeCompare(a.due)).slice(0, 2)]
    .sort((a, b) => a.due.localeCompare(b.due));
  const t0 = Date.parse(`${today}T00:00:00Z`);
  const from = Math.min(t0 - 14 * DAY, ...miles.map((m) => Date.parse(`${m.due}T00:00:00Z`) - 7 * DAY)), to = Math.max(t0 + 14 * DAY, ...miles.map((m) => Date.parse(`${m.due}T00:00:00Z`) + 2 * DAY));
  const at = (ms: number) => Math.max(0, Math.min(100, ((ms - from) / (to - from)) * 100));
  const keyTasks = counted.filter((t) => !FINISHED.includes(t.status)).sort((a, b) => rank(a) - rank(b) || String(a.dueAt ?? "9999").localeCompare(String(b.dueAt ?? "9999"))).slice(0, 5);
  const recent = [...d.timeline].reverse().slice(0, 5);
  const doneDays = new Set(d.timeline.map((t) => (t.doneAt ? zoneDay(zone, t.doneAt) : t.workOn) ?? "").filter(Boolean));
  let streak = 0; for (let k = 0; k < 60; k++) { const day = new Date(t0 - k * DAY).toISOString().slice(0, 10); if (doneDays.has(day)) streak++; else if (k > 0) break; }
  const tree = (parent: string | null, depth = 0): React.ReactNode => {
    const items = byParent.get(parent) ?? [];
    if (!items.length) return null;
    return <ul className={depth ? css.tree : `${css.list} ${css.tree}`} data-items={depth ? undefined : ""}>{items.map((t) => <TaskRow key={t.id} task={t} today={today} me={null}>
      {waits(t).map((l) => <span key={l.blockerId} className={css.waits}><Hourglass size={12} aria-hidden="true" />Waiting on <Link href={`/tasks/${l.blockerId}`}><b>{l.blockerTitle}</b></Link> · {l.blockerOwner ?? "nobody yet"}{l.outside ? " · outside this project" : ""}</span>)}
      {tree(t.id, depth + 1)}
    </TaskRow>)}</ul>;
  };
  const dates = w?.startsOn || w?.dueOn ? `${w.startsOn ? shortDay(w.startsOn) : "…"} → ${w.dueOn ? shortDay(w.dueOn) : "no due date"}` : null;
  const myAsks = (w?.asks ?? []).filter((a) => a.incoming || a.actions.length);
  const goals = w?.goals ?? [];
  const typeWord = kind === "personal" ? "Personal project" : kind === "internal" ? "Internal project" : "Client delivery";
  return (
    <Page fit>
      <PageHeader title={d.project.name} back={{ href: "/tasks?view=projects", label: personalOrg ? "My projects" : "Projects" }} recent={{ title: `${d.project.name} · ${delivery ? "fulfilment" : "project"}` }}
        context={[w?.categoryLabel && !personalOrg ? <ProjectChip key="cat" id={null} name={w.categoryLabel} color={w.color} icon={w.icon} link={false} /> : <KindChip key="k" kind={kind} />,
          delivery ? <span key="c">for <Link href={`/projects/${d.project.id}`}>{w?.clientName ?? d.project.clientName ?? "its client package"}</Link></span> : personalOrg ? null : w?.pod ?? null,
          // A personal workspace has one owner: the "Owner:" label is for a team.
          team && !personalOrg ? (w?.ownerName ? `Owner: ${w.ownerName}` : "No owner yet") : null, dates, w && w.status !== "active" ? STATE[w.status] : null,
          d.project.requiresProof ? "Proof needed before acceptance" : null,
          w?.visibleTo && !personalOrg ? <VisibleTo key="vis" text={w.visibleTo} restricted={w.visibility !== "org"} /> : null]}
        actions={<>
          {d.canEdit ? <NewTaskButton projectId={d.project.id} primary /> : null}
          {w && !w.inside ? <AskToJoin projectId={d.project.id} /> : null}
          {w?.canManage ? <EditProject projectId={d.project.id} kind={w.kind} name={d.project.name} ownerId={w.ownerId} startsOn={w.startsOn} dueOn={w.dueOn} status={w.status} summary={w.summary} /> : null}
          {delivery ? <Link className={styles.btn} href={`/projects/${d.project.id}`}><Package size={13} aria-hidden="true" />Client package</Link> : null}
          {/* KAZUK: Kazuk's project screen: Timeline and Status (pause, hold, discontinue with a reason). */}
          <Link className={styles.btn} href={`/tasks/projects/${d.project.id}/timeline`}><CalendarDays size={13} aria-hidden="true" />Timeline</Link>
          {w?.canManage ? <ProjectStatusButton projectId={d.project.id} status={w.status === "cancelled" ? "discontinued" : w.status === "paused" ? "paused" : "active"} /> : null}
        </>} />
      <div className={pp.split} data-grow="">
      <Portfolio rows={port.data?.rows ?? []} current={d.project.id} personalOrg={personalOrg} />
      <div className={`${css.shell} ${pp.detail}`} data-grow="">
        {assign?.needed ? <AssignClient a={assign} /> : null}
        {myAsks.map((a) => <AskBanner key={a.id} ask={a} highlight={q.ask === a.id} />)}
        {/* 1. The project's idea first: what it is for, where it stands, the goal it serves. */}
        <section className={pp.hero} aria-label="About this project" data-kind={kind}>
          <div className={pp.idea}>
            <p className={pp.eyebrow}><Lightbulb size={13} aria-hidden="true" />{typeWord}{w && w.status !== "active" ? ` · ${STATE[w.status] ?? w.status}` : " · Active"}</p>
            {w?.summary ? <p className={pp.purpose}>{w.summary}</p>
              : <p className={pp.purposeEmpty}>{w?.canManage ? "What is this project for? Write its idea in Edit: one or two lines you would tell a friend." : "No description yet."}</p>}
            <div className={pp.goals}>
              {goals.length ? goals.map((g) => { const gp = pctOf(g); return <Link key={g.id} href={`/goals/${g.id}`} className={pp.goal} data-status={g.status}>
                <Target size={13} aria-hidden="true" /><span>{g.title}</span>{gp !== null ? <small>{gp}%</small> : null}{g.status === "done" ? <small>achieved</small> : null}</Link>; })
                : <span className={pp.noGoal}><Target size={13} aria-hidden="true" />Not linked to a goal yet · <Link href="/goals">Goals</Link></span>}
            </div>
          </div>
          <div className={pp.progress}>
            <div className={pp.ring} style={{ ["--pct" as string]: `${pct}` }} role="img" aria-label={`${pct}% done: ${finished} of ${counted.length} tasks`}><b>{pct}%</b><small>done</small></div>
            <dl className={pp.facts}>
              <div><dt>Open</dt><dd>{open}</dd></div>
              <div><dt>Late</dt><dd data-bad={late ? "" : undefined}>{late}</dd></div>
              <div><dt>Blocked</dt><dd data-bad={blocked.length ? "" : undefined}>{blocked.length}</dd></div>
              <div><dt>Finished</dt><dd>{finished}</dd></div>
            </dl>
            {nextUp ? <p className={pp.next}>Next: <Link href={`/tasks/${nextUp.id}`}>{nextUp.title}</Link>{nextUp.dueAt ? <small> · due {shortDay(String(nextUp.dueAt).slice(0, 10))}</small> : null}</p> : null}
          </div>
        </section>
        <nav className={pp.tabs} aria-label="Project views">{TABS.map((t) => <Link key={t.key} href={`/tasks/projects/${d.project.id}${t.key === "overview" ? "" : `?tab=${t.key}`}`}
          className={pp.tab} aria-current={tab === t.key ? "page" : undefined}>{t.label}</Link>)}</nav>
        {runs.length ? <ProjectWorkflows projectId={d.project.id} runs={runs} canStart={!!w?.canManage} /> : null}
        {/* 2. Client delivery only: the package's set-up, its delivery plan. */}
        {delivery && w && !w.setUp && (w.canManage || d.canProof) ? <div className={css.callout}><Package size={18} aria-hidden="true" />
          <div><b>This fulfilment is not set up yet</b><span>Give it an owner, the people who deliver it, a due date, and optionally a template such as Video package: shoot → edit → review → deliver.</span></div>
          <SetUpButton clientProjectId={d.project.id} /></div> : null}
        <div className={pcss.grid} data-grow="">
          <section className={pcss.main} aria-label="Tasks" data-grow="">
            {/* KAZUK (28 Oct 2026): the delivery plan (Projects tab screen 2), for a client-delivery project only. */}
            {delivery && tab === "overview" ? <ProjectPlan projectId={d.project.id} tab={q.pt} /> : null}
            {tab === "overview" ? <>
              <section className={pp.card} aria-label="Milestones">
                <h3 className={pp.cardHead}><CalendarDays size={15} aria-hidden="true" />Milestones<small>{miles.length ? `${miles.length} with a due day` : null}</small></h3>
                {miles.length ? <div className={pp.gantt}>
                  <i className={pp.today} style={{ left: `calc(40% + 60% * ${at(t0) / 100})` }}><b>Today</b></i>
                  {miles.map(({ t, due, done }) => { const end = Date.parse(`${due}T00:00:00Z`), start = end - 7 * DAY;
                    return <div key={t.id} className={pp.gRow}><Link href={`/tasks/${t.id}`} className={pp.gName} data-done={done ? "" : undefined}>{done ? <CheckCheck size={13} aria-hidden="true" /> : <span className={pp.gDot} />}{t.title}</Link>
                      <span className={pp.gTrack}><i data-done={done ? "" : undefined} data-late={!done && due < today ? "" : undefined} style={{ left: `${at(start)}%`, width: `${Math.max(3, at(end) - at(start))}%` }} title={`Due ${shortDay(due)}`} /></span></div>; })}
                </div> : <p className={pp.empty}>Give tasks a due day and they show here as milestones.</p>}
              </section>
              <div className={pp.cards2}>
                <section className={pp.card} aria-label="Key tasks">
                  <h3 className={pp.cardHead}><ListTree size={15} aria-hidden="true" />Key tasks<small>{open ? `${open} open` : null}</small></h3>
                  {keyTasks.length ? <ul className={pp.keyList}>{keyTasks.map((t) => <li key={t.id}><Link href={`/tasks/${t.id}`}>{t.title}</Link>
                    <small data-late={t.dueAt && String(t.dueAt).slice(0, 10) < today ? "" : undefined}>{t.status === "blocked" || t.openBlockers ? "Blocked" : t.dueAt ? `Due ${shortDay(String(t.dueAt).slice(0, 10))}` : "No due day"}{team && t.assigneeName ? ` · ${t.assigneeName}` : ""}</small></li>)}</ul>
                    : <p className={pp.empty}>Nothing open. Add the next task when there is more to do.</p>}
                </section>
                {delivery ? <section className={pp.card} aria-label="Package">
                  <h3 className={pp.cardHead}><Package size={15} aria-hidden="true" />Package</h3>
                  <dl className={pp.facts}><div><dt>Client</dt><dd>{w?.clientName ?? d.project.clientName ?? "Not linked"}</dd></div><div><dt>Dates</dt><dd>{dates ?? "Not set"}</dd></div>
                    <div><dt>Done</dt><dd>{finished} of {counted.length}</dd></div><div><dt>Late</dt><dd data-bad={late ? "" : undefined}>{late}</dd></div></dl>
                  {w?.scope ? <p className={pp.empty}>{w.scope}</p> : null}
                </section> : <section className={pp.card} aria-label="Rolls up to">
                  <h3 className={pp.cardHead}><Target size={15} aria-hidden="true" />Rolls up to</h3>
                  {goals.length ? <ul className={pp.keyList}>{goals.map((g) => { const gp = pctOf(g); return <li key={g.id}><Link href={`/goals/${g.id}`}>{g.title}</Link>
                    <span className={pp.gBar}><i style={{ width: `${gp ?? 0}%` }} /></span><small>{g.status === "done" ? "Achieved" : gp !== null ? `${gp}%` : "Active"}</small></li>; })}</ul>
                    : <p className={pp.empty}>Link this project to a goal on <Link href="/goals">Goals</Link>, and its progress rolls up there.</p>}
                  <p className={pp.streak} data-on={streak ? "" : undefined}><Flame size={15} aria-hidden="true" />{streak ? `${streak}-day focus streak` : "Finish a task today to start a focus streak"}</p>
                </section>}
              </div>
              <section className={pp.card} aria-label="Recent activity">
                <h3 className={pp.cardHead}><Activity size={15} aria-hidden="true" />Recent activity</h3>
                {recent.length ? <ul className={pp.keyList}>{recent.map((t) => { const day = t.doneAt ? zoneDay(zone, t.doneAt) : t.workOn!; return <li key={t.id}>
                  <Link href={`/tasks/${t.id}`}>{t.title}</Link><small>Finished {shortDay(day)}{team && t.assigneeName ? ` · ${t.assigneeName}` : ""}</small></li>; })}</ul>
                  : <p className={pp.empty}>Finished tasks show here.</p>}
              </section>
            </> : null}
            {/* 3. The tasks, in the view you choose: list (the task tree, blocked first), board, timeline, calendar. */}
            {counted.length && delivery && tab !== "overview" ? <div className={pp.glance}><StatTiles label="This project at a glance" items={[
              { label: "Done", value: `${pct}%`, tone: pct === 100 ? "good" : undefined }, { label: open === 1 ? "Open task" : "Open tasks", value: open },
              { label: "Blocked", value: blocked.length, tone: blocked.length ? "bad" : undefined },
              ...(w ? [{ label: "People", value: 1 + w.members.filter((m) => m.role === "member").length }] : [{ label: "Finished", value: finished }])]} /><span className={pp.bar} role="img" aria-label={`${pct}% done: ${finished} of ${counted.length}`}><i style={{ width: `${pct}%` }} /></span></div> : null}
            {tab === "overview" ? null : <TaskViews place="project" prefKey="project" rows={list.data?.rows ?? d.tasks} today={today} me={list.data?.me ?? null} initial={initial} ask={p?.ask ?? null} saved={p?.saved ?? []}
              listSlot={d.tasks.length ? <div className={pcss.tree}>{tree(null)}</div> : undefined}
              empty={counted.length ? <EmptyState center icon={<CheckCheck />} hue="green" title="All tasks are finished" action={d.canEdit ? <NewTaskButton projectId={d.project.id} primary /> : undefined}>
                {plural(finished, "task")} done. Add the next one when there is more to do.</EmptyState>
                : <EmptyState center icon={<ListTree />} hue="indigo" title="No tasks in this project yet" action={d.canEdit ? <NewTaskButton projectId={d.project.id} primary /> : undefined}>
                {d.canEdit ? "Add the first task, or press C anywhere and choose this project." : "Tasks appear here as people add them."}</EmptyState>} />}
          </section>
          <aside className={pcss.side} aria-label="People, discussion and settings">
            {delivery ? <>
              <ScopePanel projectId={d.project.id} className={css.panel} headClassName={css.panelHead} />
              <FromTheChats projectId={d.project.id} className={css.panel} headClassName={css.panelHead} />
              <HandoverTargets projectId={d.project.id} className={css.panel} headClassName={css.panelHead} />
            </> : null}
            {/* The people and their load: only when more than one person works here. */}
            {team ? <section className={css.panel} aria-label="People" data-fixed="">
              <div className={css.panelHead}><h3><Users size={14} aria-hidden="true" /> People</h3><small>{w ? plural(1 + w.members.filter((m) => m.role === "member").length, "person", "people") : null}</small></div>
              {w ? <ProjectPeople projectId={d.project.id} owner={{ id: w.ownerId, name: w.ownerName, photoAt: w.ownerPhotoAt }} members={w.members} canManage={w.canManage} onIt={w.onIt} /> : null}
              {delivery && w?.scope ? <p className={css.note}><Package size={12} aria-hidden="true" /> Package: {w.scope}</p> : null}
              {w?.canManage && fit.length ? <details className={pp.fold}><summary><Sparkles size={13} aria-hidden="true" />Who fits</summary>
                <SuggestedPeople projectId={d.project.id} canAdd={w.canManage} people={fit.filter((f) => f.id !== w.ownerId && !w.members.some((m) => m.id === f.id && m.role === "member")).slice(0, 3)} /></details> : null}
            </section> : null}
            <section className={css.panel} aria-label={team ? "Discussion" : "Notes"} data-fixed="">
              <div className={css.panelHead}><h3><MessageSquare size={14} aria-hidden="true" /> {team ? "Discussion" : "Notes"}</h3><small>{w?.comments.length ? plural(w.comments.length, "comment") : null}</small></div>
              {w?.inside ? <Threads projectId={d.project.id} comments={w.comments} canComment canResolve={w.canManage} /> : <p className={css.empty}>Ask to join to see and take part in the discussion.</p>}
            </section>
            {w?.inside || w?.canManage || w?.canSetVisibility ? <section className={css.panel} aria-label="This project" data-fixed="">
              <div className={css.panelHead}><h3>This project</h3></div>
              <div className={pp.settings}>
                {w?.canManage ? <ProjectTypePick projectId={d.project.id} value={w.projectType ?? (delivery ? "client_delivery" : "internal")} personalOrg={personalOrg} /> : null}
                {w?.canSetVisibility && !personalOrg ? <ProjectVisibility projectId={d.project.id} value={w.visibility ?? "org"} canLeadership={!!w.canLeadershipOnly} /> : null}
                {w?.inside && team ? <WatchButton projectId={d.project.id} watching={w.watching} /> : null}
                {w?.canManage ? <ProjectStyle projectId={d.project.id} category={w.categorySet ? w.category ?? null : null} color={w.color ?? null} icon={w.icon ?? null} workstream={w.workstream ?? null} /> : null}
                {!runs.length && !personalOrg ? <ProjectWorkflows projectId={d.project.id} runs={runs} canStart={!!w?.canManage} /> : null}
                {w?.canManage && w.kind === "internal" ? <DeleteProjectButton projectId={d.project.id} /> : null}
              </div>
            </section> : null}
            {d.timeline.length ? <details className={`${css.panel} ${pp.fold}`} data-fixed="">
              <summary><CheckCheck size={14} aria-hidden="true" /> What was finished after what <small>{d.timeline.length}</small></summary>
              <ol className={css.timeline}>{d.timeline.map((t, i) => {
                const day = t.doneAt ? zoneDay(zone, t.doneAt) : t.workOn!;
                const after = i ? d.timeline[i - 1] : null;
                return <li key={t.id}><time dateTime={day}>{shortDay(day)} {day.slice(0, 4)}</time><Link href={`/tasks/${t.id}`}>{t.title}</Link>
                  <small>{team ? t.assigneeName ?? "Unassigned" : null}{after ? `${team ? " · " : ""}after “${after.title.length > 40 ? `${after.title.slice(0, 39)}…` : after.title}”` : team ? " · first" : "First"}</small>
                  {t.valueNote ? <small>{t.valueNote}</small> : null}{t.status !== "accepted" ? <span><Chip>{STATUS[t.status]?.label}</Chip></span> : null}</li>;
              })}</ol>
            </details> : null}
          </aside>
        </div>
      </div>
      </div>
    </Page>
  );
}
