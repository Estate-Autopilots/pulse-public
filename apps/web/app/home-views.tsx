import Link from "next/link";
import type { ReactNode } from "react";
import { CalendarCheck, CalendarOff, CircleCheck, Eye, FolderKanban, Inbox, Users } from "lucide-react";
import type { AttendanceEntry, HomeData, HrHome, LeaveRequest, Me, Period, WorkHome } from "./lib/api";
import { AiBadge } from "./kit";
import { Welcome } from "./welcome";
import { accountLabel, ago, count, day, longDay, periodLabel, periodQuery, plural, projectParts, range, time } from "./lib/format";
import { AttendanceActions, LeaveDecision } from "./hr-controls";
import { Freshness } from "./freshness";
import { PeriodSwitcher } from "./period-switcher";
import { Badge, Delta, DeliveryFeed, Empty, Kpi, Meter, Page, PageHeader, Panel, ProjectLink, Spark, Tiles, WeekChart, Why, styles, Workspace, viewNames } from "./ui";

/** Human headcount and AI employees are separate, including when attendance is off. */
export function PeopleCount({ headcount, ai }: { headcount: number; ai?: number }) {
  // Intentionally clip the leading "·" on each wrapped line; count text stays visible.
  return <span className={styles.peopleCount} data-people-count data-layout-ok><span className={styles.peopleCountRow}><span>People {headcount}</span>{ai != null ? <span><AiBadge /> {ai}</span> : null}</span></span>;
}

type Editor = Extract<HomeData, { view: "editor" }>;
type Hr = Extract<HomeData, { view: "hr" }>;
const baseline = (p: Period) => p.inProgress ? `vs ${p.kind === "this" ? "last week" : "prior period"} at this point` : `vs the ${p.week ? "week" : "period"} before`;
const days = (from: string, to: number) => Math.floor((to - Date.parse(from)) / 86400000);

export function Header({ data, scope, periods = true }: { data: HomeData; scope: string; periods?: boolean }) {
  const f = data.freshness;
  return <PageHeader title="Dashboard" recent={false}
    context={[`${periodLabel(data.period)}, ${range(data.period.from, data.period.to)}`, scope]}
    meta={<Freshness at={f.lastIndexedAt} now={data.generatedAt} sync={f} detail={`${count(f.files)} files, ${count(f.projects)} projects, ${count(f.deliveries)} deliveries indexed`} />}
    actions={data.view === "hr" || !periods ? undefined : <PeriodSwitcher period={data.period} />} />;
}

export function WorkTiles({ data, deliveriesHref, projectsHref, quietHref, mine }: { data: WorkHome & { period: Period }; deliveriesHref: string; projectsHref: string; quietHref: string; mine?: boolean }) {
  const p = data.period; const lastWeek = data.trend.length - 1;
  const inPeriod = (start: string) => start >= p.from && start <= p.to;
  const marked = data.trend.some((w) => inPeriod(w.start));
  const on = (i: number) => marked ? inPeriod(data.trend[i].start) : i === lastWeek;
  return <>
    <Kpi label={mine ? "My deliveries" : "Deliveries"} value={count(data.deliveries)} href={deliveriesHref}
      delta={<Delta value={data.deliveries} previous={data.deliveriesPrev} />} note={baseline(p)}
      spark={<Spark values={data.trend.map((w) => w.deliveries)} on={on} label="Deliveries per week, last 12 weeks" />} />
    <Kpi label="Delivered today" value={count(data.today)} href={deliveriesHref.split("?")[0]}
      note={`${count(data.yesterday)} yesterday`}
      spark={<Spark values={data.daily.map((d) => d.deliveries)} label="Deliveries per day, last 14 days" />} />
    <Kpi label={mine ? "My projects with deliveries" : "Projects with deliveries"} value={count(data.projects)} href={projectsHref}
      delta={<Delta value={data.projects} previous={data.projectsPrev} />} note={baseline(p)}
      spark={<Spark values={data.trend.map((w) => w.projects)} on={on} label="Projects with deliveries per week, last 12 weeks" />} />
    <Kpi label="Needs attention" value={count(data.attention.total)} href={quietHref} tone={data.attention.total ? "warning" : "success"}
      note={data.attention.total ? "No delivery for 14+ days" : "No project has gone quiet"} />
  </>;
}

export function TrendPanel({ data, hrefFor, title = "Deliveries per week", fill = true, className }: { data: WorkHome & { period: Period }; hrefFor: (week: string) => string; title?: string; fill?: boolean; className?: string }) {
  return (
    <Panel fill={fill} className={className} title={title} sub={`Last 12 weeks · ${data.usual ? `usual ${data.usual.toFixed(1)} a week` : "none yet"}`} 
      tools={<Why detail="One delivery is one indexed media file in a configured delivery folder, dated by its latest modification in Asia/Kolkata." more="“Usual” is the average of the eight weeks before the selected period, including weeks with none. Select a column to open that week." />}>
      <WeekChart weeks={data.trend} period={data.period} hrefFor={hrefFor} />
    </Panel>
  );
}

function AttentionPanel({ data, href }: { data: WorkHome & { generatedAt: string }; href: string }) {
  const now = Date.parse(data.generatedAt);
  return (
    <Panel fill title="Needs attention" sub={data.attention.total ? `${data.attention.total} quiet` : undefined} action={data.attention.total ? { href, label: "View all" } : undefined}>
      {data.attention.projects.length ? <ul className={styles.list}>{data.attention.projects.map((a) => (
        <li key={a.projectId}><Link href={`/projects/${a.projectId}`} className={styles.row} title={a.projectName}>
          <span className={styles.rowMain}><span className={styles.rowTitle}>{projectParts(a.projectName).title}</span>
            <span className={styles.rowMeta}><span>Last delivery {day(a.lastDeliveredAt)}</span><span>{a.recent} in 8 weeks</span></span></span>
          <span className={styles.rowEnd}><Badge tone="warning">{days(a.lastDeliveredAt, now)} days quiet</Badge></span>
        </Link></li>
      ))}</ul> : <Empty icon={CircleCheck} title="Nothing has gone quiet" text="Every project that delivered in the last eight weeks has delivered in the last 14 days." action={{ href: "/projects", label: "Browse projects" }} />}
      {data.attention.projects.length ? <p className={styles.panelFoot}>Delivered in the last 8 weeks, then nothing for 14 days or more. Pulse has no blocked signal yet.</p> : null}
    </Panel>
  );
}

export function TopProjects({ data, href, title = "Most active projects", fill = true }: { data: WorkHome & { period: Period }; href: string; title?: string; fill?: boolean }) {
  const max = Math.max(1, ...data.topProjects.map((p) => p.count));
  return (
    <Panel fill={fill} title={title} sub={periodLabel(data.period)} action={data.topProjects.length ? { href, label: "All projects" } : undefined}>
      {data.topProjects.length ? <ul className={styles.list}>{data.topProjects.map((p) => (
        <li key={p.projectId}><Link href={`/projects/${p.projectId}${periodQuery(data.period)}`} className={styles.row} title={p.projectName}>
          <span className={styles.rowMain}><span className={styles.rowTitle}>{projectParts(p.projectName).title}</span>
            <span className={styles.rowMeta}><span>{projectParts(p.projectName).meta || "Project"}</span></span></span>
          <span className={styles.rowEnd}><Meter value={p.count} max={max} /><span className={styles.rowValue}>{p.count}</span></span>
        </Link></li>
      ))}</ul> : <Empty icon={FolderKanban} title="No deliveries in this period" text="Projects appear here as soon as a file lands in a delivery folder." action={{ href: `/dashboard${periodQuery({ ...data.period, kind: "last" })}`, label: "See last week" }} />}
    </Panel>
  );
}

export function FeedPanel({ data, href, title = "Latest deliveries", fill = true, className }: { data: WorkHome & { period: Period }; href: string; title?: string; fill?: boolean; className?: string }) {
  return (
    <Panel fill={fill} className={className} title={title} sub={data.recent[0] ? `Most recent ${ago(data.recent[0].deliveredAt)}` : undefined} action={data.recent.length ? { href, label: "View all" } : undefined}>
      {data.recent.length ? <DeliveryFeed items={data.recent} today={data.period.today} /> : <Empty icon={Inbox} title="No deliveries yet" text="Files appear here once they land in a delivery folder and the Drive index picks them up." action={{ href: "/projects", label: "Browse projects" }} />}
    </Panel>
  );
}

const leaveDates = (l: LeaveRequest) => l.fromDate === l.toDate ? day(l.fromDate) : `${day(l.fromDate)} – ${day(l.toDate)}`;
function AttendanceList({ entries }: { entries: AttendanceEntry[] }) {
  return <ul className={styles.list}>{entries.map((e) => (
    <li key={e.id} className={styles.row}>
      <span className={styles.rowMain}><span className={styles.rowTitle}>{e.name}</span></span>
      <span className={styles.rowEnd}><span>In {time(e.checkedInAt)}{e.checkedOutAt ? ` · out ${time(e.checkedOutAt)}` : ""}</span><Badge tone={e.checkedOutAt ? "neutral" : "success"}>{e.checkedOutAt ? "Left" : "In"}</Badge></span>
    </li>
  ))}</ul>;
}

/** Attendance today plus leave that needs a decision, for people who can see the whole team. */
export function TeamDayPanel({ data, viewerPerson, decide, fill }: { data: HrHome; viewerPerson: string | null; decide: boolean; fill?: boolean }) {
  const attendanceEnabled = data.attendanceEnabled === true; const a = data.attendance ?? { headcount: 0, entries: [], ownOpen: false, canCheckIn: false, checkedInToday: 0, present: 0 }; const entries = a.entries ?? []; const { leave } = data;
  return (
    <Panel fill={fill} title={attendanceEnabled ? "Attendance today" : "Leave decisions"} sub={attendanceEnabled ? a.checkedInToday + " of " + a.headcount + " checked in" : "Leave requests"} action={attendanceEnabled ? { href: "/hr", label: "Open" } : undefined}>
      {attendanceEnabled ? (entries.length ? <AttendanceList entries={entries.slice(0, 6)} /> : <Empty compact icon={CalendarCheck} title="No one has checked in today" text="Check-ins appear here as the team starts the day."><AttendanceActions checkedIn={a.ownOpen} enabled={a.canCheckIn} attendanceEnabled={attendanceEnabled} /></Empty>) : null}

      <div className={styles.subhead}><span>Pending leave</span><Link href="/hr?tab=leave" className={styles.panelAction}>{leave.pending.length} to review</Link></div>
      {leave.pending.length ? <ul className={styles.list}>{leave.pending.slice(0, 4).map((l) => (
        <li key={l.id} className={styles.row}>
          <span className={styles.rowMain}><span className={styles.rowTitle}>{l.name}</span><span className={styles.rowMeta}><span>{leaveDates(l)}</span><span>{l.kind}</span></span></span>
          <span className={styles.rowEnd}>{decide && l.personId !== viewerPerson ? <LeaveDecision id={l.id} /> : <Badge tone="warning">Pending</Badge>}</span>
        </li>
      ))}</ul> : <Empty compact icon={CalendarOff} title="No leave waiting for a decision" text={leave.onLeaveToday.length ? `${plural(leave.onLeaveToday.length, "person", "people")} on leave today.` : "No one is on leave today."} action={{ href: "/hr?tab=leave", label: "Open leave" }} />}
    </Panel>
  );
}

/** `off`: the organisation's switched-off modules. With HR off the home leaves out the Today panel (check-in, leave and
 *  approvals) and the attendance and leave tiles. */
export function EditorHome({ data, me, welcome, approvals = 0, off = [], welcomeState = null, top, tasks }: { data: Editor; me?: Me; welcome?: boolean; approvals?: number; welcomeState?: string | null; off?: readonly string[]; top?: ReactNode; tasks?: { rows: MyTask[]; today: string } | null }) {
  const hrOn = !off.includes("hr");
  const pq = periodQuery(data.period); const preview = data.role === "admin"; const attendanceEnabled = hrOn && data.attendanceEnabled === true; const a = data.attendance ?? { headcount: 0, entries: [], ownOpen: false, canCheckIn: false, checkedInToday: 0, present: 0 }; const entries = a.entries ?? [];
  const own = entries.find((e) => !e.checkedOutAt) ?? entries[0];
  const evidence = preview ? `/people/accounts/${encodeURIComponent(data.account)}` : "/tasks?view=week";
  const quiet12 = !data.trend.some((w) => w.deliveries);
  // QA-1024 (R085): someone with no deliveries at all (a finance or HR person, a new editor) gets no delivery tiles, no
  // period switcher for them, and the zero panels after their own tasks; the home leads with the day and their tasks.
  const noDeliveries = quiet12 && !data.deliveries && !data.today && !data.projects;
  const first = (me?.name ?? data.viewer.name ?? "").split(" ")[0];
  // The day comes first: check in, leave, and (for the first days) a short getting-started list.
  const today = (
    <Panel fill title="Today" sub={longDay(data.period.today)} action={{ href: "/me", label: "My desk" }}>
      <div className={styles.todayBody}>
        {approvals ? <Link href="/me" className={styles.todayRow} data-tone="warning">
          <span className={styles.todayIcon}><CircleCheck size={16} aria-hidden="true" /></span>
          <span className={styles.todayText}><b>{plural(approvals, "request")} from your team waiting for you</b><small>{attendanceEnabled ? "Leave and attendance corrections you approve as their PGS or manager." : "Leave requests you approve as their PGS or manager."}</small></span>
          <span className={styles.btn}>Review</span>
        </Link> : null}
        {attendanceEnabled ? (<div className={styles.todayRow}>
          <span className={styles.todayIcon}><CalendarCheck size={16} aria-hidden="true" /></span>
          <span className={styles.todayText}><b>{a.ownOpen ? `Checked in at ${own ? time(own.checkedInAt) : ""}` : own ? "Checked out for the day" : "You have not checked in"}</b><small>{a.canCheckIn ? "Breaks and corrections are in My desk." : "Check-in is not available for this account."}</small></span>
          <AttendanceActions checkedIn={a.ownOpen} enabled={a.canCheckIn && !preview} attendanceEnabled={attendanceEnabled} />
        </div>) : null}

        {me?.person && !preview ? <Welcome person={me.person} first={first} checkedIn={!!own} photo={!!me.photoAt} attendanceEnabled={attendanceEnabled} initial={welcomeState} key={welcome ? "welcome" : "home"} /> : null}
      </div>
      <p className={styles.panelFoot}><span>{data.leave.pending.length ? `${plural(data.leave.pending.length, "leave request")} awaiting a decision.` : "No leave requests waiting."}</span><Link href="/me?tab=leave">Apply for leave</Link></p>
    </Panel>
  );
  return (
    <Page fit>
      <Header data={data} scope={preview ? data.account : first ? `Hello, ${first}` : "Your work"} periods={!noDeliveries} />
      {preview ? <p className={styles.banner}><Eye size={14} aria-hidden="true" /><span>Preview of the editor home, filled with activity from <b>{data.account}</b>. An editor sees only their own account.</span></p> : null}
      {top}
      <Tiles count={hrOn ? undefined : 4}>
        {noDeliveries ? null : <WorkTiles mine data={data} deliveriesHref={`${evidence}${pq}`} projectsHref={`/projects${periodQuery(data.period, { show: "active" })}`} quietHref="/projects?show=quiet" />}
        {attendanceEnabled ? <><Kpi label="Attendance" value={a.ownOpen ? "In" : own ? "Out" : "—"} href="/me?tab=attendance" tone={a.ownOpen ? "success" : undefined} note={own ? `Checked in ${time(own.checkedInAt)}` : "Not checked in today"} />
        </> : null}
        {hrOn ? <Kpi label="My leave" value={data.leave.pending.length} unit="pending" href="/me?tab=leave" note={data.leave.upcoming[0] ? `Next: ${leaveDates(data.leave.upcoming[0])}` : "No approved leave ahead"} /> : null}
      </Tiles>
      <Workspace>
        {hrOn ? today : null}
        {tasks ? <MyTasksPanel title="My tasks" tasks={tasks.rows} today={tasks.today} /> : null}
        {noDeliveries ? null : <>
        {quiet12 ? <Panel fill title="My deliveries per week" sub="Last 12 weeks">
          <Empty icon={Inbox} title="No deliveries credited to you yet" text="A delivery counts for you when it is uploaded from your own account or with Upload via Pulse on the project. Files uploaded through a shared login stay uncredited." action={{ href: "/projects?scope=all", label: "Find a project" }} />
        </Panel> : <TrendPanel data={data} title="My deliveries per week" hrefFor={(week) => `${evidence}${evidence.includes("?") ? "&" : "?"}week=${week}`} />}
        {quiet12 ? null : <FeedPanel data={data} title="Recent work" href={`${evidence}${pq}`} />}
        </>}
        <TopProjects data={data} title="My projects" href={`/projects${periodQuery(data.period, { show: "active" })}`} />
        <AttentionPanel data={data} href="/projects?show=quiet" />
        {noDeliveries ? <>
        {quiet12 ? <Panel fill title="My deliveries per week" sub="Last 12 weeks">
          <Empty icon={Inbox} title="No deliveries credited to you yet" text="A delivery counts for you when it is uploaded from your own account or with Upload via Pulse on the project. Files uploaded through a shared login stay uncredited." action={{ href: "/projects?scope=all", label: "Find a project" }} />
        </Panel> : <TrendPanel data={data} title="My deliveries per week" hrefFor={(week) => `${evidence}${evidence.includes("?") ? "&" : "?"}week=${week}`} />}
        {quiet12 ? null : <FeedPanel data={data} title="Recent work" href={`${evidence}${pq}`} />}
        </> : null}
      </Workspace>
    </Page>
  );
}

type MyTask = { id: string; title: string; status: string; dueOn: string | null };
/** QA-1024 (R085): a team member's own open tasks on their home, late and due today first, with one way to all of them. */
export function MyTasksPanel({ tasks, today, title = "My tasks" }: { tasks: readonly MyTask[]; today: string; title?: string }) {
  const open = tasks.filter((t) => ["open", "in_progress", "blocked"].includes(t.status));
  const rank = (t: MyTask) => (!t.dueOn ? 3 : t.dueOn < today ? 0 : t.dueOn === today ? 1 : 2);
  const shown = [...open].sort((a, b) => rank(a) - rank(b) || (a.dueOn ?? "9").localeCompare(b.dueOn ?? "9")).slice(0, 5);
  const due = (t: MyTask) => (!t.dueOn ? "No due date" : t.dueOn < today ? `Was due ${day(t.dueOn)}` : t.dueOn === today ? "Due today" : `Due ${day(t.dueOn)}`);
  return (
    <Panel fill title={title} sub={open.length ? plural(open.length, "open task") : "Nothing open"} action={{ href: "/tasks", label: "Open Work" }}>
      {shown.length ? <ul className={styles.list}>{shown.map((t) => (
        <li key={t.id}><Link href={`/tasks/${t.id}`} className={styles.row} title={t.title}>
          <span className={styles.rowMain}><span className={styles.rowTitle}>{t.title}</span><span className={styles.rowMeta}><span>{due(t)}</span></span></span>
          {t.status === "blocked" ? <span className={styles.rowEnd}><Badge tone="warning">Blocked</Badge></span> : t.dueOn && t.dueOn < today ? <span className={styles.rowEnd}><Badge tone="danger">Late</Badge></span> : null}
        </Link></li>
      ))}</ul> : <Empty icon={CircleCheck} title="Nothing assigned to you right now" text="Tasks people give you show here and in Work. You can add your own there too." action={{ href: "/tasks", label: "Open Work" }} />}
    </Panel>
  );
}

/** With HR switched off only the people changes stay. */
export function HrHome({ data, off = [], top }: { data: Hr; off?: readonly string[]; top?: ReactNode }) {
  const hrOn = !off.includes("hr");
  const attendanceEnabled = hrOn && data.attendanceEnabled === true; const a = data.attendance ?? { headcount: 0, entries: [], ownOpen: false, canCheckIn: false, checkedInToday: 0, present: 0 }; const entries = a.entries ?? []; const { leave } = data; const preview = data.role === "admin";
  return (
    <Page fit>
      <Header data={data} scope="HR" />
      {top}
      {preview ? <p className={styles.banner}><Eye size={14} aria-hidden="true" /><span>Preview of the HR home. HR sees {!hrOn ? "people changes" : attendanceEnabled ? "attendance, leave and people changes" : "leave and people changes"}, not delivery data.</span></p> : null}
      {hrOn ? <Tiles count={attendanceEnabled ? undefined : 3}>
        {attendanceEnabled ? <><Kpi label="Checked in now" value={a.present} unit={`/ ${a.headcount}`} href="/hr" tone={a.present ? "success" : undefined} note="Currently in" />
        <Kpi label="Checked in today" value={a.checkedInToday} unit={`/ ${a.headcount}`} href="/hr" note={`${a.headcount - a.checkedInToday} not yet`} />
        </> : null}
        <Kpi label="Leave pending" value={leave.pending.length} href="/hr?tab=leave" tone={leave.pending.length ? "warning" : undefined} note="Waiting for a decision" />
        <Kpi label="On leave today" value={leave.onLeaveToday.length} href="/hr?tab=leave" note="Approved leave" />
        <Kpi label="Upcoming leave" value={leave.upcoming.length} href="/hr?tab=leave" note="Next 14 days" />
        {attendanceEnabled ? <Kpi label="People" value={a.headcount} href={preview ? "/people" : undefined} note="Active now" /> : null}
      </Tiles> : null}
      <Workspace>
        {attendanceEnabled ? (<Panel fill title="Attendance today" sub={`${a.checkedInToday} of ${a.headcount} checked in`} action={{ href: "/hr", label: "Open attendance" }} className={styles.span2}>
          {a.entries.length ? <AttendanceList entries={entries} /> : <Empty icon={CalendarCheck} title="No one has checked in today" text="Check-ins appear here as the team starts the day. Times are recorded in Asia/Kolkata."><AttendanceActions checkedIn={a.ownOpen} enabled={a.canCheckIn && !preview} attendanceEnabled={attendanceEnabled} /></Empty>}
        </Panel>
        ) : null}
        {hrOn ? <Panel fill title="Leave requests" sub={leave.pending.length ? `${leave.pending.length} pending` : undefined} action={{ href: "/hr?tab=leave", label: "Open leave" }}>
          {leave.pending.length ? <ul className={styles.list}>{leave.pending.map((l) => (
            <li key={l.id} className={styles.row}>
              <span className={styles.rowMain}><span className={styles.rowTitle}>{l.name}</span><span className={styles.rowMeta}><span>{leaveDates(l)}</span><span>{l.kind}</span></span></span>
              <span className={styles.rowEnd}>{l.personId !== data.viewer.person ? <LeaveDecision id={l.id} /> : <Badge tone="warning">Yours</Badge>}</span>
            </li>
          ))}</ul> : <Empty icon={CalendarOff} title="No leave waiting for a decision" text={leave.upcoming.length ? `${plural(leave.upcoming.length, "approved leave", "approved leaves")} in the next 14 days.` : "New requests appear here for approval."} action={{ href: "/hr?tab=leave", label: "Open leave" }} />}
        </Panel> : null}
        <Panel fill title="People changes" sub="Most recent first" className={styles.span3}>
          <div className={styles.tableWrap}><table className={styles.table}>
            <thead><tr><th>Person</th><th>Role</th><th>Pod</th><th>Status</th><th>Change</th></tr></thead>
            <tbody>{data.peopleChanges.map((p) => (
              <tr key={p.id}><td><b style={{ fontWeight: 500 }}>{p.name}</b></td><td>{p.role ?? "—"}</td><td>{p.pod ?? "Unassigned"}</td>
                <td><Badge tone={p.status === "active" ? "success" : "neutral"}>{p.status}</Badge></td>
                <td className={styles.nowrap}>{p.activeTo ? `Left ${day(p.activeTo)}` : `Added ${day(p.createdAt)}`}</td></tr>
            ))}</tbody>
          </table></div>
        </Panel>
      </Workspace>
    </Page>
  );
}
viewNames({ TrendPanel, TopProjects, FeedPanel, AttentionPanel });
