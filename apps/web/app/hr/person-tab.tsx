import { PerformanceSignals } from "../people/performance";
import Link from "next/link";
import { dayYear, plural } from "../lib/format";
import type { ReactNode } from "react";
import { Deck } from "../fit";
import { Delta, Fit, Kpi, Panel, Tiles, Why, styles, viewNames } from "../ui";
import { Regularise, TodayCard } from "./actions";
import { AttendanceReasons, BalanceCards, balanceNote, CalendarLegend, CorrectionList, LeaveList, MonthCalendar, MonthNav, MonthSummary, PerformanceChart, TicketList } from "./parts";
import type { PersonHr } from "./types";
import css from "./hr.module.css";
import { AttendanceOff } from "./attendance-off";

const pct = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : "–";

/** A person's attendance and leave on their profile, for the person, their manager, HR and admins.
 *  The month gets the window beside today and the month's numbers; leave and requests are the second part,
 *  stacked below on a window tall enough for both. */
export function AttendanceLeaveTab({ data: d, base, head }: { data: PersonHr; base: string; /** The profile tabs share the row with the switch. */ head?: ReactNode }) {
  const first = d.person.name.split(" ")[0]; const types = d.leave.types ?? [];
  const month = d.month ?? { key: d.today.slice(0, 7), from: d.today, to: d.today, days: [], summary: { filter: { version: "off", provisional: false, maxMinutes: 0 }, from: d.today, to: d.today, recordedDays: 0, eligibleDays: 0, flaggedCount: 0, excludedDays: 0, coverage: null, workedMinutes: 0, recordedMinutes: 0, averageMinutes: null, present: 0, wfh: 0, late: 0, leave: 0, absent: 0, missedOut: 0 }, trackedFrom: null };
  const now = d.now ?? { state: "out", entry: null, holiday: null, leave: null }; const wfh = d.wfh ?? { used: 0, allowance: null }; const regularisations = d.regularisations ?? [];
  return <Deck tall={960} head={head} param="detail" views={[
    { label: d.self ? "Your month" : `${first}’s month`, content: d.attendanceEnabled === true ? <Fit className={css.monthFit}>
      <Panel fill title={d.self ? "Your month" : `${first}’s month`} sub={month.trackedFrom ? `Counted from the first check-in, ${dayYear(month.trackedFrom)}` : "Starts counting with the first check-in"}
        tools={<><MonthNav base={`${base}?tab=attendance`} month={month.key} today={d.today} />
          {d.can.record ? <Regularise today={d.today} personId={d.person.id} personName={d.person.name} label="Record a day" small /> : null}
          {d.self ? <Link href="/me?tab=attendance" className={`${styles.btn} ${styles.btnSmall}`}>Open My desk</Link> : null}</>}>
        <MonthCalendar days={month.days} today={d.today} types={types} />
        <CalendarLegend />
      </Panel>
      <div className={css.monthSide}>
        <TodayCard now={now} policy={d.policy} clock={d.clock} today={d.today} canAct={false} wfh={wfh} name={d.self ? undefined : first} attendanceEnabled={d.attendanceEnabled} />
        <Panel title="The month in numbers"><MonthSummary summary={month.summary} /><div aria-label="Excluded attendance days" tabIndex={0} style={{ maxHeight: 180, overflowY: "auto" }}>{month.days.filter(day => day.attendance && !day.attendance.eligible).map(day => <div key={day.date}><b>{dayYear(day.date)}</b><AttendanceReasons attendance={day.attendance} />{d.can.record || d.can.act ? <Regularise today={d.today} date={day.date} personId={d.self ? undefined : d.person.id} personName={d.person.name} label={d.self ? "Request correction" : "Review correction"} small /> : <Link href={`${base}?tab=attendance&detail=leave-requests`}>Review correction requests</Link>}</div>)}</div></Panel>
      </div>
    </Fit> : <AttendanceOff /> },
    { label: "Leave & requests", content: <Fit className={css.threeFit}>
      <Panel fill title="Leave balances" sub={`${d.leave.year} leave year`} action={d.can.adjust && !d.self ? { href: "/hr?tab=leave&view=balances", label: "Adjust" } : undefined}
        tools={<Why detail={balanceNote(d.leave.provisional, d.leave.trackingFrom)} />}>
        <BalanceCards types={types} balances={d.leave.balances} provisional={d.leave.provisional} trackingFrom={d.leave.trackingFrom} stacked />
      </Panel>
      <Panel fill title="Leave requests" sub={plural(d.leave.requests.length, "request")}>
        <LeaveList requests={d.leave.requests} types={types} today={d.today} mine={d.self && d.can.act} decide={d.can.decide} />
      </Panel>
      <div className={css.monthSide}>
        {d.attendanceEnabled === true ? <Panel fill title="Attendance corrections" sub={plural(regularisations.length, "request")}>
          <CorrectionList items={regularisations} mine={d.self && d.can.act} decide={d.can.decide} />
        </Panel> : null}
        {d.tickets.length ? <Panel fill title="Requests raised with HR" sub={plural(d.tickets.length, "request")}><TicketList tickets={d.tickets} /></Panel> : null}
      </div>
    </Fit> },
  ]} />;
}

/** Deliveries against the person's own baseline. For the person and admins; HR does not see delivery work. */
export async function PerformancePanel({ data: d, compact }: { data: PersonHr; compact?: boolean }) {
  const perf = d.performance?.linked ? d.performance : null;
  if (!perf || !perf.allTime || compact) return <PerformanceSignals personId={d.person.id} compact={compact}/>;
  return <>
    <PerformanceSignals personId={d.person.id}/>
    <Tiles count={5}>
      <Kpi label="This week" value={perf.thisWeek} unit="deliveries" note="So far" />
      <Kpi label="Last four weeks" value={perf.recent.toFixed(1)} unit="a week" delta={<Delta value={perf.recent} previous={perf.baseline} />} note={`Usual week: ${perf.baseline.toFixed(1)}`} />
      <Kpi label="Finals" value={pct(perf.quality.finals, perf.quality.total)} note={`${perf.quality.finals} of ${plural(perf.quality.total, "delivery", "deliveries")} in eight weeks`} />
      <Kpi label="Revised after upload" value={pct(perf.quality.revised, perf.quality.total)} note={`${plural(perf.quality.revised, "file")} changed again after first upload`} />
      <Kpi label="Projects" value={perf.quality.projects} note={`${plural(perf.quality.activeDays, "day")} with a delivery in eight weeks`} />
    </Tiles>
    <Panel title="Deliveries by week" sub="Against the person’s own usual week, not against anyone else"><PerformanceChart data={perf} today={d.today} /></Panel>
    <p className={styles.muted} style={{ margin: 0, fontSize: 12 }}>This chart counts delivery files with qualified uploader evidence for this person. Shared logins and unknown uploaders receive no personal credit. Delivery time remains the snapshot’s modification date; Activity shows observed operation times. The usual week is the person’s own average over the eight weeks before the last four. “Revised after upload” counts files Drive saw change again later: a signal of rework, not a judgement. {plural(perf.allTime, "delivery", "deliveries")} in all{perf.firstDeliveryAt ? ` since ${dayYear(perf.firstDeliveryAt)}` : ""}.</p>
  </>;
}
viewNames({ AttendanceLeaveTab, PerformancePanel });
