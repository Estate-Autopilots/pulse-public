import Link from "next/link";
import {FlowQueue,PodSetup,FlowPolicies} from "./flow-actions";
import type {FlowData,FlowSettings,WorkCalendar} from "./flow-types";
import flowCss from "./flows.module.css";
import { Hourglass, Lock } from "lucide-react";
import { api, getMe } from "../lib/api";
import { attendanceWeekMonths, canSeeTeamAttendance, projectAttendanceWeek } from "../lib/attendance-week.mjs";
import type { AttendanceWeek } from "../lib/attendance-week.mjs";
import { PeopleCount } from "../home-views";
import { longDay } from "../lib/format";
import { parseMarkdown } from "../lib/markdown.mjs";
import { Empty, Message, Page, PageHeader, QueryTabs, styles } from "../ui";
import { Tabs } from "@pulse/design-system/ui";
import { Clock3, Inbox, LayoutDashboard, Users, Wallet } from "lucide-react";
import { attentionTasks, type AttentionCounts } from "./attention";
import { Attendance } from "./desk/attendance";
import { Dashboard } from "./desk/dashboard";
import { Leave } from "./desk/leave";
import { PatternsShifts, type Shifts } from "./desk/patterns";
import { PayrollDesk } from "./desk/payroll";
import {RuleConfirmations} from "./desk/rule-confirmations";
import { LeaveHolidays, WorkingRules } from "./desk/policies";
import { PresencePolicy } from "./desk/presence";
import { Requests } from "./desk/requests";
import { RolloutKit } from "./onboard/kit-view";
import { OnboardSettings } from "./onboard/settings";
import { OnboardTeam } from "./onboard/team";
import { TeamSetupAdmin, type TeamSetupState } from "./onboard/team-setup";
import type { Onboard } from "./onboard/types";
import { PeopleMoves } from "./moves/desk";
import type { Moves } from "./moves/types";
import { NeedsAttention } from "./policy-attention";
import { PolicyDocuments, type PolicyList } from "./policy-documents";
import { KINDS } from "./policy-kinds";
import type { Desk, Payroll, PolicyData, TeamLeave, TeamMonth, TicketList } from "./types";

// "Work calendar" became Policies → Patterns & shifts; next.config.ts redirects its old address there.
const TABS = [{ key: "dashboard", label: "Dashboard" }, { key: "onboard", label: "Onboard team" }, { key: "moves", label: "People moves" }, {key:"approvals",label:"Approvals"}, {key:"pods",label:"Pod heads"}, { key: "attendance", label: "Attendance" }, { key: "leave", label: "Leave" }, { key: "requests", label: "Requests" }, { key: "payroll", label: "Payroll" }, { key: "policies", label: "Policies" }] as const;
type Tab = typeof TABS[number]["key"];
/** Owner workbench (21 Oct 2026): ten equal tabs become five groups with icons; a group with several views shows them
 *  as a segmented switch. Old ?tab= links still open their view. */
type Group = "overview" | "people" | "time" | "approvals" | "pay";
const GROUP_OF: Record<Tab, Group> = { dashboard: "overview", onboard: "people", moves: "people", pods: "people", attendance: "time", leave: "time", approvals: "approvals", requests: "approvals", payroll: "pay", policies: "pay" };
const GROUP_TABS: Record<Group, Tab[]> = { overview: ["dashboard"], people: ["onboard", "moves", "pods"], time: ["attendance", "leave"], approvals: ["approvals", "requests"], pay: ["payroll", "policies"] };
/** Policies has one level of views. Older addresses (?view=types, ?view=holidays) are redirected in next.config.ts. */
const POLICY_VIEWS = [{ key: "documents", label: "Documents" }, { key: "rules", label: "Working rules" }, { key: "leave", label: "Leave & holidays" }, { key: "patterns", label: "Patterns & shifts" }, { key: "presence", label: "Office presence" }, { key: "approvals", label: "Approvals & comp-off" }] as const;
type PolicyView = typeof POLICY_VIEWS[number]["key"];
const OLD_VIEWS: Record<string, PolicyView> = { types: "leave", holidays: "leave" };
/** Onboard team (PRESENCE-ONBOARD): who has signed in, filled in their profile, installed an app and checked in. */
const ONBOARD_VIEWS = [{ key: "team", label: "Team" }, { key: "setup", label: "Team setup" }, { key: "settings", label: "Check-in settings" }, { key: "kit", label: "Rollout kit" }] as const;

/** Shown in place of a tab whose data the service could not give, so the rest of the desk keeps working. */
function Unavailable({ what, error }: { what: string; error: string }) {
  return <section className={styles.panel}><Empty icon={Hourglass} first title={`${what} is not available right now`} text={`The HR service did not answer for this tab (“${error}”). Nothing has been changed; refresh in a moment.`} /></section>;
}

function AttendanceRestricted() {
  return <section className={styles.panel}><Empty icon={Lock} first title="Team attendance is restricted" text="Your account cannot view team attendance. Your own attendance is available on My desk." action={{ href: "/me", label: "Open My desk" }} /></section>;
}

export default async function HrDesk({ searchParams }: { searchParams: Promise<{ tab?: string; date?: string; month?: string; view?: string; doc?: string }> }) {
  const query = await searchParams;
  const me = await getMe();
  if (me.error) return <Message text={me.error} />; if (!me.data) return null;
  if (!["hr","admin","leadership"].includes(me.data.role)) return (
    <Page>
      <PageHeader title="HR desk" context={["For HR and organisation admins"]} />
      <section className={styles.panel}><Empty icon={Lock} first title="The HR desk is for HR and admins" text="Team attendance, leave approvals, the requests desk and payroll are kept here. Your own attendance, leave and requests to HR are on My desk. Pod heads: your team’s leave and corrections wait for you in Waiting for you." action={{ href: "/me/approvals", label: "Waiting for you" }} /></section>
    </Page>
  );
  const tab: Tab = TABS.find((t) => t.key === query.tab)?.key ?? "dashboard";
  const label = TABS.find((t) => t.key === tab)!.label;
  const weekViewSelected = tab === "attendance" && (query.view == null || query.view === "week");
  const view: PolicyView | null = tab === "policies" ? POLICY_VIEWS.find((v) => v.key === (OLD_VIEWS[query.view ?? ""] ?? query.view))?.key ?? "documents" : null;
  const none = Promise.resolve(null);
  // The dashboard bundle also gives the tab counts, so it is read for every tab; a policy view reads only what it shows.
  const [desk, policy, setup, docs, attention, calendar, shifts] = await Promise.all([
    api<Desk>(`hr/desk${tab === "dashboard" && query.date ? `?date=${encodeURIComponent(query.date)}` : ""}`),
    view && view !== "presence" && view !== "approvals" ? api<PolicyData>("hr/policy") : none,
    tab === "pods" || view === "approvals" || view === "patterns" ? api<FlowSettings>("hr/flow-settings") : none,
    view === "documents" ? api<PolicyList>("hr/policies") : none,
    view === "documents" || view === "leave" ? api<AttentionCounts>("hr/policy-attention") : none,
    view === "patterns" ? api<WorkCalendar>("hr/work-calendar") : none,
    view === "patterns" ? api<Shifts>("shifts") : none,
  ]);
  const d = desk.data; const month = /^\d{4}-\d{2}$/.test(query.month ?? "") ? `?month=${query.month}` : "";
  const attendanceRoleDenied = tab === "attendance" && !canSeeTeamAttendance(me.data.role);
  const attendance = tab === "attendance" && canSeeTeamAttendance(me.data.role) ? await api<TeamMonth>("hr/attendance" + (weekViewSelected ? "" : month)) : null;
  let attendanceWeek: AttendanceWeek | null = null;
  let attendanceWeekError: { error: string; status?: number } | null = null;
  if (weekViewSelected && attendance && (!attendance.data || attendance.data.attendanceEnabled === true)) {
    if (!attendance.data) attendanceWeekError = { error: attendance.error ?? "no data", status: attendance.status };
    else {
      const monthKeys = attendanceWeekMonths(attendance.data.today);
      const extraResults = await Promise.all(monthKeys.filter((key) => key !== attendance.data.month).map((key) => api<TeamMonth>("hr/attendance?month=" + key)));
      const failure = extraResults.find((result): result is { error: string; status?: number } => "error" in result);
      if (failure) attendanceWeekError = failure;
      else {
        const extraMonths = extraResults.filter((result): result is { data: TeamMonth } => "data" in result).map((result) => result.data);
        attendanceWeek = projectAttendanceWeek([attendance.data, ...extraMonths], attendance.data.today, me.data.role, me.data.person);
      }
    }
  }
  const leave = tab === "leave" ? await api<TeamLeave>(`hr/leave${month}`) : null;
  const tickets = tab === "requests" ? await api<TicketList>("hr/tickets?scope=all") : null;
  // Asked for without figures: no salary is read and nothing is logged until "Show figures" is pressed.
  const payroll = tab === "payroll" ? await api<Payroll>("hr/payroll") : null;
  // MODULES-1024: the Approvals tab counts what waits for this person's decision (the queue's own "N waiting for you");
  // it used to count only open HR tickets, so it read 1 beside a list of 20.
  const flows = d ? await api<FlowData>('hr/flows') : null;
  const flow = tab === 'approvals' ? flows : null;
  const waiting = flows?.data?.rows.filter((f) => f.status === 'pending' && f.canDecide).length ?? 0;
  const onboardView = tab === "onboard" ? ONBOARD_VIEWS.find((v) => v.key === query.view)?.key ?? "team" : null;
  const onboard = onboardView && onboardView !== "kit" && onboardView !== "setup" ? await api<Onboard>("hr/onboard") : null;
  // ONBOARD: the team code, what people sent from /team-setup and the Workspace list.
  const teamSetup = onboardView === "setup" ? await api<TeamSetupState>("hr/team-setup") : null;
  // LIFECYCLE: joining and leaving checklists and HR's review of people who have probably left.
  const moves = tab === "moves" ? await api<Moves>("lifecycle") : null;
  const missing = (r: { error?: string; status?: number } | null) => <Unavailable what={label} error={r?.error ?? "no data"} />;
  const drafts = (docs?.data?.rows ?? []).filter((r) => r.status === "draft").map((r) => ({ kind: r.kind, label: KINDS.find(([k]) => k === r.kind)?.[1] ?? r.kind, version: r.version, confirm: parseMarkdown(r.body).confirm.length }));
  const today = policy?.data?.today ?? d?.today ?? new Date().toISOString().slice(0, 10);
  return (
    <Page fit>
      <PageHeader title="HR desk" actions={<><Link href="/tasks" className={styles.btn}>My tasks</Link><Link href="/hr/help" className={styles.btn}>HR help</Link></>} context={d ? [<PeopleCount key="people" headcount={d.counts?.headcount ?? d.people?.length ?? 0} ai={d.counts?.ai} />, longDay(d.today), ...(d.attendanceEnabled === true ? [`Shift ${d.policy.shiftStart} to ${d.policy.shiftEnd}`] : ["Leave, requests and HR tools"])] : ["Leave, requests and payroll for the team"]} />
      {(() => {
        const count = (t: Tab) => t === "attendance" ? (d?.attendanceEnabled === true ? d.pending.regularisations?.length || 0 : 0) : t === "leave" ? d?.pending.leave.length || 0 : t === "requests" ? d?.tickets.open || 0 : t === "approvals" ? waiting : 0;
        const sum = (g: Group) => GROUP_TABS[g].reduce((n, t) => n + count(t), 0) || undefined;
        const group = GROUP_OF[tab], views = GROUP_TABS[group];
        const groups = [
          { key: "overview", label: "Overview", icon: <LayoutDashboard />, href: "/hr" },
          { key: "people", label: "People", icon: <Users />, href: "/hr?tab=onboard", count: sum("people") },
          { key: "time", label: "Time", icon: <Clock3 />, href: "/hr?tab=attendance", count: sum("time") },
          { key: "approvals", label: "Approvals", icon: <Inbox />, href: "/hr?tab=approvals", count: sum("approvals") },
          { key: "pay", label: "Pay & policy", icon: <Wallet />, href: "/hr?tab=payroll" }];
        return <>
          <Tabs label="HR desk" current={group} items={groups} />
          {/* The group's row is named after the group: a view row under it (Policies, Onboard team) is "Views". */}
          {views.length > 1 ? <QueryTabs base="/hr" current={tab} sub label={groups.find((g) => g.key === group)?.label} items={TABS.filter((t) => views.includes(t.key)).map((t) => ({ ...t, count: count(t.key) || undefined }))} /> : null}
        </>;
      })()}
      {flow?(flow.data?<FlowQueue data={flow.data} fit/>:missing(flow)):null}
      {tab==='pods'?(setup?.data?<PodSetup data={setup.data}/>:missing(setup)):null}
      {tab === "dashboard" ? (d ? <Dashboard desk={d} /> : missing(desk)) : null}
      {onboardView ? <QueryTabs base="/hr" keep="tab=onboard" param="view" sub current={onboardView} items={[...ONBOARD_VIEWS]} /> : null}
      {onboardView === "team" ? (onboard?.data ? <OnboardTeam data={onboard.data} /> : missing(onboard)) : null}
      {onboardView === "settings" ? (onboard?.data ? <OnboardSettings settings={onboard.data.settings} kinds={onboard.data.kinds} canEdit={onboard.data.canEdit} /> : missing(onboard)) : null}
      {onboardView === "setup" ? (teamSetup?.data ? <TeamSetupAdmin data={teamSetup.data} /> : missing(teamSetup)) : null}
      {onboardView === "kit" ? <RolloutKit /> : null}
      {moves ? (moves.data ? <PeopleMoves data={moves.data} /> : missing(moves)) : null}
      {attendanceRoleDenied ? <AttendanceRestricted /> : null}
      {attendance ? (weekViewSelected ? (attendanceWeekError ? (attendanceWeekError.status === 403 ? <AttendanceRestricted /> : missing(attendanceWeekError))
        : attendance.data && attendance.data.attendanceEnabled !== true ? <Attendance data={attendance.data} pending={[]} me={me.data.person} view={query.view} />
        : attendance.data && attendanceWeek ? <Attendance data={attendance.data} pending={[]} me={me.data.person} view={query.view} week={attendanceWeek} /> : missing(attendance))
        : attendance.data ? <Attendance data={attendance.data} pending={d?.pending.regularisations ?? []} me={me.data.person} view={query.view} desk={d} /> : missing(attendance)) : null}
      {leave ? (leave.data ? <Leave data={leave.data} view={query.view} /> : missing(leave)) : null}
      {tickets ? (tickets.data ? <Requests data={tickets.data} /> : missing(tickets)) : null}
      {payroll ? (payroll.data ? <PayrollDesk data={payroll.data} today={d?.today ?? new Date().toISOString().slice(0, 10)} />
        : /permission|HR and organisation admins/i.test(payroll.error ?? "") ? <section className={styles.panel}><Empty icon={Lock} first title="Your account cannot read salary" text="Payroll needs the HR or admin role and the separate salary permission. Ask an organisation admin if you should have it. Nothing was read and nothing was logged." /></section> : missing(payroll)) : null}
      {view ? <QueryTabs base="/hr" keep="tab=policies" param="view" sub current={view} items={[...POLICY_VIEWS]} /> : null}
      {view === "documents" ? (docs?.data ? <PolicyDocuments initial={docs.data} selected={query.doc} aside={<NeedsAttention tasks={attentionTasks(attention?.data ?? null, drafts, !!policy?.data && !policy.data.policy.confirmedAt)} />} /> : missing(docs)) : null}
      {/* The organisation's rules first, then each proposed rule; on a desktop the view scrolls inside the page body. */}
      {view === "rules" ? (policy?.data ? <div className={flowCss.stack} data-grow=""><WorkingRules key={JSON.stringify(policy.data.policy)} data={policy.data} /><RuleConfirmations types={policy.data.types}/></div> : missing(policy)) : null}
      {view === "leave" ? (policy?.data ? <LeaveHolidays data={policy.data} proposed={attention?.data?.holidays} /> : missing(policy)) : null}
      {view === "patterns" ? (setup?.data || calendar?.data ? <PatternsShifts setup={setup?.data ?? null} calendar={calendar?.data ?? null} shifts={shifts?.data ?? null} today={today} /> : missing(setup)) : null}
      {view === "presence" ? <PresencePolicy /> : null}
      {view === "approvals" ? (setup?.data ? <div className={flowCss.stack} data-grow=""><FlowPolicies data={setup.data}/></div> : missing(setup)) : null}
    </Page>
  );
}
