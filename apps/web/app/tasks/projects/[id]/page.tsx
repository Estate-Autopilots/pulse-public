import Link from "next/link";
import { CalendarDays, CheckCheck, Hourglass, ListTree, MessageSquare, Package, Sparkles, Users } from "lucide-react";
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
import { EmptyState, Stat, StatStrip } from "@pulse/design-system/ui";
import { orgZone } from "../../../lib/brand-server";
import { zoneDay } from "../../../lib/zone.mjs";
import { ProjectStatusButton } from "../../../projects/run-client";
import { ScopePanel } from "../../../projects/scope-panel";
import { FromTheChats, HandoverTargets, ProjectPlan } from "../../../projects/plan-panel";

type Work = { kind: string; status: string; pod: string | null; startsOn: string | null; dueOn: string | null; summary: string | null; templateKey: string | null; setUp: boolean;
  ownerId: string | null; ownerName: string | null; ownerPhotoAt: string | null; projectKind: string; packageStatus: string; scope: string | null; clientId: string | null; clientName: string | null;
  canManage: boolean; inside: boolean; onIt: boolean; members: { id: string; name: string; role: string; photoAt: string | null; pod: string | null }[]; asks: Ask[]; watching: boolean; comments: Comment[];
  category?: string | null; categoryLabel?: string | null; color?: string | null; icon?: string | null; categorySet?: boolean };
type Data = { project: { id: string; name: string; status: string; requiresProof: boolean; clientName: string | null; registryNo: number | null }; tasks: Task[];
  links: { taskId: string; blockerId: string; blockerTitle: string; blockerStatus: string; blockerOwnerId: string | null; blockerOwner: string | null; outside: boolean; since: string }[]; timeline: Task[]; people: Person[]; canEdit: boolean; canProof: boolean; work: Work | null };
const FINISHED = ["done", "accepted", "in_review", "cancelled"];
const STATE: Record<string, string> = { planned: "Planned", active: "Active", paused: "Paused", done: "Done", cancelled: "Cancelled" };

/** A work project: an internal project, or the fulfilment of a client package. Its people, asks and discussion; blocked
 *  work first (with what it waits on), then the task tree, then what was finished after what. */
export default async function ProjectTasks({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params; const q = await searchParams;
  const [r, prefs, list] = await Promise.all([api<Data>(`tasks/projects/${encodeURIComponent(id)}`), api<ViewPrefs>("work/views?place=project"),
    api<{ rows: Task[]; me: string | null }>(`work/list?scope=project&project=${encodeURIComponent(id)}`)]);
  const p = prefs.data ?? null;
  const initial = readConfig(q, p?.config ?? null, "project", p?.defaultLayout ?? p?.layout ?? null);
  if (r.error) return <Message text={r.error} />;
  // LIFECYCLE: project staffing. Who fits best, for the owner, the pod head and leadership.
  const fit = r.data?.work?.canManage ? (await api<{ people: Fit[] }>(`fit?project=${encodeURIComponent(id)}&limit=6`)).data?.people ?? [] : [];
  // SOP-WORKFLOW: the project's workflow runs, and Start a workflow for whoever manages it.
  const runs = (await api<RunsOverview>(`workflows/runs?projectId=${encodeURIComponent(id)}`)).data?.runs ?? [];
  const d = r.data!; const zone = await orgZone(), today = zoneDay(zone); const w = d.work;
  const byParent = new Map<string | null, Task[]>(); const ids = new Set(d.tasks.map((t) => t.id));
  for (const t of d.tasks) { const key = t.parentId && ids.has(t.parentId) ? t.parentId : null; byParent.set(key, [...(byParent.get(key) ?? []), t]); }
  const rank = (t: Task) => t.status === "blocked" || t.openBlockers ? 0 : t.status === "in_progress" ? 1 : ["open", "unknown"].includes(t.status) ? 2 : 3;
  for (const list of byParent.values()) list.sort((a, b) => rank(a) - rank(b) || String(b.doneAt ?? b.workOn ?? "").localeCompare(String(a.doneAt ?? a.workOn ?? "")) || a.title.localeCompare(b.title));
  const waits = (t: Task) => d.links.filter((l) => l.taskId === t.id && !FINISHED.includes(l.blockerStatus));
  const blocked = d.tasks.filter((t) => t.status === "blocked" || t.openBlockers > 0);
  const counted = d.tasks.filter((t) => t.status !== "cancelled");
  const finished = counted.filter((t) => FINISHED.includes(t.status)).length, open = counted.length - finished;
  const pct = counted.length ? Math.round((100 * finished) / counted.length) : 0;
  const tree = (parent: string | null, depth = 0): React.ReactNode => {
    const list = byParent.get(parent) ?? [];
    if (!list.length) return null;
    return <ul className={depth ? css.tree : `${css.list} ${css.tree}`} data-items={depth ? undefined : ""}>{list.map((t) => <TaskRow key={t.id} task={t} today={today} me={null}>
      {waits(t).map((l) => <span key={l.blockerId} className={css.waits}><Hourglass size={12} aria-hidden="true" />Waiting on <Link href={`/tasks/${l.blockerId}`}><b>{l.blockerTitle}</b></Link> · {l.blockerOwner ?? "nobody yet"}{l.outside ? " · outside this project" : ""}</span>)}
      {tree(t.id, depth + 1)}
    </TaskRow>)}</ul>;
  };
  const kind = kindOf(w?.kind ?? (d.project.clientName ? "fulfilment" : "internal"));
  const dates = w?.startsOn || w?.dueOn ? `${w.startsOn ? shortDay(w.startsOn) : "…"} → ${w.dueOn ? shortDay(w.dueOn) : "no due date"}` : null;
  const myAsks = (w?.asks ?? []).filter((a) => a.incoming || a.actions.length);
  return (
    <Page fit>
      <PageHeader title={d.project.name} back={{ href: "/tasks?view=projects", label: "Projects" }} recent={{ title: `${d.project.name} · ${kind === "fulfilment" ? "fulfilment" : "project"}` }}
        context={[w?.categoryLabel ? <ProjectChip key="cat" id={null} name={w.categoryLabel} color={w.color} icon={w.icon} link={false} /> : <KindChip key="k" kind={kind} />, kind === "fulfilment" ? <span key="c">for <Link href={`/projects/${d.project.id}`}>{w?.clientName ?? d.project.clientName ?? "its client package"}</Link></span> : w?.pod ?? null,
          w?.ownerName ? `Owner: ${w.ownerName}` : "No owner yet", dates, w && w.status !== "active" ? STATE[w.status] : null, d.project.requiresProof ? "Proof needed before acceptance" : null]}
        actions={<>
          {d.canEdit ? <NewTaskButton projectId={d.project.id} primary /> : null}
          {w && !w.inside ? <AskToJoin projectId={d.project.id} /> : null}
          {w?.canManage ? <EditProject projectId={d.project.id} kind={w.kind} name={d.project.name} ownerId={w.ownerId} startsOn={w.startsOn} dueOn={w.dueOn} status={w.status} summary={w.summary} /> : null}
          {kind === "fulfilment" ? <Link className={styles.btn} href={`/projects/${d.project.id}`}><Package size={13} aria-hidden="true" />Client package</Link> : null}
          {/* KAZUK: Kazuk's project screen: Timeline and Status (pause, hold, discontinue with a reason). */}
          <Link className={styles.btn} href={`/tasks/projects/${d.project.id}/timeline`}><CalendarDays size={13} aria-hidden="true" />Timeline</Link>
          {w?.canManage ? <ProjectStatusButton projectId={d.project.id} status={w.status === "cancelled" ? "discontinued" : w.status === "paused" ? "paused" : "active"} /> : null}
        </>} />
      <div className={css.shell} data-grow="">
        {myAsks.map((a) => <AskBanner key={a.id} ask={a} highlight={q.ask === a.id} />)}
        {runs.length ? <ProjectWorkflows projectId={d.project.id} runs={runs} canStart={!!w?.canManage} /> : null}
        {w && kind === "fulfilment" && !w.setUp && (w.canManage || d.canProof) ? <div className={css.callout}><Package size={18} aria-hidden="true" />
          <div><b>This fulfilment is not set up yet</b><span>Give it an owner, the people who deliver it, a due date, and optionally a template such as Video package: shoot → edit → review → deliver.</span></div>
          <SetUpButton clientProjectId={d.project.id} /></div> : null}
        {/* TASKS-4A: the project's tasks get the whole width in any view (the list is the task tree, blocked first); the
            discussion, people and what finished after what sit beside them. */}
        <div className={pcss.grid} data-grow="">
          <section className={pcss.main} aria-label="Tasks" data-grow="">
            {/* KAZUK (28 Oct 2026): the project as in the Projects tab screen 2 when it has a delivery plan; else the offer to set one up. */}
            <ProjectPlan projectId={d.project.id} tab={q.pt} />
            {/* Owner workbench (21 Oct 2026): the project at a glance as one strip of figures, only when it has tasks. */}
            {counted.length ? <div className={pp.glance}><StatStrip>
              <Stat value={`${pct}%`} label="done" />
              <Stat value={open} label={open === 1 ? "open task" : "open tasks"} />
              <Stat value={blocked.length} label="blocked" />
              <Stat value={finished} label="finished" />
              {w ? <Stat value={1 + w.members.filter((m) => m.role === "member").length} label="people" /> : null}
            </StatStrip><span className={pp.bar} role="img" aria-label={`${pct}% done: ${finished} of ${counted.length}`}><i style={{ width: `${pct}%` }} /></span></div> : null}
            <TaskViews place="project" prefKey="project" rows={list.data?.rows ?? d.tasks} today={today} me={list.data?.me ?? null} initial={initial} ask={p?.ask ?? null} saved={p?.saved ?? []}
              listSlot={d.tasks.length ? <div className={pcss.tree}>{tree(null)}</div> : undefined}
              empty={counted.length ? <EmptyState center icon={<CheckCheck />} hue="green" title="All tasks are finished" action={d.canEdit ? <NewTaskButton projectId={d.project.id} primary /> : undefined}>
                {plural(finished, "task")} done. Add the next one when there is more to do.</EmptyState>
                : <EmptyState center icon={<ListTree />} hue="indigo" title="No tasks in this project yet" action={d.canEdit ? <NewTaskButton projectId={d.project.id} primary /> : undefined}>
                {d.canEdit ? "Add the first task, or press C anywhere and choose this project." : "Tasks appear here as people add them."}</EmptyState>} />
          </section>
          <aside className={pcss.side} aria-label="People, discussion and settings">
            <ScopePanel projectId={d.project.id} className={css.panel} headClassName={css.panelHead} />
            <FromTheChats projectId={d.project.id} className={css.panel} headClassName={css.panelHead} />
            <HandoverTargets projectId={d.project.id} className={css.panel} headClassName={css.panelHead} />
            <section className={css.panel} aria-label="People" data-fixed="">
              <div className={css.panelHead}><h3><Users size={14} aria-hidden="true" /> People</h3><small>{w ? plural(1 + w.members.filter((m) => m.role === "member").length, "person", "people") : null}</small></div>
              {w ? <ProjectPeople projectId={d.project.id} owner={{ id: w.ownerId, name: w.ownerName, photoAt: w.ownerPhotoAt }} members={w.members} canManage={w.canManage} onIt={w.onIt} /> : null}
              {kind === "fulfilment" && w?.scope ? <p className={css.note}><Package size={12} aria-hidden="true" /> Package: {w.scope}</p> : null}
              {dates ? <p className={css.note}><CalendarDays size={12} aria-hidden="true" /> {dates}</p> : null}
              {w?.canManage && fit.length ? <details className={pp.fold}><summary><Sparkles size={13} aria-hidden="true" />Who fits</summary>
                <SuggestedPeople projectId={d.project.id} canAdd={w.canManage} people={fit.filter((f) => f.id !== w.ownerId && !w.members.some((m) => m.id === f.id && m.role === "member")).slice(0, 3)} /></details> : null}
            </section>
            <section className={css.panel} aria-label="Discussion" data-fixed="">
              <div className={css.panelHead}><h3><MessageSquare size={14} aria-hidden="true" /> Discussion</h3><small>{w?.comments.length ? plural(w.comments.length, "comment") : null}</small></div>
              {w?.summary ? <p className={css.summary}>{w.summary}</p> : null}
              {w?.inside ? <Threads projectId={d.project.id} comments={w.comments} canComment canResolve={w.canManage} /> : <p className={css.empty}>Ask to join to see and take part in the discussion.</p>}
            </section>
            {w?.inside || w?.canManage ? <section className={css.panel} aria-label="This project" data-fixed="">
              <div className={css.panelHead}><h3>This project</h3></div>
              <div className={pp.settings}>
                {w?.inside ? <WatchButton projectId={d.project.id} watching={w.watching} /> : null}
                {w?.canManage ? <ProjectStyle projectId={d.project.id} category={w.categorySet ? w.category ?? null : null} color={w.color ?? null} icon={w.icon ?? null} /> : null}
                {!runs.length ? <ProjectWorkflows projectId={d.project.id} runs={runs} canStart={!!w?.canManage} /> : null}
                {w?.canManage && w.kind === "internal" ? <DeleteProjectButton projectId={d.project.id} /> : null}
              </div>
            </section> : null}
            {d.timeline.length ? <details className={`${css.panel} ${pp.fold}`} data-fixed="">
              <summary><CheckCheck size={14} aria-hidden="true" /> What was finished after what <small>{d.timeline.length}</small></summary>
              <ol className={css.timeline}>{d.timeline.map((t, i) => {
                const day = t.doneAt ? zoneDay(zone, t.doneAt) : t.workOn!;
                const after = i ? d.timeline[i - 1] : null;
                return <li key={t.id}><time dateTime={day}>{shortDay(day)} {day.slice(0, 4)}</time><Link href={`/tasks/${t.id}`}>{t.title}</Link>
                  <small>{t.assigneeName ?? "Unassigned"}{after ? ` · after “${after.title.length > 40 ? `${after.title.slice(0, 39)}…` : after.title}”` : " · first"}</small>
                  {t.valueNote ? <small>{t.valueNote}</small> : null}{t.status !== "accepted" ? <span><Chip>{STATUS[t.status]?.label}</Chip></span> : null}</li>;
              })}</ol>
            </details> : null}
          </aside>
        </div>
      </div>
    </Page>
  );
}
