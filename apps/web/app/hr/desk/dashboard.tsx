import Link from "next/link";
import type { CSSProperties } from "react";
import { CalendarCheck, CalendarDays, CalendarOff, ChevronRight, CircleCheck, Coffee, PartyPopper, UserRoundX } from "lucide-react";
import { day, longDay, plural, range, time } from "../../lib/format";
import { Avatar, Badge, Empty, Kpi, Panel, styles, Fit } from "../../ui";
import { Regularise } from "../actions";
import css from "../desk.module.css";
import { MODE, dayCount, duration, leaveName, type Desk, type RosterPerson } from "../types";
import { DayPicker } from "./controls";
import { SparseFacts } from "../../charts";
import { workedToday } from "../../lib/roster.mjs";
import { AttendanceCoverage, AttendanceReasons } from "../parts";
import { CorrectionAsk, LeaveAsk, None, halfLabel, weekdayLetter } from "./parts";
import { WorthALook } from "./worth";
import { AttendanceExceptions } from "./exceptions";

/** Requests shown on the dashboard before "View all in Leave". */
const ASK_TOP = 3;
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** One person on the roster. People with a check-in show their times; the others get a quiet row with "Record". */
export function Who({ p, desk }: { p: RosterPerson; desk: Desk }) {
  const e = p.entry; const self = p.id === desk.me; const first = p.name.split(" ")[0];
  return (
    <li className={css.who}>
      <Link href={`/people/${p.id}?tab=attendance`} className={css.whoPerson}>
        <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={28} status />
        <span title={`${p.name} · ${p.role}${p.pod ? ` · ${p.pod}` : ""}`}><span className={css.whoName}>{p.name}</span><span className={css.whoSub}>{p.role}{p.pod ? ` · ${p.pod}` : ""}</span></span>
      </Link>
      {e ? (
        <span className={css.whoFacts}>
          <span>In <b>{time(e.in)}</b>{e.out ? <> · out <b>{e.missedOut ? "not recorded" : time(e.out)}</b></> : null}</span>
          <Badge>{MODE[e.mode]}</Badge>
          {e.onBreak ? <Badge tone="accent"><Coffee size={11} aria-hidden="true" />On a break</Badge> : null}
          {/* POLISH-2: a check-in after the shift ended is work after hours, not "Late by 11 h". */}
          {e.late && desk.policy.shiftEnd > desk.policy.shiftStart && time(e.in) >= desk.policy.shiftEnd ? <Badge>After the shift</Badge> : e.late ? <Badge tone="warning">Late by {duration(e.late)}</Badge> : null}
          {e.source === "regularised" ? <Badge>Corrected</Badge> : null}
          {/* Someone still at work has a session "not yet closed": said on every row, it was noise. Other reasons stay. */}
          <span><b>{duration(workedToday(p))}</b>{e.out ? " recorded today" : " so far"}{!e.out && p.attendance?.reasons.every((r) => r === "open_session") ? null : <AttendanceReasons attendance={p.attendance} />}</span>
        </span>
      ) : p.leave ? <span className={css.whoFacts}><Badge tone="accent">{leaveName(desk.types, p.leave.kind)}{p.leave.halfDay ? ` · ${halfLabel(p.leave.halfDay)}` : ""}</Badge></span> : null}
      {e && p.attendance?.eligible ? null : <span className={css.whoEnd}>{self ? <Regularise today={desk.today} date={desk.date} label="Correct" small variant="ghost" />
        : <Regularise today={desk.today} date={desk.date} personId={p.id} personName={first} label="Record" small variant="ghost" />}</span>}
    </li>
  );
}

/** Present, working from home and late over the last fourteen days. */
function Trend({ desk }: { desk: Desk }) {
  const t = desk.trend ?? []; const max = Math.max(4, ...t.map((d) => d.present)); const off = (d: string) => !desk.policy.workDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay() || 7);
  const worked = t.filter((d) => d.present); const late = t.reduce((n, d) => n + d.late, 0);
  if (!worked.length) return <Empty icon={CalendarCheck} compact title="No check-ins in the last 14 days" text="The columns fill in as people check in, or as you record their days." />;
  // One or two days with check-ins make lonely bars: say them instead (the chart appears from three days).
  if (worked.length < 3) return <SparseFacts label={`People checked in per day, last 14 days`} total={t.length}
    facts={worked.map((d) => ({ key: d.date, n: d.present, value: d.present, text: `checked in on ${longDay(d.date)}`, sub: [d.wfh ? `${d.wfh} from home` : "", d.late ? plural(d.late, "late mark") : "", desk.people?.length ? `of ${desk.people.length}` : ""].filter(Boolean).join(" · ") }))} />;
  return <>
    <div className={css.trend} role="img" aria-label={`People checked in per day, ${day(t[0].date)} to ${day(t[t.length - 1].date)}`}>
      {t.map((d) => (
        <div key={d.date} className={css.trendCol} data-off={off(d.date) ? "" : undefined} style={{ "--h": `${(d.present / max) * 100}%` } as CSSProperties}>
          <span className={css.trendBar}>
            {d.wfh ? <i data-kind="wfh" style={{ "--n": d.wfh } as CSSProperties} /> : null}
            {d.present - d.wfh ? <i style={{ "--n": d.present - d.wfh } as CSSProperties} /> : null}
          </span>
          <span className={css.trendTip}><b>{longDay(d.date)}{off(d.date) ? " · weekly off" : ""}</b><span>{d.present} checked in · {d.wfh} from home · {d.late} late</span></span>
        </div>
      ))}
    </div>
    <div className={css.trendAxis} aria-hidden="true">{t.map((d) => <span key={d.date} data-on={d.date === desk.today ? "" : undefined} data-off={off(d.date) ? "" : undefined}>{Number(d.date.slice(8))}</span>)}</div>
    <div className={css.legend}>
      <span><i className={css.swatch} />In the office or on duty</span><span><i className={css.swatch} data-kind="wfh" />From home</span>
      <span>Most in one day: {Math.max(...t.map((d) => d.present))} · {plural(late, "late mark")}</span>
    </div>
  </>;
}

/** The roster of a day, sorted into the groups the desk shows. */
export function roster(desk: Desk) {
  const noEntry = (desk.people ?? []).filter((p) => !p.entry);
  return {
    inNow: (desk.people ?? []).filter((p) => p.status === "in" || p.status === "break"), done: (desk.people ?? []).filter((p) => p.status === "done"),
    onLeave: noEntry.filter((p) => p.status === "leave"),
    out: noEntry.filter((p) => p.canSignIn && (p.status === "not_in" || p.status === "absent")),
    noSignIn: noEntry.filter((p) => !p.canSignIn && ["not_in", "absent", "untracked", "upcoming"].includes(p.status)),
    untracked: noEntry.filter((p) => p.canSignIn && (p.status === "untracked" || p.status === "upcoming")),
    off: noEntry.filter((p) => p.status === "holiday" || p.status === "off"),
    outcome: noEntry.filter((p) => p.status === "outcome"),
  };
}
/** One group of the roster under its heading; nothing at all when the group is empty. */
export function RosterGroup({ label, state, people, hint, grid, desk }: { label: string; state: string; people: RosterPerson[]; hint?: string; grid?: boolean; desk: Desk }) {
  return people.length ? <>
    <div className={css.groupHead} data-state={state}><i />{label}<small>{people.length}{hint ? ` · ${hint}` : ""}</small></div>
    <ul className={`${styles.list}${grid ? ` ${css.whoGrid}` : ""}`}>{people.map((p) => <Who key={p.id} p={p} desk={desk} />)}</ul>
  </> : null;
}

const summaryOf = (desk: Desk) => desk.attendance ?? { filter: { version: "off", provisional: false, maxMinutes: 0 }, from: desk.date, to: desk.date, recordedDays: 0, eligibleDays: 0, flaggedCount: 0, excludedDays: 0, coverage: null, workedMinutes: 0, recordedMinutes: 0, averageMinutes: null };

/** The team's last fourteen days: the averages and the day-by-day chart. Owner workbench (21 Oct 2026): they moved from
 *  the overview to Time → Attendance → Totals (the overview links there). */
export function DeskAverages({ desk }: { desk: Desk }) {
  return <div className={css.avgRow}>
    <Panel title="Attendance averages" sub="Last 14 days"><AttendanceCoverage summary={summaryOf(desk)} href="/hr?tab=attendance&view=totals" /></Panel>
    <Panel title="Last 14 days" sub="People checked in per day" action={{ href: "/hr?tab=attendance&view=month", label: "Month" }}><Trend desk={desk} /></Panel>
  </div>;
}

export function Dashboard({ desk }: { desk: Desk }) {
  const attendanceEnabled = desk.attendanceEnabled === true;
  const pending = desk.pending; const people = desk.people ?? []; const anomalies = desk.anomalies ?? []; const attendanceSummary = summaryOf(desk);
  const c = desk.counts ?? { headcount: 0, in: 0, onBreak: 0, done: 0, wfh: 0, late: 0, leave: 0, notIn: 0, canSignIn: 0 }; const isToday = desk.date === desk.today; const working = attendanceEnabled && desk.day?.kind === "working";
  const rosterRows = attendanceEnabled ? roster(desk) : { inNow: [], done: [], onLeave: [], out: [], noSignIn: [], untracked: [], off: [], outcome: [] };
  const { inNow, done, onLeave, out, noSignIn, untracked, off, outcome } = rosterRows;
  const regularisations = attendanceEnabled ? pending.regularisations ?? [] : [];
  const waiting = pending.leave.length + regularisations.length;
  const start = Number(desk.policy.shiftStart.slice(0, 2)) * 60 + Number(desk.policy.shiftStart.slice(3)) + desk.policy.graceMinutes;
  const lateFrom = `${String(Math.floor(start / 60) % 24).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
  const dayName = WEEKDAY[new Date(`${desk.date}T00:00:00Z`).getUTCDay()];
  const group = (label: string, state: string, people: RosterPerson[], hint?: string, grid = false) => <RosterGroup label={label} state={state} people={people} hint={hint} grid={grid} desk={desk} />;
  // At most three requests here, then a way to all of them: the list stays tidy and every decision is one tap away.
  const shownLeave = pending.leave.slice(0, ASK_TOP); const shownReg = regularisations.slice(0, ASK_TOP - shownLeave.length);
  const allLinks = pending.leave.length > 1 || shownLeave.length < pending.leave.length || shownReg.length < regularisations.length;
  const waitingPanel = (
    <Panel fill className={`${css.cq} ${css.aWait}`} title="Waiting for you" sub={waiting ? (attendanceEnabled ? pending.leave.length + " leave · " + plural(regularisations.length, "correction") : plural(pending.leave.length, "leave request")) : (attendanceEnabled ? "Leave and attendance corrections" : "Leave requests")} action={pending.leave.length && !allLinks ? { href: "/hr?tab=leave", label: "Leave" } : undefined}
      foot={allLinks ? <>
        {pending.leave.length > 1 || shownLeave.length < pending.leave.length ? <Link href="/hr?tab=leave">View all {pending.leave.length} in Leave<ChevronRight size={13} aria-hidden="true" /></Link> : null}
        {shownReg.length < regularisations.length ? <Link href="/hr?tab=attendance&view=totals">{plural(regularisations.length, "correction")} in Attendance<ChevronRight size={13} aria-hidden="true" /></Link> : null}
      </> : undefined}>
      {waiting ? <ul className={styles.list}>
        {shownLeave.map((l) => <LeaveAsk key={l.id} request={l} balance={l.balance} types={desk.types} me={desk.me} />)}
        {shownReg.map((r) => <CorrectionAsk key={r.id} request={r} me={desk.me} />)}
      </ul> : <Empty icon={CircleCheck} compact title="Nothing to decide" text={attendanceEnabled ? "Leave requests and attendance corrections land here the moment someone sends one, with their balance beside them." : "Leave requests land here the moment someone sends one, with their balance beside them."} action={{ href: "/hr?tab=leave&view=calendar", label: "Open the leave calendar" }} />}
    </Panel>
  );
  return <>
    {/* ATT: what Pulse could not settle by itself (one line; the list is Time → Attendance → To check). */}
    {attendanceEnabled && isToday ? <AttendanceExceptions compact /> : null}
    <section className={css.kpis} data-n={attendanceEnabled ? 5 : 3} aria-label="Key numbers">
      {attendanceEnabled ? <>
      <Kpi label={isToday ? "In now" : "Checked in"} value={isToday ? c.in : c.in + c.done} unit={`of ${c.headcount}`} tone={c.in + c.done ? "success" : undefined}
        note={[c.wfh ? `${c.wfh} from home` : "", c.late ? `${c.late} late` : "", isToday && c.onBreak ? `${c.onBreak} on a break` : ""].filter(Boolean).join(" · ") || (isToday ? `Shift ${desk.policy.shiftStart}–${desk.policy.shiftEnd}` : longDay(desk.date))} />

      </> : null}
      <Kpi label="On leave" value={desk.counts?.leave ?? "–"} note={desk.upcoming.length ? `${desk.upcoming.length} in the next 14 days` : "None coming up"} />
      {attendanceEnabled ? <>
      <Kpi label={isToday ? "Not in yet" : "No check-in"} value={out.length} tone={out.length && working ? "warning" : undefined} note={noSignIn.length ? `${noSignIn.length} have no sign-in` : working ? "Of those who can sign in" : "Not a working day"} />

      </> : null}
      <Kpi label="To approve" value={waiting} tone={waiting ? "warning" : undefined} href="/hr?tab=leave" note={waiting ? (attendanceEnabled ? pending.leave.length + " leave · " + plural(regularisations.length, "correction") : plural(pending.leave.length, "leave request")) : "Nothing to decide"} />
      <Kpi label="Open requests" value={desk.tickets.open} tone={desk.tickets.high ? "warning" : undefined} href="/hr?tab=requests" note={desk.tickets.open ? (desk.tickets.high ? `${desk.tickets.high} urgent · ` : "") + `${desk.tickets.unassigned} unassigned` : "The desk is clear"} />
    </section>

    {attendanceEnabled && !working ? <p className={css.note}><CalendarOff size={14} aria-hidden="true" /><span>{desk.day?.kind === "holiday" ? <><b>{desk.day?.name ?? "Holiday"}.</b> {longDay(desk.date)} is a holiday, so nobody is expected in.</> : <><b>{dayName} is a weekly off.</b> Nobody is expected in; anyone who checks in still shows below.</>}</span></p> : null}

    <Fit className={attendanceEnabled ? css.deskFit : `${css.deskFit} ${css.two}`}>
        {attendanceEnabled ? <>
        <Panel fill className={css.aWho} title="Who is in" sub={`${longDay(desk.date)}${isToday ? ` · as of ${desk.clock}` : ""}`} tools={<DayPicker date={desk.date} today={desk.today} />}>
          {group(isToday ? "In now" : "Checked in, never out", "in", inNow)}
          {group(isToday ? "Done for the day" : "Worked", "in", done)}
          {group("On leave", "leave", onLeave)}
          {group(isToday ? "Not in yet" : "No check-in", "out", out, isToday ? `expected by ${desk.policy.shiftStart}` : "no check-in or approved leave", true)}
          {group("Outcome-based", "none", outcome, "measured by work and KPIs; no check-in needed", true)}
          {group(desk.day?.kind === "holiday" ? "Holiday" : "Weekly off", "none", off, undefined, true)}
          {group("Not tracked on this day", "none", untracked, "before their first check-in", true)}
          {group("No sign-in yet", "none", noSignIn, "they cannot check in themselves; record their day for them", true)}
        </Panel>

      </> : null}
      <div className={attendanceEnabled ? css.deskCol : `${css.deskCol} ${css.one}`} data-rows={attendanceEnabled ? "decide" : undefined}>
        {waitingPanel}
        {attendanceEnabled ? <>
        <Panel fill className={`${css.cq} ${css.aLook}`} title="Worth a look" sub={anomalies.length ? `${plural(anomalies.length, "thing")} from the last 14 days` : "From the last 14 days"}>
          {anomalies.length ? <WorthALook anomalies={anomalies} />
            : <None icon={CircleCheck}>Nothing unusual in the last 14 days</None>}
        </Panel>

      </> : null}
      </div>
      <div className={attendanceEnabled ? css.deskCol : `${css.deskCol} ${css.one}`} data-rows={attendanceEnabled ? "stats" : undefined}>
        {attendanceEnabled ? <>
        {/* Owner workbench (21 Oct 2026): the overview answers who is in and what needs HR; the 14-day averages and chart
            live in Time → Attendance (one click, linked below). */}
        <p className={css.note}><CalendarCheck size={14} aria-hidden="true" /><span>Averages and the last 14 days: <Link href="/hr?tab=attendance&view=totals">Attendance</Link></span></p>
        </> : null}
        {/* Leave and holidays share one panel and page together, so neither is squeezed on a short window. */}
        <Panel fill className={css.aSoon} title="Coming up" sub="Leave and holidays">
          <div className={styles.subhead}><span>Approved leave, next 14 days</span><Link href="/hr?tab=leave&view=calendar" className={styles.panelAction}>Calendar<ChevronRight size={13} aria-hidden="true" /></Link></div>
          <ul className={styles.list}>{desk.upcoming.length ? desk.upcoming.map((l) => (
            <li key={l.id} className={styles.row}>
              <span className={css.dateChip} aria-hidden="true"><small>{weekdayLetter(l.fromDate)}</small><b>{Number(l.fromDate.slice(8))}</b></span>
              <span className={styles.rowMain}><Link href={`/people/${l.personId}?tab=attendance`} className={styles.rowTitle}>{l.name}</Link>
                <span className={styles.rowMeta}><span>{range(l.fromDate, l.toDate)}</span><span>{leaveName(desk.types, l.kind)}</span></span></span>
              <span className={styles.rowEnd}>{dayCount(l.days)}</span>
            </li>
          )) : <None icon={CalendarDays}>Nobody is away in the next two weeks</None>}</ul>
          <div className={styles.subhead}><span>Next holidays</span><Link href="/hr?tab=policies&view=holidays" className={styles.panelAction}>Holiday list<ChevronRight size={13} aria-hidden="true" /></Link></div>
          <ul className={styles.list}>{desk.holidays.length ? desk.holidays.map((h) => (
            <li key={h.day} className={styles.row}>
              <span className={css.dateChip} aria-hidden="true"><small>{day(h.day).split(" ")[1]}</small><b>{Number(h.day.slice(8))}</b></span>
              <span className={styles.rowMain}><span className={styles.rowTitle}>{h.name}</span><span className={styles.rowMeta}><span>{longDay(h.day)}</span>{h.optional ? <span>Optional</span> : null}</span></span>
            </li>
          )) : <None icon={PartyPopper}>No holiday list yet: every working day counts as one</None>}</ul>
        </Panel>
      </div>
    </Fit>
    {attendanceEnabled && !people.length ? <section className={styles.panel}><Empty icon={UserRoundX} first title="No current staff" text="People marked as current in the directory appear on this roster." action={{ href: "/people", label: "Open People" }} /></section> : null}
  </>;
}
