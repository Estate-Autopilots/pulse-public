import Link from "next/link";
import { CalendarCheck } from "lucide-react";
import { longDay, plural } from "../../lib/format";
import { Avatar, Empty, Fit, Panel, QueryTabs, Why, styles } from "../../ui";
import { AttendanceExceptions } from "./exceptions";
import { AttendanceCoverage } from "../parts";
import { AttendanceOff, isAttendanceEnabled } from "../attendance-off";
import { Regularise } from "../actions";
import { Dashboard, DeskAverages } from "./dashboard";
import { AttendanceWeekPanel } from "./attendance-week";
import type { AttendanceWeek } from "../../lib/attendance-week.mjs";
import type { Desk } from "../types";
import css from "../desk.module.css";
import { MODE, duration, type DateCell, type Regularisation, type TeamMonth } from "../types";
import { CorrectionAsk, MonthNav, monthName, num, weekdayLetter } from "./parts";

type Cell = TeamMonth["people"][number]["days"][number];
/** A day's mark: a letter and a shape as well as a colour, and the full story in the tooltip. */
function mark(d: Cell, date: DateCell): { s: string; letter: string; label: string } {
  if (d.status === "present") {
    const mode = d.mode ?? "office"; const hours = d.open ? "still checked in" : d.missedOut ? "no check-out recorded" : `${duration(d.worked)} worked`;
    return { s: mode === "office" ? "present" : mode, letter: mode === "wfh" ? "W" : mode === "field" ? "D" : "P", label: `${d.attendance && !d.attendance.eligible ? `Excluded: ${d.attendance.labels.join("; ")}. ` : ""}${MODE[mode]}, ${hours}${d.late ? `, late by ${duration(d.late)}` : ""}` };
  }
  if (d.status === "leave") return d.half ? { s: "half", letter: "½", label: "Half day of leave" } : { s: "leave", letter: "L", label: "On leave" };
  if (d.status === "holiday") return { s: "holiday", letter: "H", label: date.holiday ?? "Holiday" };
  if (d.status === "off") return { s: "off", letter: "–", label: "Weekly off" };
  if (d.status === "outcome") return { s: "outcome", letter: "O", label: "Outcome-based: no check-in needed" };
  if (d.status === "absent") return { s: "absent", letter: "A", label: "No check-in and no approved leave" };
  if (d.status === "today") return { s: "today", letter: "", label: "Today: not checked in yet" };
  if (d.status === "untracked") return { s: "untracked", letter: "", label: "Before this person's first check-in, so not counted" };
  return { s: "upcoming", letter: "", label: "Still to come" };
}
const KEYS: [string, string, string, { late?: boolean; missed?: boolean }?][] = [["present", "P", "In the office"], ["wfh", "W", "From home"], ["field", "D", "On duty outside"], ["present", "P", "Late", { late: true }],
  ["present", "P", "No check-out", { missed: true }], ["leave", "L", "Leave"], ["half", "½", "Half day"], ["holiday", "H", "Holiday"], ["off", "–", "Weekly off"], ["absent", "A", "No check-in"], ["outcome", "O", "Outcome-based"], ["today", "", "Today, not in yet"]];

/** The month for the whole team: one mark per person per day, then each person's totals. */
export function Attendance({ data, pending, me, view, desk, week }: { data: TeamMonth; pending: Regularisation[]; me: string | null; view?: string; desk?: Desk; week?: AttendanceWeek }) {
  if (!isAttendanceEnabled(data)) return <AttendanceOff />;
  const current = data.month === data.today.slice(0, 7); const workingDays = data.dates.filter((d) => !d.off && !d.holiday).length;
  const anyone = data.people.some((p) => p.summary.present || p.summary.leave || p.summary.absent);
  const recordDay = current ? data.today : data.to;
  const currentView = ["check", "week", "today", "team", "month", "totals"].includes(view ?? "") ? view! : "week";
  return <>
    <div className={styles.toolbar}>
      <QueryTabs base="/hr" keep={`tab=attendance&month=${data.month}`} param="view" sub current={currentView} items={[{key:"check",label:"To check"},{key:"week",label:"This week"},{key:"today",label:"Today"},{key:"team",label:"Team"},{key:"month",label:"Month"},{key:"totals",label:"Totals"}]} />
      {currentView !== "today" && currentView !== "week" && currentView !== "check" ? <MonthNav tab="attendance" view={currentView} month={data.month} today={data.today} /> : null}
      {currentView === "week" || currentView === "check" ? null : <span className={styles.muted}>{plural(data.people.length, "person", "people")} · {plural(workingDays, "working day")} in {monthName(data.month)} · shift {data.policy.shiftStart} to {data.policy.shiftEnd}</span>}
    </div>
    {/* ATT: only the days Pulse could not settle by itself, each with its evidence and one tap. */}
    {currentView === "check" ? <AttendanceExceptions /> : null}
    {currentView === "today" && desk ? <Dashboard desk={desk} /> : null}
    {currentView === "week" && week ? <AttendanceWeekPanel week={week} /> : null}
    {currentView === "team" ? <Fit className={css.one}><Panel fill title="Team attendance" sub={monthName(data.month)}><div className={css.teamCards} data-items="">{data.people.map((p) => <div key={p.id} className={css.member}><Link href={`/people/${p.id}?tab=attendance`} className={css.memberHead}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={32}/><span><b>{p.name}</b><small>{p.role}</small></span></Link><div className={css.ribbon}>{p.days.map((day,i) => {const m=mark(day,data.dates[i]);return <i key={i} data-s={m.s} title={`${longDay(data.dates[i].date)}: ${m.label}`} />;})}</div><dl className={css.memberStats}><div><dt>Present</dt><dd>{p.summary.present}</dd></div><div><dt>Leave</dt><dd>{p.summary.leave}</dd></div><div><dt>Late</dt><dd>{p.summary.late}</dd></div><div><dt>Average</dt><dd>{p.summary.averageMinutes !== null ? duration(p.summary.averageMinutes) : <span className={styles.muted} title="No eligible days">–<span className={styles.srOnly}> No eligible days</span></span>}</dd></div></dl><AttendanceCoverage compact summary={p.summary} href={`/people/${p.id}?tab=attendance`} /><span className={styles.muted}>{p.canSignIn ? "Can sign in" : "No sign-in yet"}</span></div>)}</div></Panel></Fit> : null}
    {currentView === "month" ? <Fit className={css.one}>
    <Panel fill title="Team month" sub="One mark per person per day. Hover a mark for the detail.">
      <div className={css.matrixWrap}>
        <table className={css.matrix}>
          <thead><tr>
            <th className={css.name} scope="col">Person</th>
            {data.dates.map((d) => <th key={d.date} scope="col" className={css.dayCol} data-off={d.off || d.holiday ? "" : undefined} data-today={d.date === data.today ? "" : undefined} title={`${longDay(d.date)}${d.holiday ? `: ${d.holiday}` : d.off ? ": weekly off" : ""}`}>{weekdayLetter(d.date)}<b>{Number(d.date.slice(8))}</b></th>)}
          </tr></thead>
          <tbody>{data.people.map((p) => (
            <tr key={p.id}>
              <th className={css.name} scope="row"><Link href={`/people/${p.id}?tab=attendance`} className={css.nameLink}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={22} className={css.avatarHide} /><span title={p.name}>{p.name}</span></Link></th>
              {p.days.map((d, i) => { const date = data.dates[i]; const m = mark(d, date); return (
                <td key={date.date} className={css.dayCol} data-off={date.off || date.holiday ? "" : undefined}>
                  {m.letter || (m.s === "today" && p.canSignIn) ? <span className={css.cell} data-s={m.s} data-late={d.late ? "" : undefined} data-missed={d.missedOut ? "" : undefined} title={`${p.name}, ${longDay(date.date)}: ${m.label}`}>{m.letter}<span className={styles.srOnly}> {m.label}</span></span> : null}
                </td>
              ); })}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className={css.keys} aria-label="What the marks mean">{KEYS.map(([s, letter, label, flag]) => <span key={label}><i className={css.cell} data-s={s} data-late={flag?.late ? "" : undefined} data-missed={flag?.missed ? "" : undefined} style={{ fontStyle: "normal" }}>{letter}</i>{label}</span>)}</div>
      {anyone ? null : <Empty icon={CalendarCheck} compact title={`No attendance recorded in ${monthName(data.month)}`} text="Marks appear as people check in. For people who cannot sign in yet, use “Record” in the table below." />}
    </Panel>
    </Fit> : null}
    {currentView === "totals" && desk?.attendanceEnabled === true ? <DeskAverages desk={desk} /> : null}
    {currentView === "totals" ? <Fit className={pending.length ? css.totalsFit : css.one}>
    <Panel fill title="Totals" sub={`${monthName(data.month)}, per person`} tools={<Why detail="A day counts as “no check-in” only after a person’s first check-in in Pulse. Days you file for someone wait for another approver, then are marked as corrected." more="Provisional averages exclude unresolved or implausible days, including sessions or daily totals over 12 hours. Recorded punches and payroll are unchanged. HR role/shift threshold approval remains open." />}>
      <div className={styles.tableWrap}><table className={`${styles.table} ${css.totals}`}>
        <thead><tr><th>Person</th><th className={styles.right}>Present</th><th className={styles.right}>Late</th><th className={styles.right}>From home</th><th className={styles.right}>Leave</th><th className={styles.right}>No check{"\u2011"}in</th><th className={styles.right}>Average day</th><th /></tr></thead>
        <tbody>{data.people.map((p) => { const s = p.summary; const tracked = !!p.trackedFrom; const n = (v: number) => v || tracked ? num(v) : <span className={styles.muted}>–</span>; return (
          <tr key={p.id} className={css.hoverRow}>
            <td><Link href={`/people/${p.id}?tab=attendance`} className={styles.person}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={26} /><span><span className={styles.cellLink}>{p.name}</span>
              <span className={styles.cellSub}>{tracked ? p.role : p.canSignIn ? "Has not checked in yet" : "No sign-in yet"}</span>
              <span className={css.totalsMini}>{s.present} present · {s.late} late · {s.wfh} from home · {s.leave} leave · {s.absent} no check-in</span></span></Link></td>
            <td className={styles.right}>{n(s.present)}</td><td className={styles.right}>{n(s.late)}</td><td className={styles.right}>{n(s.wfh)}</td><td className={styles.right}>{n(s.leave)}</td><td className={styles.right}>{n(s.absent)}</td>
            <td className={`${styles.right} ${css.totalsAvg}`}>{s.averageMinutes !== null ? <b>{duration(s.averageMinutes)}</b> : <span className={styles.muted}>No eligible days</span>}<AttendanceCoverage compact summary={s} href={`/people/${p.id}?tab=attendance`} />{s.missedOut ? <span className={css.totalsWarn}>{plural(s.missedOut, "missed check-out")}</span> : null}</td>
            <td className={styles.right}><span className={css.rowAction}>{p.id === me ? <Regularise today={data.today} date={recordDay} label="Correct mine" small variant="ghost" /> : <Regularise today={data.today} date={recordDay} personId={p.id} personName={p.name.split(" ")[0]} label="Record" small variant="ghost" />}</span></td>
          </tr>
        ); })}</tbody>
      </table></div>
    </Panel>
    {pending.length ? <Panel fill title="Corrections waiting for you"><ul className={styles.list}>{pending.map((r) => <CorrectionAsk key={r.id} request={r} me={me} />)}</ul></Panel> : null}
    </Fit> : null}
  </>;
}
