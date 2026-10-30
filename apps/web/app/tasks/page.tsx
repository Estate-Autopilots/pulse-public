import Link from "next/link";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { CalendarClock, ChevronDown, Compass, CornerDownRight, FolderKanban, GitBranch, Hourglass, Inbox, LayoutDashboard, ListChecks, Search, ShieldCheck, Sparkles, Trash2, Unlock, UserX, UsersRound } from "lucide-react";
import { api, getMe, teamWords } from "../lib/api";
import { count, plural } from "../lib/format";
import { Avatar, Message, Page, PageHeader, Pager, PartFailed, styles } from "../ui";
import { NewTask } from "./new-task";
import { ByDevice, HelpHint, Menu } from "../kit";
import { Tabs } from "@pulse/design-system/ui";
import { TaskRow } from "./client";
import { MyWork } from "./my-work";
import { RestoreButton, RestoreProjectButton } from "./delete";
import { NudgeButton } from "./blocking";
import { PoolProposals, type PoolBatch } from "./pool-proposals";
import w3 from "./work3.module.css";
import { TodaysFocus } from "./board";
import { urgency } from "../lib/task-sense.mjs";
import { TeamDashboard } from "./dashboard";
import { ReviewQueue } from "./life";
import type { ReviewPolicy, ReviewRow } from "./types";
import { WorkProjects } from "./projects-view";
import { ProjectsOverview } from "../projects/overview";
import { MyScoreCard, PeopleView, TeamTodayCard } from "./people-view";
import type { Ask } from "./work-client";
import type { PoolTask } from "./work-two";
import { Chip, STATUS } from "./parts";
import type { Home, Task } from "./types";
import { TaskViews, type BuiltIn } from "./views/task-views";
import { ScopeBar, UrlSelect } from "./views/scope-bar";
import { PhoneWorkBar } from "./phone-bar";
import { readConfig, type Place, type ViewPrefs } from "./views/model";
import vcss from "./views/views.module.css";
import css from "./tasks.module.css";
import { lower } from "../lib/words.mjs";
import { vocabulary } from "../lib/api";

/** The request's moment: server components render once per request. */
const clock = () => Date.now();

type All = { rows: Task[]; total: number; page: number; size: number; statuses: { status: string; n: number }[]; types: { type: string; n: number }[]; mine: number; me: string | null; canLead: boolean };
type Blocking = { groups: { ownerId: string | null; ownerName: string; pod: string | null; items: { blockerId: string; title: string; status: string; project: string | null; dueAt: string | null; since: string; waiting: { id: string; title: string; owner: string | null; project: string | null; priority: string; since: string; note: string | null }[] }[] }[]; manual: (Task & { blockedSince: string | null; blockedNote: string | null })[]; waiting: number };
type WorkList = { scope: Place; pod: string | null; pods: string[]; myPod: string | null; me: string | null; today: string; canAll: boolean; openCount: number; truncated: boolean; rows: Task[];
  person: { id: string; name: string; role: string | null; pod: string | null; photoAt: string | null } | null; project: { id: string; name: string; kind?: string | null } | null; labels: { team: string; teams: string } };
/** Pages of their own (not a view of a list): reached from the header, the Views menu and old links. */
const PAGES = ["team", "people", "blocking", "deleted", "all", "reviews"] as const;
const days = (iso: string) => Math.max(0, Math.round((clock() - Date.parse(iso)) / 86400000));

/** Which list a URL asks for. TASKS-4A's `scope`, or the older `view` links (My tasks, Board, Pool, a person's board). */
function placeOf(q: Record<string, string>, me: string | null): Place {
  const s = q.scope === "mine" ? "me" : q.scope === "all" ? "company" : q.scope;
  if (s && ["me", "pod", "company", "person", "project", "pool"].includes(s) && (s !== "person" || q.person) && (s !== "project" || q.project) && (s !== "me" || me)) return s as Place;
  if (q.view === "pool") return "pool";
  if (q.view === "board") return q.person ? "person" : me ? "pod" : "company";
  return me ? "me" : "company";
}

export default async function Tasks({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  if (q.view === "week") {
    const period = new URLSearchParams();
    for (const key of ["week", "period", "from", "to"] as const) if (q[key]) period.set(key, q[key]);
    redirect(period.toString() ? `/my-week?${period}` : "/my-week");
  }
  if (q.task && /^[0-9a-f-]{36}$/.test(q.task)) redirect(`/tasks/${q.task}`);
  const [home, words, me] = await Promise.all([api<Home>("tasks/home"), teamWords(), getMe()]);
  if (home.error) return <Message text={home.error} />;
  const h = home.data!;
  if (me.data?.side === "client") return <ClientTasks h={h} />;
  // TASKS-4A: one switch, Tasks | Projects. Under Tasks, whose tasks (scope) and how to see them (views); the pool and
  // what is blocking us are ready-made views, the team dashboard and outcomes are pages in the header.
  const section = q.view === "projects" || q.s === "projects" ? "projects" : "tasks";
  const listy = !q.scope && !!(q.q || q.status || q.project || q.person || q.mine || q.tracker || q.type || q.column) && q.view !== "board" && q.view !== "pool";
  const page = section === "tasks" ? (PAGES as readonly string[]).includes(q.view) ? q.view : listy ? "all" : null : null;
  const leads = h.canLead || h.workRole === "leadership" || h.workRole === "hr" || h.workRole === "pod_head";
  const place = placeOf(q, h.me);
  const now = clock();
  const open = h.rows.filter((t) => ["open", "in_progress", "blocked", "unknown"].includes(t.status)).length;
  const dueToday = h.rows.filter((t) => ["open", "in_progress", "blocked"].includes(t.status) && t.dueOn && t.dueOn <= h.today).length;
  // UX-SIMPLE (28 Oct 2026): two plain facts under the title; the streak was a badge, not something to act on.
  const context = [h.me ? `${plural(open, "open task")} of yours` : `${words.team} tasks`, dueToday ? `${dueToday} due today or late` : null];
  const href = (over: Record<string, string | undefined>) => { const n = new URLSearchParams(); for (const [k, v] of Object.entries({ ...q, ...over })) if (v) n.set(k, v); const s = n.toString(); return s ? `/tasks?${s}` : "/tasks"; };
  const pageTitle: Record<string, string> = { team: `${words.team} dashboard`, people: "People", blocking: "What’s blocking us", deleted: "Recently deleted", all: "All tasks", reviews: "Reviews" };
  return (
    <Page fit>
      <PageHeader title="Work" context={context} actions={h.me ? <NewTask /> : undefined} />
      <div className={css.shell} data-grow="">
        <div className={css.bar}>
          {/* UX-SIMPLE (28 Oct 2026): Kazuk's three places, My work, Projects and People (for those who lead); everything
              else Work holds (the team dashboard, outcomes, reviews, the pool, what is blocking us, search, deleted) waits
              in More, so the first screen asks one question. */}
          <div className={css.placeTabs}>
            <Tabs label="Work" current={section === "projects" ? "projects" : page === "people" ? "people" : page ? "" : "tasks"} items={[
              { key: "tasks", label: "My work", icon: <ListChecks />, href: "/tasks" },
              { key: "projects", label: "Projects", icon: <FolderKanban />, href: "/tasks?view=projects" },
              ...(leads ? [{ key: "people", label: "People", icon: <UsersRound />, href: "/tasks?view=people" }] : [])]} />
            <Menu label="More in Work" buttonLabel="More in Work" title="More" className={`${styles.btn} ${css.moreBtn}`} items={[
              ...(leads ? [{ key: "team", label: `${words.team} dashboard`, icon: <LayoutDashboard size={15} aria-hidden="true" />, href: "/tasks?view=team" }] : []),
              { key: "outcomes", label: h.mode === "outcome" ? "My outcomes" : "Outcomes", icon: <Sparkles size={15} aria-hidden="true" />, href: "/tasks/outcomes" },
              { key: "reviews", label: "Reviews", icon: <ShieldCheck size={15} aria-hidden="true" />, href: "/tasks?view=reviews" },
              { key: "pool", label: "The pool", icon: <Inbox size={15} aria-hidden="true" />, href: "/tasks?scope=pool", separator: true },
              ...(h.canLead ? [{ key: "blocking", label: "What’s blocking us", icon: <Hourglass size={15} aria-hidden="true" />, href: "/tasks?view=blocking" }] : []),
              { key: "all", label: "Search all tasks", icon: <Search size={15} aria-hidden="true" />, href: "/tasks?view=all" },
              { key: "deleted", label: "Recently deleted", icon: <Trash2 size={15} aria-hidden="true" />, href: "/tasks?view=deleted" }]}>
              More<ChevronDown size={14} aria-hidden="true" />
            </Menu>
          </div>
          {/* WORK-UX: requests waiting for an answer are one chip at the end of the tabs row, not a banner above it. */}
          {h.me && h.asks && !(place === "me" && !page) ? <Link href="/tasks?scope=me#asks" className={css.asksBar}><Sparkles size={14} aria-hidden="true" /><b>{plural(h.asks, "request")} waiting for your answer</b><span>Open My tasks to accept or decline</span></Link> : null}
          {/* WORK-UX: People is a tab of its own, so it needs no "Tasks › People" trail beside the tabs. */}
          {page && page !== "people" ? <span className={vcss.place}><Link className={w3.quietLink} href="/tasks">Tasks</Link><span aria-hidden="true">›</span><h2>{pageTitle[page]}</h2></span> : null}
          {page === "all" ? <form className={styles.search} action="/tasks" role="search"><input type="hidden" name="view" value="all" /><Search size={14} aria-hidden="true" /><input className={styles.input} type="search" name="q" defaultValue={q.q ?? ""} placeholder="Search tasks, people, projects…" aria-label="Search tasks" /></form> : null}
        </div>
        {/* KAZUK (28 Oct 2026): Work → Projects is the project-management home, as in the Projects tab screens (the lead's
            "My projects", leadership's "All projects"); the full list, the filing review and the timeline layout stay one link away. */}
        {section === "projects" ? (q.list || q.review || q.pl || q.kind || q.cat || q.mine || q.show || q.page ? <WorkProjects q={q} today={h.today} /> : <ProjectsOverview scope={q.scope} pod={q.pod} q={q.q} />)
          : page === "team" ? <TeamDashboard q={q} /> : page === "people" ? <PeopleView q={q} /> : page === "blocking" ? <BlockingPage me={h.me} /> : page === "deleted" ? <DeletedPage /> : page === "all" ? <AllPage q={q} today={h.today} me={h.me} href={href} />
          : page === "reviews" ? <ReviewsPage />
          : place === "pool" ? <PoolPlace q={q} h={h} leads={h.canLead} team={words.team} />
          : <TasksPlace q={q} h={h} place={place} now={now} leads={leads} team={words.team} />}
      </div>
    </Page>
  );
}

/** Ready-made views for the Views menu. */
function readyMade(place: Place, h: Home, current?: string): BuiltIn[] {
  return [
    { key: "pool", label: "The pool", href: "/tasks?scope=pool", icon: <Inbox size={14} aria-hidden="true" />, current: current === "pool" },
    ...(h.canLead ? [{ key: "blocking", label: "What’s blocking us", href: "/tasks?view=blocking", icon: <Hourglass size={14} aria-hidden="true" /> }] : []),
    { key: "week", label: "Due this week", href: `/tasks?scope=${place === "pool" ? "company" : place}&due=week`, icon: <CalendarClock size={14} aria-hidden="true" /> },
    { key: "unassigned", label: "Nobody has it yet", href: "/tasks?scope=company&people=none&layout=table", icon: <UserX size={14} aria-hidden="true" /> },
    { key: "all", label: "All tasks (search)", href: "/tasks?view=all", icon: <Search size={14} aria-hidden="true" /> },
    { key: "map", label: "Unlock map", href: "/tasks/map", icon: <GitBranch size={14} aria-hidden="true" /> },
    { key: "deleted", label: "Recently deleted", href: "/tasks?view=deleted", icon: <Trash2 size={14} aria-hidden="true" /> },
  ];
}
/** The URL's older names for a view: Board (with By when / By status). */
function legacy(q: Record<string, string>): Record<string, string> {
  if (q.view !== "board") return q;
  return { ...q, layout: q.layout ?? "board", group: q.group === "status" ? "status" : q.group === "focus" || q.scope === "person" || q.scope === "mine" ? "when" : "status" };
}

/** One scope's tasks in the person's view of choice. My tasks keeps its own list (focus, requests, selection). */
async function TasksPlace({ q, h, place, now, leads, team }: { q: Record<string, string>; h: Home; place: Place; now: number; leads: boolean; team: string }) {
  const params = new URLSearchParams({ scope: place }); if (place === "person") params.set("person", q.person); if (place === "project") params.set("project", q.project); if (place === "pod" && q.pod) params.set("pod", q.pod);
  const [list, prefs] = await Promise.all([api<WorkList>(`work/list?${params}`), h.me ? api<ViewPrefs>(`work/views?place=${place}`) : Promise.resolve(null)]);
  if (list.error) return <PartFailed error={list.error} />;
  const d = list.data!, p = prefs?.data ?? null;
  const initial = readConfig(legacy(q), p?.config ?? null, place, p?.defaultLayout ?? p?.layout ?? null);
  const who = d.person;
  const head = place === "person" && who ? <div className={vcss.place}><Avatar name={who.name} id={who.id} photoAt={who.photoAt} size={32} status />
      <div><h2>{who.id === h.me ? "Your work" : `${who.name.split(" ")[0]}’s work`}</h2><small>{[who.role, who.pod].filter(Boolean).join(" · ")}{" · "}<Link href={`/tasks/people/${who.id}`}>Open their page</Link></small></div></div>
    : place === "project" && d.project ? <div className={vcss.place}><FolderKanban size={18} aria-hidden="true" /><div><h2>{d.project.name}</h2><small><Link href={`/tasks/projects/${d.project.id}`}>Open the project</Link></small></div></div>
    : place === "pod" ? <div className={vcss.place}><div><h2>{d.pod ? `${d.pod}` : `Your ${team.toLowerCase()}`}</h2><small>{plural(d.openCount, "open task")}{leads && d.pods.length > 1 ? <> · <UrlSelect param="pod" label={team} value={d.pod ?? ""} options={d.pods.map((x) => ({ value: x, label: x }))} /></> : null}</small></div></div>
    : place === "company" ? <div className={vcss.place}><div><h2>Company</h2><small>{plural(d.openCount, "open task")} you can see{d.truncated ? " · the first 700 by due date" : ""}</small></div></div> : null;
  const scopeLabel = place === "me" ? "Me" : place === "pod" ? d.pod ?? `My ${team.toLowerCase()}` : place === "company" ? "Company" : place === "person" && who ? who.name.split(" ")[0] : place === "project" && d.project ? d.project.name : "Tasks";
  return <div className={css.controlsHost} data-work-controls="">
    <PhoneWorkBar label={scopeLabel} />
    {head}
    {/* WORK-UX (owner, 29 Oct 2026, report #1): Up next sits in My work's right rail; another layout keeps it above. */}
    {place === "me" && h.me && initial.layout !== "list" ? <TodaysFocus tasks={h.rows} now={now} whose={null} /> : null}
    <TaskViews place={place} prefKey={place} rows={d.rows} today={d.today} me={d.me} initial={initial} ask={p?.ask ?? null} saved={p?.saved ?? []} builtIns={readyMade(place, h)}
      lead={<ScopeBar place={place} me={h.me} team={team} myPod={h.me ? d.myPod : null} person={who} project={d.project} />}
      listSlot={place === "me" ? <MeView h={h} tab={q.tab} lens={q.lens} leads={leads} focus={h.me ? <TodaysFocus tasks={h.rows} now={now} whose={null} rail /> : null} /> : undefined} domainOwner={place === "person" && who && who.id !== h.me ? who.name.split(" ")[0] : undefined}
      empty={<p className={vcss.empty}><b>No open tasks here</b>{place === "me" ? <ByDevice keys="Press N to add one, or take something from the pool." touch="Tap New task to add one, or take something from the pool." />
        : <ByDevice keys="Use New task (or press N) to add one." touch="Tap New task to add one." />}</p>} />
  </div>;
}

async function MeView({ h, tab, lens, leads, focus }: { h: Home; tab?: string; lens?: string; leads: boolean; focus?: ReactNode }) {
  const asks = h.me ? (await api<{ incoming: Ask[]; outgoing: Ask[] }>("work/asks")).data : null;
  // TASKS-3: one list (nothing hidden behind a tab), the week beside it, and what shipped.
  return <div className={w3.me} data-grow="">
    <div className={w3.meMain}>
      <MyWork home={h} asks={[...(asks?.incoming ?? []), ...(asks?.outgoing ?? [])]} initialTab={tab} initialLens={lens} />
    </div>
    <aside className={w3.rail} aria-label="Your week">
      {focus}
      {/* UX-SIMPLE (28 Oct 2026): one card for a lead (who needs them), one for everyone else (how they are doing). The
          week chart and the domains live on the person's page and in More → Outcomes. */}
      {leads ? <TeamTodayCard /> : h.me ? <MyScoreCard me={h.me} /> : null}
    </aside>
  </div>;
}

type Deleted = { rows: { id: string; title: string; deletedAt: string; deletedBy: string | null; note: string | null; projectName: string | null; subtasks: number; restoreUntil: string }[] };
/** Recently deleted: what the viewer may restore, for 30 days. */
async function DeletedPage() {
  const [r, pr] = await Promise.all([api<Deleted>("tasks/deleted"), api<{ rows: { id: string; name: string; deletedAt: string; deletedBy: string | null; note: string | null; tasks: number; restoreUntil: string }[] }>("work/projects/deleted")]);
  if (r.error) return <PartFailed error={r.error} />;
  const rows = r.data!.rows; const now = clock(); const projects = pr.data?.rows ?? [];
  const left = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - now) / 86400000));
  return <section className={w3.listPanel} aria-label="Recently deleted">
    <div className={w3.cardHead}><h3><Trash2 size={15} aria-hidden="true" />Recently deleted</h3><small>{rows.length ? plural(rows.length, "task") : null}</small></div>
    <p className={w3.line} style={{ padding: "0 16px 8px" }}>Tasks and projects you deleted, created, or own. Each can be restored for 30 days, with its subtasks or tasks.</p>
    <div className={w3.scroller}>
      {/* TASKS-4B: projects come back with all their tasks. */}
      {projects.length ? <ul className={w3.rows} aria-label="Deleted projects">{projects.map((p) => <li key={p.id} className={w3.deletedRow}>
        <FolderKanban size={16} aria-hidden="true" />
        <span className={w3.deletedMain}><b title={p.name}>{p.name}</b>
          <small>{[p.deletedBy ? `Project deleted by ${p.deletedBy}` : "Project deleted", p.tasks ? `with ${plural(p.tasks, "task")}` : null, `${plural(left(p.restoreUntil), "day")} left to restore`, p.note].filter(Boolean).join(" · ")}</small></span>
        <RestoreProjectButton id={p.id} name={p.name} /></li>)}</ul> : null}
      {rows.length ? <ul className={w3.rows}>{rows.map((t) => <li key={t.id} className={w3.deletedRow}>
      <Trash2 size={16} aria-hidden="true" />
      <span className={w3.deletedMain}><b title={t.title}>{t.title}</b>
        <small>{[t.deletedBy ? `Deleted by ${t.deletedBy}` : "Deleted", t.projectName, t.subtasks ? plural(t.subtasks, "subtask") : null, `${plural(left(t.restoreUntil), "day")} left to restore`, t.note].filter(Boolean).join(" · ")}</small></span>
      <RestoreButton id={t.id} title={t.title} /></li>)}</ul>
      : projects.length ? null : <p className={w3.empty}><b>Nothing deleted</b>Deleted tasks and projects wait here for 30 days in case you need them back.</p>}</div>
  </section>;
}

type Pool = { rows: PoolTask[]; total: number; fits: number; claimedWeek: { n: number }; canPool: boolean; pools: { scope: string; ref: string | null }[]; mine: { pod: string | null; department: string | null } };
/** The pool: tasks with nobody yet, most urgent first, as cards to claim (any view works); leaders see what Pulse
 *  proposes for it beside it. Less text than before: what the pool is lives in the "?". */
async function PoolPlace({ q, h, leads, team }: { q: Record<string, string>; h: Home; leads: boolean; team: string }) {
  const words = await vocabulary();
  const params = new URLSearchParams(); for (const k of ["fits"]) if (q[k]) params.set(k, q[k]);
  const [r, proposed, prefs] = await Promise.all([api<Pool>(`work/pool?${params}`), leads ? api<{ batches: PoolBatch[]; canDecide: boolean }>("work/pool/proposals") : Promise.resolve(null),
    h.me ? api<ViewPrefs>("work/views?place=pool") : Promise.resolve(null)]);
  if (r.error) return <PartFailed error={r.error} />;
  const d = r.data!, p = prefs?.data ?? null;
  const initial = readConfig(q, p?.config ?? null, "pool", p?.defaultLayout ?? p?.layout ?? null);
  // TASKS-3: what Pulse proposes for the pool sits beside it (below it on a phone), so the pool keeps its height.
  const side = proposed?.data ? <aside className={w3.poolSide} aria-label="Proposed work"><PoolProposals batches={proposed.data.batches} canDecide={proposed.data.canDecide} /></aside> : null;
  const pool = <section className={vcss.views} aria-label="The pool" data-grow="">
    <ScopeBar place="pool" me={h.me} team={team} myPod={h.me ? d.mine.pod : null} person={null} project={null} />
    <div className={vcss.poolBar}>
      <span className={vcss.poolStat}><b>{count(d.total)}</b>to claim</span>
      <Link className={styles.segment} href={q.fits === "1" ? "/tasks?scope=pool" : "/tasks?scope=pool&fits=1"} aria-current={q.fits === "1" ? "true" : undefined}><Compass size={13} aria-hidden="true" />Fits my domains · {count(d.fits)}</Link>
      {d.claimedWeek.n ? <span className={vcss.poolStat}><b>{d.claimedWeek.n}</b>claimed by you this week</span> : null}
      <HelpHint label="How the pool works" title="The pool">Tasks nobody has yet. Anyone eligible claims one; the first claim wins. Tasks carry no value points.</HelpHint>
    </div>
    <TaskViews place="pool" prefKey="pool" rows={d.rows} today={h.today} me={h.me} initial={initial} ask={p?.ask ?? null} saved={p?.saved ?? []} builtIns={readyMade("pool", h, "pool")} pool
      empty={<p className={vcss.empty}><b>{q.fits === "1" ? "Nothing in the pool fits your domains" : "The pool is empty"}</b>{q.fits === "1" ? <Link href="/tasks?scope=pool">See everything in the pool</Link> : d.canPool ? "Press + New, choose Pool under Who, and the task waits here." : `Leaders, HR and ${lower(words.team)} heads put tasks here for anyone eligible to claim.`}</p>} />
  </section>;
  return side ? <div className={w3.poolGrid} data-grow="">{pool}{side}</div> : pool;
}

type Biggest = { rows: { id: string; title: string; status: string; personId: string | null; personName: string | null; photoAt: string | null; dueOn: string | null; dueAt: string | null; projectName: string | null; waiting: number; people: number; minutes: number }[] };
type Waiter = { id: string; title: string; owner: string | null; ownerId: string | null; photoAt: string | null; project: string | null; priority: string; since: string; note: string | null };
type BlockGroup = { ownerId: string | null; ownerName: string; pod: string | null; photoAt: string | null; items: { blockerId: string; title: string; status: string; project: string | null; dueAt: string | null; since: string; waiting: Waiter[] }[] };
/** TASKS-3: what is blocking us, as cards: whose work everyone waits on, for how long, how much waits, and a nudge. */
async function BlockingPage({ me }: { me: string | null }) {
  const [r, big] = await Promise.all([api<Omit<Blocking, "groups"> & { groups: BlockGroup[] }>("tasks/blocking"), api<Biggest>("tasks/biggest-blockers")]);
  if (r.error) return <PartFailed error={r.error} />;
  const d = r.data!; const now = clock();
  if (!d.groups.length && !d.manual.length) return <section className={w3.listPanel}><p className={w3.empty}><Unlock size={22} aria-hidden="true" /><b>Nothing is blocked</b>When a task waits on another, it shows here under the person whose work everyone waits on.</p></section>;
  const waitingOf = (g: BlockGroup) => g.items.reduce((n, i) => n + i.waiting.length, 0);
  const oldest = (g: BlockGroup) => Math.max(...g.items.map((i) => days(i.since)));
  const people = new Set(d.groups.flatMap((g) => g.items.flatMap((i) => i.waiting.map((w) => w.ownerId)).filter(Boolean)));
  return <div className={w3.blocking}>
    <section className={w3.blockStats} aria-label="At a glance">
      <span><b>{d.waiting}</b>{d.waiting === 1 ? "task waiting" : "tasks waiting"}</span>
      <span><b>{d.groups.length}</b>{d.groups.length === 1 ? "person they wait on" : "people they wait on"}</span>
      <span><b>{people.size}</b>{people.size === 1 ? "person held up" : "people held up"}</span>
      <span><b>{Math.max(0, ...d.groups.map(oldest))} d</b>longest wait</span>
      <Link className={w3.quietLink} href="/tasks/map"><GitBranch size={13} aria-hidden="true" />Unlock map</Link>
    </section>
    <div className={w3.blockGrid}>
      <section className={w3.listPanel} aria-label="Who the work waits on">
        <div className={w3.cardHead}><h3>Who the work waits on</h3><small>most waiting first</small></div>
        <div className={w3.scroller}><ul className={w3.owners}>{d.groups.map((g) => <li key={g.ownerId ?? "nobody"} className={w3.owner}>
          <div className={w3.ownerHead}>
            {g.ownerId ? <Avatar name={g.ownerName} id={g.ownerId} photoAt={g.photoAt} size={36} status /> : <span className={w3.nobodyAvatar}>?</span>}
            <span className={w3.ownerName}><b>{g.ownerName}</b><small>{[g.pod, `${plural(waitingOf(g), "task")} waiting`, `oldest ${oldest(g) ? `${oldest(g)} d` : "today"}`].filter(Boolean).join(" · ")}</small></span>
          </div>
          <ul className={w3.blockers}>{g.items.map((i) => { const u = urgency({ status: i.status, dueAt: i.dueAt }, now); return <li key={i.blockerId}>
            <div className={w3.blockerTop}>
              <Link href={`/tasks/${i.blockerId}`} className={w3.blockerTitle}>{i.title}</Link>
              <span className={w3.blockerFacts}><span className={w3.fact}>{STATUS[i.status]?.label ?? i.status}</span>{u.key !== "none" ? <span className={w3.fact} data-tone={u.tone === "late" ? "late" : u.tone === "now" ? "now" : undefined}>{u.short}</span> : null}
                <span className={w3.fact} data-tone={days(i.since) >= 3 ? "late" : undefined}>{days(i.since) ? `stuck ${days(i.since)} d` : "since today"}</span>{i.project ? <span className={w3.fact}>{i.project}</span> : null}</span>
              {g.ownerId !== me ? <NudgeButton taskId={i.blockerId} ownerId={g.ownerId} ownerName={g.ownerName} waiting={i.waiting.length} people={new Set(i.waiting.map((w) => w.ownerId)).size} /> : null}
            </div>
            <ul className={w3.waiters}>{i.waiting.map((w) => <li key={w.id}>
              <CornerDownRight size={13} aria-hidden="true" />{w.owner ? <Avatar name={w.owner} id={w.ownerId ?? undefined} photoAt={w.photoAt} size={20} /> : null}
              <Link href={`/tasks/${w.id}`}>{w.title}</Link><small>{[w.owner?.split(" ")[0], w.note].filter(Boolean).join(" · ")}</small></li>)}</ul>
          </li>; })}</ul>
        </li>)}</ul></div>
      </section>
      <aside className={w3.rail} aria-label="More on blockers">
        {big.data?.rows.length ? <section className={w3.card} aria-label="Biggest blockers">
          <div className={w3.cardHead}><h3>Biggest blockers</h3><small>most work waiting</small></div>
          <div className={w3.cardBody}><ol className={w3.biggest}>{big.data.rows.slice(0, 5).map((b) => <li key={b.id}>
            {b.personName ? <Avatar name={b.personName} id={b.personId ?? undefined} photoAt={b.photoAt} size={26} /> : <span className={w3.nobodyAvatar}>?</span>}
            <span><Link href={`/tasks/${b.id}`}>{b.title}</Link><small>{b.personName ?? "Nobody yet"} · {plural(b.waiting, "task")} for {plural(b.people, "person", "people")}</small></span>
            {b.minutes ? <span className={w3.fact}>about {Math.round(b.minutes / 6) / 10} h</span> : <span />}</li>)}</ol></div>
        </section> : null}
        {d.manual.length ? <section className={w3.card} aria-label="Blocked without a linked task">
          <div className={w3.cardHead}><h3>Blocked, but on what?</h3><small>{d.manual.length}</small></div>
          <div className={w3.cardBody}><p className={w3.line}>Marked blocked by hand. Ask what each waits on and add it as a blocker, so someone owns it.</p>
            <ul className={w3.shipped}>{d.manual.slice(0, 8).map((t) => <li key={t.id}><Link href={`/tasks/${t.id}`} title={t.title}>{t.title}</Link>
              <span className={w3.fact}>{t.blockedSince ? `${days(t.blockedSince)} d` : "Blocked"}</span>{t.blockedNote || t.assigneeName ? <p>{[t.assigneeName, t.blockedNote].filter(Boolean).join(" · ")}</p> : null}</li>)}</ul></div>
        </section> : null}
      </aside>
    </div>
  </div>;
}

async function AllPage({ q, today, me, href }: { q: Record<string, string>; today: string; me: string | null; href: (o: Record<string, string | undefined>) => string }) {
  const params = new URLSearchParams({ size: "200" }); for (const k of ["q", "status", "project", "person", "mine", "page", "tracker", "type", "column"]) if (q[k]) params.set(k, q[k]);
  const r = await api<All>(`tasks?${params}`);
  if (r.error) return <PartFailed error={r.error} />;
  const d = r.data!; const all = d.statuses.reduce((n, s) => n + s.n, 0); const pages = Math.ceil(d.total / d.size);
  const order = ["open", "in_progress", "blocked", "done", "in_review", "accepted", "unknown", "cancelled"];
  return <section className={css.panel} aria-label="All tasks">
    <div className={css.bar} style={{ padding: "10px 12px" }}>
      <div className={styles.segmented} role="group" aria-label="Status">
        <Link className={styles.segment} href={href({ status: undefined, page: undefined })} aria-current={!q.status ? "true" : undefined}>Any<span className={styles.muted}>{count(all)}</span></Link>
        {order.filter((s) => d.statuses.some((x) => x.status === s)).map((s) => <Link key={s} className={styles.segment} href={href({ status: s, page: undefined })} aria-current={q.status === s ? "true" : undefined}>{STATUS[s].label}<span className={styles.muted}>{count(d.statuses.find((x) => x.status === s)?.n ?? 0)}</span></Link>)}
      </div>
      <span className={css.barStart}>
        <Link className={styles.segment} href={href({ mine: q.mine === "1" ? undefined : "1", page: undefined })} aria-current={q.mine === "1" ? "true" : undefined}>Mine · {count(d.mine)}</Link>
        {d.types.length ? <UrlSelect param="type" label="Type" value={q.type ?? ""} options={[{ value: "", label: "Any type" }, ...d.types.map((t) => ({ value: t.type, label: `${t.type} · ${t.n}` }))]} /> : null}
      </span>
    </div>
    {d.rows.length ? <Pager primary min={4} mobile={14} unit="tasks"><ul className={css.list} data-items="">{d.rows.map((t) => <TaskRow key={t.id} task={t} today={today} me={me} />)}</ul></Pager>
      : <p className={css.empty}><b>{q.q || q.status ? "No tasks match" : "No tasks yet"}</b>{q.q || q.status ? <Link href="/tasks?view=all">Clear the search and filters</Link> : <ByDevice keys="Press N to add one. Tasks from the team trackers appear here too." touch="Tap New task to add one. Tasks from the team trackers appear here too." />}</p>}
    {pages > 1 ? <p className={css.note}><ListChecks size={12} aria-hidden="true" /> Showing {count(d.rows.length)} of {count(d.total)}. {d.page + 1 < pages ? <Link href={href({ page: String(d.page + 1) })}>Next {count(Math.min(d.size, d.total - (d.page + 1) * d.size))}</Link> : null}{d.page > 0 ? <> · <Link href={href({ page: String(d.page - 1) })}>Previous</Link></> : null}</p> : null}
    {q.status === "unknown" ? <p className={css.note}>The tracker gave these no status. Open one and choose To do, Doing or Done; Pulse keeps your choice when the tracker is read again.</p> : null}
  </section>;
}

/** TASKS-4B: Work → Reviews, the reviewer's queue (oldest first, bulk accept). */
async function ReviewsPage() {
  const r = await api<{ rows: ReviewRow[]; policy: ReviewPolicy; quality: { value: string; label: string }[]; me: string }>("tasks/reviews");
  if (r.error || !r.data) return <PartFailed error={r.error ?? "The review queue did not load."} />;
  return <section className={w3.listPanel} aria-label="Reviews">
    <div className={w3.cardHead}><h3><ShieldCheck size={15} aria-hidden="true" />Waiting for your review</h3><small>{r.data.rows.length ? `oldest first · nudged after ${r.data.policy.reviewNudgeHours} h` : null}</small></div>
    <div className={w3.scroller} style={{ padding: "4px 12px 12px" }}><ReviewQueue initial={r.data} /></div>
  </section>;
}

/** E2E-4P: a client of this organisation (ORG's client, or a connected organisation's contact) works only on the tasks
 *  given to them. Work's lists, views and projects are staff routes (403 for a client, which showed "Pulse data is
 *  temporarily unavailable"), so their Work is the list tasks/home already answers for them. */
function ClientTasks({ h }: { h: Home }) {
  const openOnes = h.rows.filter((t) => ["open", "in_progress", "blocked", "unknown"].includes(t.status));
  const rest = h.rows.filter((t) => !openOnes.includes(t));
  return (
    <Page fit>
      {/* E2E-4P: "0 open tasks for you" read like an error; the open ones first, then what is finished, each titled. */}
      <PageHeader title="Work" context={[openOnes.length ? `${plural(openOnes.length, "task")} waiting for you` : h.rows.length ? "Nothing waiting for you" : "Shared work shows here"]} />
      <div className={css.shell} data-grow="">
        {openOnes.length ? <ul className={css.list} data-items="" aria-label="Waiting for you">{openOnes.map((t) => <TaskRow key={t.id} task={t} today={h.today} me={h.me} showAssignee={false} />)}</ul> : null}
        {rest.length ? <><h2 className={css.clientHead}>Finished</h2><ul className={css.list} data-items="" aria-label="Finished">{rest.map((t) => <TaskRow key={t.id} task={t} today={h.today} me={h.me} showAssignee={false} />)}</ul></> : null}
        {!h.rows.length ? <p className={css.empty}><b>Nothing for you here yet</b>Tasks this organisation gives you show here, and in the groups you share.</p> : null}
      </div>
    </Page>
  );
}
