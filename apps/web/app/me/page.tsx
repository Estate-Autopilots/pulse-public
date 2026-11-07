import { AttendanceReconciliation } from "../hr/reconciliation";
import { AttendanceOff } from "../hr/attendance-off";
import {Payslip} from "../hr/payslip";
import { WorkDays } from "../hr/flow-actions";
import type { WorkCalendar } from "../hr/flow-types";
import { PolicyDocuments, type PolicyList } from "../hr/policy-documents";
import Link from "next/link";
import { CalendarDays, Clock3, Inbox, LifeBuoy, PartyPopper, Sprout, Sun, UserRound, Users } from "lucide-react";
import { Tabs } from "@pulse/design-system/ui";
import { MyUploadAccounts, type ClaimableUploaderAccount, type UploaderAccountClaim } from "../account-claims/panels";
import { api, apiV1 } from "../lib/api";
import { ModuleOff, offModuleResponse } from "../module-off";
import { dayYear, longDay, plural, range, time } from "../lib/format";
import { EmergencyLeave, ApplyLeave, NewTicket, Regularise, SkillsEditor, TodayCard } from "../hr/actions";
import { AttendanceReasons, BalanceCards, CalendarLegend, CorrectionList, LeaveList, MonthCalendar, MonthNav, MonthSummary, PerformanceChart, TicketList, type OffHours } from "../hr/parts";
import css from "../hr/hr.module.css";
import { PerformancePanel } from "../hr/person-tab";
import { CATEGORY, ROSTER, dayCount, duration, leaveName, type PersonHr } from "../hr/types";
import { Avatar, Badge, Empty, Kpi, Message, Page, Panel, QueryTabs, Tiles, styles, Workspace, PageHeader } from "../ui";
import { HelpHint } from "../kit";
import type { OnboardingState } from "../welcome/types";
import { PayrollCard } from "./payroll-card";
import { DayTimeline, HabitCard } from "./presence-parts";
import { ProfileBanner } from "./profile-banner";
import pc from "./presence.module.css";
import { MyPulseHome, OutcomeToday, type MyPulse } from "./my-pulse";
import { DeskTile } from "./my-pulse-actions";
import { dest } from "../destinations/registry.mjs";
import { SelfHistoryView, type SelfHistory } from "./history";
import { W } from "../kit/word";

const TABS = ["overview", "attendance", "leave", "performance", "requests", "history", "policies", "accounts"] as const;
type Tab = typeof TABS[number];
const GROUP_OF: Record<Tab, "today" | "time" | "growth" | "requests" | "about"> = { overview: "today", attendance: "time", leave: "time", history: "time", performance: "growth", requests: "requests", policies: "about", accounts: "about" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default async function MyDesk({ searchParams }: { searchParams: Promise<{ tab?: string; month?: string; doc?: string; kind?: string }> }) {
  const query = await searchParams;
  const r = await api<PersonHr>(`hr/self${query.month ? `?month=${encodeURIComponent(query.month)}` : ""}`);
  // HR switched off: the HR API answers 404, so My desk shows the neutral page instead of an error.
  if (r.error) return offModuleResponse(r) ? <ModuleOff /> : <Message text={r.error} />; const d = r.data; if (!d) return null;
  const tab: Tab = TABS.includes(query.tab as Tab) ? query.tab as Tab : "overview";
  const attendanceEnabled = d.attendanceEnabled === true;
  const emptySummary = { filter: { version: "off", provisional: false, maxMinutes: 0 }, from: d.today, to: d.today, recordedDays: 0, eligibleDays: 0, flaggedCount: 0, excludedDays: 0, coverage: null, workedMinutes: 0, recordedMinutes: 0, averageMinutes: null, present: 0, wfh: 0, late: 0, leave: 0, absent: 0, missedOut: 0 };
  const month = d.month ?? { key: d.today.slice(0, 7), from: d.today, to: d.today, days: [], summary: emptySummary, trackedFrom: null };
  const s = month.summary ?? emptySummary; const now = d.now ?? { state: "out", entry: null, holiday: null, leave: null }; const wfh = d.wfh ?? { used: 0, allowance: null }; const regularisations = d.regularisations ?? []; const team = d.team ?? [];
  const work = attendanceEnabled ? await api<WorkCalendar>("hr/work-calendar") : null;
  // LAYOUT-SWEEP: the request to work on a day off is a one-line chip on My desk, only on a weekly off or a holiday;
  // the full form stays in Attendance.
  const offToday = work?.data?.days.find((x) => x.day === work.data!.today && !x.working) ?? null;
  // LAYOUT-SWEEP: the tab's reads start together (and Policies arrive with the page, not after it).
  const [onboarding, pulse, policies, history, reviews] = await Promise.all([
    tab === "overview" ? api<OnboardingState>("onboarding").then((x) => x.data ?? null) : null,
    // LIFECYCLE: My Pulse, the person's own home (their records only).
    tab === "overview" ? api<MyPulse>("me/pulse").then((x) => x.data ?? null) : null,
    tab === "policies" ? api<PolicyList>("hr/policies").then((x) => x.data ?? null) : null,
    // R43: earlier months, leave years, requests, documents and issued payslips, each with its source.
    tab === "history" ? api<SelfHistory>("hr/self/history") : null,
    // UX-5A: "Waiting for you" counts finished work to review too (TASKS-4B's queue).
    tab === "overview" ? api<{ n: number; oldestHours: number | null }>("tasks/reviews/count").then((x) => x.data ?? null) : null,
  ]);
  const p = d.person; const types = d.leave.types ?? [];
  const claimData = tab === "accounts" ? await Promise.all([
    apiV1<{ accounts: ClaimableUploaderAccount[] }>("/v1/accounts/claimable"),
    apiV1<{ claims: UploaderAccountClaim[] }>("/v1/accounts/claims"),
  ]) : null;
  const waiting = d.leave.requests.filter((l) => l.status === "pending").length + (attendanceEnabled ? regularisations.filter((x) => x.status === "pending").length : 0);
  const openTickets = d.tickets.filter((t) => !["resolved", "closed"].includes(t.status));
  const paid = d.leave.balances.find((b) => b.key === types.find((t) => t.paid && t.annualDays !== null)?.key);
  const nextLeave = [...d.leave.requests].reverse().find((l) => l.status === "approved" && l.toDate >= d.today);
  const perf = d.performance?.linked && d.performance.allTime ? d.performance : null;
  const approvals = (d.approvals?.leave?.length ?? 0) + (attendanceEnabled ? (d.approvals?.regularisations?.length ?? 0) : 0);
  const workspaceInitial = approvals && team.length
    ? Number(attendanceEnabled) + Number(Boolean(perf)) + 2 + Number(attendanceEnabled && team.length > 0)
    : 0;
  const keep = query.month ? `month=${query.month}` : undefined;
  // R43: the calendar explains off days and hours outside the shift with the person's own rules.
  const offHours: OffHours = { workDays: d.policy.workDays, shiftStart: d.policy.shiftStart, shiftEnd: d.policy.shiftEnd, confirmed: !!d.policy.confirmedAt, comp: work?.data?.compPolicy ?? null };
  const upcomingList = d.holidays.length || d.away.length ? <ul className={css.upcoming}>
      {d.holidays.slice(0, 6).map((h) => <li key={h.day}><time dateTime={h.day}>{MONTHS[Number(h.day.slice(5, 7)) - 1]}<b>{Number(h.day.slice(8))}</b></time><span>{h.name}<small>{longDay(h.day).split(" ")[0]} · {h.optional ? "optional holiday" : "holiday"}</small></span><PartyPopper size={14} aria-hidden="true" className={styles.muted} /></li>)}
      {d.away.slice(0, 8).map((a) => <li key={`${a.personId}${a.fromDate}`}><time dateTime={a.fromDate}>{MONTHS[Number(a.fromDate.slice(5, 7)) - 1]}<b>{Number(a.fromDate.slice(8))}</b></time><span><Link href={`/people/${a.personId}`}>{a.name}</Link><small>away {range(a.fromDate, a.toDate)}{a.halfDay ? " (half day)" : ""}</small></span><Avatar name={a.name} size={22} /></li>)}
    </ul> : <Empty icon={CalendarDays} compact title="Nothing coming up" text="Holidays HR adds and approved leave in the team for the next three weeks show here." />;
  const upcoming = <Panel fill title="Coming up" sub="Holidays and who is away">
    {d.holidays.length || d.away.length ? <ul className={css.upcoming}>
      {d.holidays.slice(0, 4).map((h) => <li key={h.day}><time dateTime={h.day}>{MONTHS[Number(h.day.slice(5, 7)) - 1]}<b>{Number(h.day.slice(8))}</b></time><span>{h.name}<small>{longDay(h.day).split(" ")[0]} · {h.optional ? "optional holiday" : "holiday"}</small></span><PartyPopper size={14} aria-hidden="true" className={styles.muted} /></li>)}
      {d.away.slice(0, 6).map((a) => <li key={`${a.personId}${a.fromDate}`}><time dateTime={a.fromDate}>{MONTHS[Number(a.fromDate.slice(5, 7)) - 1]}<b>{Number(a.fromDate.slice(8))}</b></time><span><Link href={`/people/${a.personId}`}>{a.name}</Link><small>away {range(a.fromDate, a.toDate)}{a.halfDay ? " (half day)" : ""}</small></span><Avatar name={a.name} size={22} /></li>)}
    </ul> : <Empty icon={CalendarDays} compact title="Nothing coming up" text="Holidays HR adds and approved leave in the team for the next three weeks show here." />}
  </Panel>;
  return (
    <Page fit>
      <PageHeader title="My desk" context={tab === "overview" ? [] : [p.name, p.role, p.pod]} actions={<Link href={`/people/${p.id}`} className={styles.btn}>My profile</Link>} />
      {/* Owner workbench (21 Oct 2026): five groups with icons instead of eight equal tabs. Time holds attendance, leave
          and history; About me holds policies and upload accounts. The old ?tab= values still open their view. */}
      <Tabs label="My desk" current={GROUP_OF[tab]} items={[
        { key: "today", label: "Today", icon: <Sun />, href: "/me" },
        { key: "time", label: "Time", icon: <Clock3 />, href: "/me?tab=attendance" },
        { key: "growth", label: "Growth", icon: <Sprout />, href: "/me?tab=performance" },
        { key: "requests", label: "Requests", icon: <Inbox />, count: openTickets.length || undefined, href: "/me?tab=requests" },
        { key: "about", label: "About me", icon: <UserRound />, href: "/me?tab=policies" }]} />
      {GROUP_OF[tab] === "time" ? <QueryTabs base="/me" current={tab} keep={keep} sub label="Time" items={[{ key: "attendance", label: "Attendance" }, { key: "leave", label: "Leave" }, { key: "history", label: "History" }]} /> : null}
      {GROUP_OF[tab] === "about" ? <QueryTabs base="/me" current={tab} keep={keep} sub label="About me" items={[{ key: "policies", label: "Policies" }, { key: "accounts", label: "Upload accounts" }]} /> : null}

      {tab === "overview" && pulse ? <MyPulseHome d={pulse} payslip={<Payslip personId={p.id} month={d.today.slice(0,7)} issued={pulse.money.payslips.map((x) => x.month)}/>}
        banner={onboarding && d.can.act ? <ProfileBanner state={onboarding} /> : null}
        today={attendanceEnabled ? now.state === "outcome" ? <OutcomeToday shift={d.today ? `${d.policy.shiftStart}–${d.policy.shiftEnd} on office days` : null} />
          : <TodayCard personId={p.id} now={now} policy={d.policy} clock={d.clock} today={d.today} canAct={d.can.act} wfh={wfh} attendanceEnabled={attendanceEnabled} compact /> : null}
        waiting={{ reviews: reviews?.n ?? 0, oldestReviewHours: reviews?.oldestHours ?? null, approvals }}
        offDay={offToday && d.can.act ? <Link href="/me?tab=attendance&do=day-off" className={pc.offDay}><CalendarDays size={14} aria-hidden="true" /><span>Today is your day off{offToday.holiday ? ` (${offToday.holiday})` : ""}.</span><b>Working anyway? Ask first</b></Link> : null}
        tiles={<>
          <DeskTile title="Time off" {...dest("me.time-off")} icon={<CalendarDays size={15} aria-hidden="true" />} figure={paid ? dayCount(paid.available).replace(/ days?$/, "") : "–"} unit={paid ? (paid.available === 1 ? "day of leave left" : "days of leave left") : undefined}
            line={nextLeave ? `Next: ${range(nextLeave.fromDate, nextLeave.toDate)}` : paid?.pending ? `${dayCount(paid.pending)} waiting for a decision` : attendanceEnabled ? `${s.present} days in this month` : `${d.leave.year} leave year`}
            aside={d.can.act ? <ApplyLeave types={types} balances={d.leave.balances} today={d.today} variant="ghost" autoOpen={false} /> : undefined}>
            <ul className={styles.list}>{types.map((t) => { const b = d.leave.balances.find((x) => x.key === t.key); return (
              <li key={t.key} className={styles.row}><span className={styles.rowMain}><span className={styles.rowTitle}>{t.name}</span><span className={styles.rowMeta}><span>{b ? `${dayCount(b.used)} taken${b.pending ? ` · ${dayCount(b.pending)} waiting` : ""}` : "No fixed allowance"}</span></span></span>
                <span className={styles.rowEnd}><b style={{ color: "var(--theme-text)", fontSize: 14 }}>{b ? dayCount(b.available) : "As needed"}</b></span></li>); })}
              {attendanceEnabled ? <li><Link href="/me?tab=attendance" className={styles.row}><span className={styles.rowMain}><span className={styles.rowTitle}>This month</span><span className={styles.rowMeta}><span>{s.late ? `${s.late} late · ` : ""}what payroll will use</span></span></span>
                <span className={styles.rowEnd}><b style={{ color: "var(--theme-text)", fontSize: 14 }}>{s.present} days in</b></span></Link></li> : null}
              {pulse.money.compOffDays ? <li className={styles.row}><span className={styles.rowMain}><span className={styles.rowTitle}>Comp-off</span><span className={styles.rowMeta}><span>For approved extra days</span></span></span><span className={styles.rowEnd}><b style={{ color: "var(--theme-text)", fontSize: 14 }}>{dayCount(pulse.money.compOffDays)}</b></span></li> : null}</ul>
            <p className={styles.panelFoot}><Link href="/me?tab=leave">Balances and requests</Link></p>
          </DeskTile>
          <DeskTile title="Requests with HR" icon={<LifeBuoy size={15} aria-hidden="true" />} figure={openTickets.length} unit="open" line={openTickets[0]?.subject ?? "Questions and problems for HR"}
            aside={d.can.act ? <NewTicket categories={Object.keys(CATEGORY)} variant="ghost" autoOpen={false} /> : undefined}>
            <TicketList tickets={openTickets} empty="Raise a question or a problem with HR and follow the reply here." />
            <p className={styles.panelFoot}><Link href="/me?tab=requests">All your requests</Link></p>
          </DeskTile>
          <DeskTile title="Coming up" icon={<PartyPopper size={15} aria-hidden="true" />} figure={d.holidays[0] ? `${Number(d.holidays[0].day.slice(8))} ${MONTHS[Number(d.holidays[0].day.slice(5, 7)) - 1]}` : d.away.length || "–"}
            unit={d.holidays[0] ? undefined : d.away.length ? "away" : undefined} line={d.holidays[0] ? d.holidays[0].name : d.away.length ? `${d.away.length === 1 ? d.away[0].name : `${d.away.length} people`} away soon` : "Holidays and who is away"}>
            {upcomingList}
          </DeskTile>
          {attendanceEnabled && team.length ? <DeskTile title="Your team today" icon={<Users size={15} aria-hidden="true" />} figure={`${team.filter((m) => m.entry).length}/${team.length}`} unit="in"
            line={`${team.filter((m) => m.status === "leave").length ? `${team.filter((m) => m.status === "leave").length} on leave · ` : ""}${team.length === 1 ? "1 person reports to you" : `${team.length} people report to you`}`}>
            <ul className={styles.list}>{team.map((m) => (
              <li key={m.id}><Link href={`/people/${m.id}?tab=attendance`} className={styles.row}>
                <span className={styles.person}><Avatar name={m.name} id={m.id} photoAt={m.photoAt} size={28} status /><span><span className={styles.rowTitle}>{m.name}</span>
                  <span className={styles.cellSub}>{m.entry ? `In at ${time(m.entry.in)}${m.entry.mode === "wfh" ? " · from home" : m.entry.mode === "field" ? " · on duty outside" : ""}${m.entry.late ? ` · late by ${duration(m.entry.late)}` : ""}` : m.role}</span></span></span>
                <span style={{ flex: 1 }} /><Badge tone={ROSTER[m.status].tone}>{ROSTER[m.status].label}</Badge>
              </Link></li>
            ))}</ul>
          </DeskTile> : null}
        </>} /> : null}
      {tab === "overview" && !pulse ? <>
        <div className={styles.actions}><Payslip personId={p.id} month={d.today.slice(0,7)} own/><Link className={styles.btn} href="/tasks?view=week">My week & tasks</Link></div>
        {/* EST-1196: the check-in first; the profile banner below it. */}
        {attendanceEnabled ? <TodayCard personId={p.id} now={now} policy={d.policy} clock={d.clock} today={d.today} canAct={d.can.act} wfh={wfh} attendanceEnabled={attendanceEnabled} /> : null}
        {onboarding && d.can.act ? <ProfileBanner state={onboarding} /> : null}
        {attendanceEnabled && d.payroll ? <div className={pc.presenceRow}><HabitCard /><PayrollCard payroll={d.payroll} compact /></div> : null}
        {/* With the payroll month above, the same numbers are not repeated as tiles. */}
        {attendanceEnabled && d.payroll ? null : <Tiles count={attendanceEnabled ? 5 : 2} dense>
          {attendanceEnabled ? <><Kpi label="Days present" value={s.present} unit="this month" href="/me?tab=attendance" note={s.averageMinutes !== null ? `${duration(s.averageMinutes)} per eligible day · ${s.eligibleDays} days · provisional` : "No eligible days for an average"} />
          <Kpi label="Late marks" value={s.late} href="/me?tab=attendance" tone={s.late ? "warning" : undefined} note={`After ${d.policy.shiftStart} plus ${d.policy.graceMinutes} min grace`} />
          <Kpi label="Work from home" value={wfh.used} unit={wfh.allowance === null ? "this month" : `/ ${wfh.allowance} this month`} href="/me?tab=attendance" note={wfh.allowance === null ? "No monthly limit" : `${Math.max(0, wfh.allowance - wfh.used)} left`} /></> : null}
          <Kpi label="Leave left" value={paid ? (Number.isInteger(paid.available) ? paid.available : paid.available.toFixed(1)) : "–"} unit={paid ? (paid.available === 1 ? "day" : "days") : undefined} href="/me?tab=leave" note={nextLeave ? `Next: ${range(nextLeave.fromDate, nextLeave.toDate)}` : paid?.pending ? `${dayCount(paid.pending)} waiting for a decision` : "Paid leave"} />
          <Kpi label="Waiting for a decision" value={waiting} href="/me?tab=leave" tone={waiting ? "warning" : undefined} note={openTickets.length ? `${plural(openTickets.length, "request")} open with HR` : attendanceEnabled ? "Leave and corrections" : "Leave requests"} />
        </Tiles>}
        {/* A manager with something to decide starts on "Waiting for you"; everyone else on their month. */}
        <Workspace initial={workspaceInitial}>
          <div className={css.meCol}>
            {attendanceEnabled ? <Panel fill title="This month" sub={`${MONTHS[Number(month.key.slice(5)) - 1]} ${month.key.slice(0, 4)}`} action={{ href: "/me?tab=attendance", label: "Attendance" }}>
              <MonthCalendar days={month.days} today={d.today} types={types} />
              <CalendarLegend explain={offHours} />
            </Panel> : null}
            {perf ? <Panel fill title="Deliveries" sub="Twelve weeks against your own usual week" action={{ href: "/me?tab=performance", label: "Performance" }}><PerformanceChart data={perf} today={d.today} /></Panel> : null}
          </div>
          <div className={css.meCol}>
            <Panel fill title="Leave" sub={`${d.leave.year} leave year`} foot={<Link href="/me?tab=leave">Balances and requests</Link>} tools={d.can.act ? <ApplyLeave types={types} balances={d.leave.balances} today={d.today} variant="ghost" /> : undefined}>
              <ul className={styles.list}>{types.map((t) => { const b = d.leave.balances.find((x) => x.key === t.key); return (
                <li key={t.key} className={styles.row}><span className={styles.rowMain}><span className={styles.rowTitle}>{t.name}</span><span className={styles.rowMeta}><span>{b ? `${dayCount(b.used)} taken${b.pending ? ` · ${dayCount(b.pending)} waiting` : ""}` : "No fixed allowance"}</span></span></span>
                  <span className={styles.rowEnd}>{b ? <b style={{ color: "var(--theme-text)", fontSize: 14 }}>{dayCount(b.available)}</b> : "As needed"}</span></li>
              ); })}</ul>
            </Panel>
            <Panel fill title="Requests with HR" sub={openTickets.length ? `${openTickets.length} open` : undefined} action={{ href: "/me?tab=requests", label: "All" }}>
              <TicketList tickets={openTickets.slice(0, 4)} empty="Raise a question or a problem with HR and follow the reply here." />
            </Panel>
          </div>
          <div className={css.meCol}>
            {attendanceEnabled && team.length ? <Panel fill title="Your team today" sub={team.length === 1 ? "1 person reports to you" : `${team.length} people report to you`}>
              <ul className={styles.list}>{team.map((m) => (
                <li key={m.id}><Link href={`/people/${m.id}?tab=attendance`} className={styles.row}>
                  <span className={styles.person}><Avatar name={m.name} id={m.id} photoAt={m.photoAt} size={28} status /><span><span className={styles.rowTitle}>{m.name}</span>
                    <span className={styles.cellSub}>{m.entry ? `In at ${time(m.entry.in)}${m.entry.mode === "wfh" ? " · from home" : m.entry.mode === "field" ? " · on duty outside" : ""}${m.entry.late ? ` · late by ${duration(m.entry.late)}` : ""}` : m.role}</span></span></span>
                  <span style={{ flex: 1 }} /><Badge tone={ROSTER[m.status].tone}>{ROSTER[m.status].label}</Badge>
                </Link></li>
              ))}</ul>
            </Panel> : null}
            {team.length ? <Panel fill title="Waiting for you" action={{href:"/me/approvals",label:"Open shared approvals"}}><p>Leave, corrections, Sunday work and other requests share one queue with HR, including decisions and history.</p></Panel> : null}
            {upcoming}
          </div>
        </Workspace>
      </> : null}

      {tab === "attendance" ? (attendanceEnabled ? <>
      {/* UX-5A: one quiet row of actions over the tab (no permanent "Working on a day off?" block, no rule paragraph). */}
      <div className={pc.toolbar}>
        {d.rules?.late ? <span className={pc.ruleChip}><b>{d.rules.late.count}</b>&nbsp;late {d.rules.late.count === 1 ? "mark" : "marks"} this {d.rules.late.window === "calendar_week" ? "week" : "month"}
          <HelpHint label="How late marks count">{d.rules.late.threshold} late marks per {d.rules.late.window === "calendar_week" ? "calendar week" : "month"} deduct {d.rules.late.deduction} day. HR can waive a mark with a reason.</HelpHint></span> : null}
        <span className={pc.toolbarEnd}>{d.can.act ? <Regularise today={d.today} variant="ghost" /> : null}{work?.data && d.can.act ? <WorkDays data={work.data} /> : null}</span>
      </div>
      <Workspace labels={["Today", "Payroll month", "Your month", "Day by day", "Corrections", "Needs checking & baseline"]}>
        {/* Today: the buttons, then the day as it happened (how each tap was recorded, what Pulse noticed). */}
        <Panel title="Today" sub="Every check-in, break and reminder, and how it was recorded">
          {attendanceEnabled ? <TodayCard personId={p.id} now={now} policy={d.policy} clock={d.clock} today={d.today} canAct={d.can.act} wfh={wfh} attendanceEnabled={attendanceEnabled} /> : null}
          <DayTimeline today={d.today} canAct={d.can.act} />
        </Panel>
        <Panel title="Payroll month" sub="What payroll will use, and until when you can fix it">{d.payroll ? <PayrollCard payroll={d.payroll} /> : <p className={styles.muted}>Payroll uses your check-ins from the first one.</p>}</Panel>
        <Panel title="Your month" sub={month.trackedFrom ? `Counted from your first check-in, ${dayYear(month.trackedFrom)}` : "Starts counting with your first check-in"}
          tools={<><MonthNav base="/me?tab=attendance" month={month.key} today={d.today} /><HelpHint label="Your working days">Working days are {d.policy.workDays.map((n) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][n - 1]).join(", ")}, {d.policy.shiftStart} to {d.policy.shiftEnd}. A check-in more than {d.policy.graceMinutes} minutes after the start is marked late.{d.policy.confirmedAt ? "" : " These hours are Pulse’s starting values until HR confirms them."}</HelpHint></>}>
          <MonthCalendar days={month.days} today={d.today} types={types} />
          <CalendarLegend explain={offHours} />
          <MonthSummary summary={s} />
        </Panel>
        <div className={styles.columns} style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
          <Panel title="Day by day" sub={plural(s.present, "day")}>
            {s.present ? <div className={styles.tableWrap}><table className={styles.table}>
              <thead><tr><th>Day</th><th>In</th><th>Out</th><th className={styles.right}>Breaks</th><th className={styles.right}>Worked</th></tr></thead>
              <tbody>{[...month.days].reverse().filter((x) => x.entry).flatMap(({ date, sessions, attendance, automaticHalfDay }) => sessions.map((e) => <tr key={e.id}>
                <td className={styles.nowrap}>{longDay(date)}{automaticHalfDay?<><Badge tone="warning">Half day</Badge>{d.can.act?<Regularise today={d.today} date={date} entryId={e.id} label="Correct half day" small/>:null}</>:null}{e!.mode !== "office" ? <span className={styles.cellSub}>{e!.mode === "wfh" ? "From home" : "On duty outside"}</span> : null}</td>
                <td className={styles.nowrap}>{time(e!.in)}{e!.late ? <span className={styles.cellSub} style={{ color: "var(--theme-warning)" }}>late by {duration(e!.late)}</span> : null}</td>
                <td className={styles.nowrap}>{e!.missedOut ? <span style={{ color: "var(--theme-warning)" }}>Not recorded</span> : e!.out ? time(e!.out) : <span className={styles.muted}>Still in</span>}</td>
                <td className={styles.right}>{e!.breakMinutes ? duration(e!.breakMinutes) : "–"}</td><td className={styles.right}>{duration(e.worked)}<AttendanceReasons attendance={attendance} />{attendance && !attendance.eligible && d.can.act ? <Regularise today={d.today} date={date} label="Request correction" small /> : null}</td>
              </tr>))}</tbody>
            </table></div> : <Empty icon={CalendarDays} compact title="No check-ins this month" text="Check in at the top of this page when you start work. Each day then shows here with its hours." />}
          </Panel>
          <Panel title="Corrections" sub="Requests to fix a day">
            <CorrectionList items={regularisations} mine={d.can.act} />
          </Panel>
        </div>
        {d.reconciliation ? <Panel title="Needs checking & baseline" sub="Original punches are retained. Independent review decides corrections."><AttendanceReconciliation data={d.reconciliation} today={d.today} canAct={d.can.act} attendanceEnabled={attendanceEnabled}/></Panel> : null}
      </Workspace></> : <AttendanceOff />) : null}

      {tab === "leave" ? <><EmergencyLeave today={d.today}/><Workspace>
        <Panel title="Leave balances" sub={`${d.leave.year} leave year`} tools={d.can.act ? <ApplyLeave types={types} balances={d.leave.balances} today={d.today} /> : undefined}>
          <BalanceCards types={types} balances={d.leave.balances} provisional={d.leave.provisional} trackingFrom={d.leave.trackingFrom} />
        </Panel>
        <div className={styles.columns}>
          <Panel title="Your requests" sub={plural(d.leave.requests.length, "request")}>
            <LeaveList requests={d.leave.requests} types={types} today={d.today} mine={d.can.act} empty="Apply with the dates and a reason. Your manager or HR decides, and the answer shows here." />
          </Panel>
          {upcoming}
        </div>
      </Workspace></> : null}

      {/* ?doc= from HR desk links; ?kind= is what policy notification links use. */}
      {tab === "policies" ? <PolicyDocuments initial={policies} selected={query.doc ?? query.kind}/> : null}
      {tab === "performance" ? <PerformancePanel data={d} /> : null}
      {tab === "history" && history ? (history.error ? <Message text={history.error} /> : history.data ? <SelfHistoryView d={history.data} personId={p.id} types={d.leave.types ?? []} /> : null) : null}
      {tab === "accounts" && claimData ? <>
        <MyUploadAccounts
          accounts={claimData[0] && "data" in claimData[0] ? claimData[0].data?.accounts ?? [] : []}
          claims={claimData[1] && "data" in claimData[1] ? (claimData[1].data?.claims ?? []).filter((claim) => claim.personId === d.person.id) : []}
          accountError={claimData[0] && "error" in claimData[0] ? claimData[0].error : undefined}
          claimsError={claimData[1] && "error" in claimData[1] ? claimData[1].error : undefined}
        />
      </> : null}

      {tab === "requests" ? <Workspace>
        <Panel title="Your requests with HR" sub={`${openTickets.length} open · ${d.tickets.length - openTickets.length} closed`} tools={d.can.act ? <NewTicket categories={Object.keys(CATEGORY)} /> : undefined}>
          <TicketList tickets={d.tickets} />
        </Panel>
        <Panel title="Your skills" sub="Shown on your profile"><SkillsEditor personId={p.id} skills={p.skills} canEdit={d.can.act} /></Panel>
        <p className={styles.muted} style={{ margin: 0, fontSize: 12 }}>You, your <W k="team" lc /> head and HR see the shared request and decision history. HR’s internal ticket notes stay with HR. You can close a request yourself, or reopen it if the answer did not solve it.</p>
      </Workspace> : null}
    </Page>
  );
}
