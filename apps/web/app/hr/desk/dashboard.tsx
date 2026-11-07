import Link from "next/link";
import type { CSSProperties } from "react";
import { CalendarCheck, CalendarDays, ChevronRight, CircleCheck, Coffee, PartyPopper, UserRoundX } from "lucide-react";
import { day, longDay, plural, range, time } from "../../lib/format";
import { Avatar, Badge, Empty, Panel, styles } from "../../ui";
import { Regularise } from "../actions";
import css from "../desk.module.css";
import { MODE, dayCount, duration, leaveName, type Desk, type RosterPerson } from "../types";
import { SparseFacts } from "../../charts";
import { workedToday } from "../../lib/roster.mjs";
import { AttendanceCoverage, AttendanceReasons } from "../parts";
import { CorrectionAsk, LeaveAsk, None, halfLabel, weekdayLetter } from "./parts";
import { WorthALook } from "./worth";
import { TodayTimeline } from "./day-board";
import { AttendanceExceptions } from "./exceptions";


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
  const pending = desk.pending; const people = desk.people ?? []; const anomalies = desk.anomalies ?? [];
  const isToday = desk.date === desk.today;
  const { onLeave, out } = attendanceEnabled ? roster(desk) : { onLeave: [] as RosterPerson[], out: [] as RosterPerson[] };
  const regularisations = attendanceEnabled ? pending.regularisations ?? [] : [];
  const waiting = pending.leave.length + regularisations.length;
  // UX-POLISH-4 (owner's chosen concept "Today board", 7 Nov 2026): no banners and no stats strip. The day is one
  // timeline (who came in when, on time or late, and now), with its counts in the legend and the attendance chip beside
  // them; under it three equal columns, each scrolling on its own: Approvals (decided in place), Who is out (on leave,
  // not in yet, then what is coming up and the holidays) and Worth a look as a full column.
  const approvals = (
    <Panel fill className={css.boardCol} title="Approvals" sub={waiting ? `${waiting}` : undefined} action={waiting ? { href: "/hr?tab=approvals", label: "All" } : undefined}>
      {waiting ? <ul className={styles.list} data-stagger="">
        {pending.leave.map((l) => <LeaveAsk key={l.id} request={l} balance={l.balance} types={desk.types} me={desk.me} />)}
        {regularisations.map((r) => <CorrectionAsk key={r.id} request={r} me={desk.me} />)}
      </ul> : <Empty icon={CircleCheck} compact title="Nothing to decide" text={attendanceEnabled ? "Leave requests and attendance corrections land here the moment someone sends one, with their balance beside them." : "Leave requests land here the moment someone sends one, with their balance beside them."} />}
    </Panel>
  );
  const awayRow = (p: RosterPerson, what: string) => <li key={p.id} className={styles.row}>
    <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={26} />
    <span className={styles.rowMain}><Link href={`/people/${p.id}?tab=attendance`} className={styles.rowTitle}>{p.name}</Link><span className={styles.rowMeta}><span>{what}</span></span></span>
  </li>;
  const whoOut = (
    <Panel fill className={css.boardCol} title="Who is out" sub={`${onLeave.length + out.length}`}>
      {onLeave.length || out.length ? <ul className={styles.list} data-stagger="">
        {onLeave.map((p) => awayRow(p, `${p.leave ? leaveName(desk.types, p.leave.kind) : "Leave"}${p.leave?.halfDay ? ` · ${halfLabel(p.leave.halfDay)}` : ""}`))}
        {out.map((p) => awayRow(p, isToday ? `Not in yet · expected by ${desk.policy.shiftStart}` : "No check-in"))}
      </ul> : <None icon={CircleCheck}>{isToday ? "Everyone expected is in" : "Nobody was out"}</None>}
      <div className={styles.subhead}><span>Coming up</span><Link href="/hr?tab=leave&view=calendar" className={styles.panelAction}>Calendar<ChevronRight size={13} aria-hidden="true" /></Link></div>
      <ul className={styles.list}>{desk.upcoming.length ? desk.upcoming.map((l) => (
        <li key={l.id} className={styles.row}>
          <span className={css.dateChip} aria-hidden="true"><small>{weekdayLetter(l.fromDate)}</small><b>{Number(l.fromDate.slice(8))}</b></span>
          <span className={styles.rowMain}><Link href={`/people/${l.personId}?tab=attendance`} className={styles.rowTitle}>{l.name}</Link>
            <span className={styles.rowMeta}><span>{range(l.fromDate, l.toDate)}</span><span>{leaveName(desk.types, l.kind)}</span></span></span>
          <span className={styles.rowEnd}>{dayCount(l.days)}</span>
        </li>
      )) : <None icon={CalendarDays}>Nobody is away in the next two weeks</None>}
      {desk.holidays.slice(0, 3).map((h) => (
        <li key={h.day} className={styles.row}>
          <span className={css.dateChip} aria-hidden="true"><small>{day(h.day).split(" ")[1]}</small><b>{Number(h.day.slice(8))}</b></span>
          <span className={styles.rowMain}><span className={styles.rowTitle}><PartyPopper size={13} aria-hidden="true" /> {h.name}</span><span className={styles.rowMeta}><span>{longDay(h.day)}</span>{h.optional ? <span>Optional</span> : <span>Company holiday</span>}</span></span>
        </li>
      ))}</ul>
    </Panel>
  );
  const worth = (
    <Panel fill className={`${css.boardCol} ${css.boardWorth}`} title="Worth a look" sub={anomalies.length ? `${anomalies.length} from the last 14 days` : "Last 14 days"} action={{ href: "/hr?tab=attendance&view=totals", label: "Averages" }}>
      {anomalies.length ? <WorthALook anomalies={anomalies} /> : <None icon={CircleCheck}>Nothing unusual in the last 14 days</None>}
    </Panel>
  );
  return <>
    {attendanceEnabled ? <TodayTimeline desk={desk} extra={isToday ? <AttendanceExceptions compact /> : null} /> : null}
    <div className={css.board} data-cols={attendanceEnabled ? 3 : 2}>
      {approvals}
      {attendanceEnabled ? whoOut : null}
      {attendanceEnabled ? worth : <Panel fill className={css.boardCol} title="Coming up" sub="Leave and holidays">
        <ul className={styles.list}>{desk.upcoming.length ? desk.upcoming.map((l) => <li key={l.id} className={styles.row}><span className={styles.rowMain}><span className={styles.rowTitle}>{l.name}</span><span className={styles.rowMeta}><span>{range(l.fromDate, l.toDate)}</span></span></span><span className={styles.rowEnd}>{dayCount(l.days)}</span></li>)
          : <None icon={CalendarDays}>Nobody is away in the next two weeks</None>}</ul>
      </Panel>}
    </div>
    {attendanceEnabled && !people.length ? <section className={styles.panel}><Empty icon={UserRoundX} first title="No current staff" text="People marked as current in the directory appear on this roster." action={{ href: "/people", label: "Open People" }} /></section> : null}
  </>;
}
