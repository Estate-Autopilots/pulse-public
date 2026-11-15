import Link from "next/link";
import { CalendarCheck } from "lucide-react";
import { longDay } from "../../lib/format";
import type { AttendanceWeek } from "../../lib/attendance-week.mjs";
import { Avatar, Empty, Fit, Panel, styles } from "../../ui";
import css from "../desk.module.css";
import { AttendanceOff } from "../attendance-off";

const hasAttendance = (week: AttendanceWeek) => week.people.some((person) => person.days.some((day) => ["Present", "Leave", "No check-in"].includes(day.status)));
const labelFor = (date: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" }).format(new Date(date + "T00:00:00.000Z"));
/** Each status as the month view marks it (state, letter), so the week and the month read the same. */
const MARK: Record<string, [string, string]> = { Present: ["present", "P"], Leave: ["leave", "L"], Holiday: ["holiday", "H"], "Weekly off": ["off", "–"], "No check-in": ["absent", "A"], "Not marked": ["today", ""], "No data": ["untracked", "–"], Upcoming: ["upcoming", ""] };
/** "4 present · 1 leave": the counted statuses of a week, in words. */
const tally = (days: { status: string }[]) => ([["Present", "present"], ["Leave", "leave"], ["No check-in", "no check-in"]] as const)
  .map(([status, word]) => [days.filter((d) => d.status === status).length, word] as const).filter(([n]) => n).map(([n, word]) => `${n} ${word}`).join(" · ");

/** This week for the whole team: a tinted mark per person per day (a letter on phones), the week in words on the right. */
export function AttendanceWeekPanel({ week }: { week: AttendanceWeek }) {
  if (week.attendanceEnabled !== true) return <AttendanceOff />;
  return (
    <Fit className={css.one}>
      <Panel fill title="This week" sub={longDay(week.from) + " – " + longDay(week.to)} action={{ href: "/hr?tab=attendance&view=month", label: "Month" }}>
        <div className={css.matrixWrap}>
          <table className={`${css.matrix} ${css.week}`} aria-label="Daily attendance this week">
            <thead><tr>
              <th scope="col" className={css.name}>Person</th>
              {week.days.map((date) => <th key={date} scope="col" className={css.weekDay} title={longDay(date)} data-today={date === week.today ? "" : undefined}>{labelFor(date)}<b>{Number(date.slice(8))}</b></th>)}
              <th scope="col" className={css.weekSum}>This week</th>
            </tr></thead>
            <tbody>{week.people.map((person) => (
              <tr key={person.id}>
                <th scope="row" className={css.name}><Link href={`/people/${person.id}?tab=attendance`} className={css.nameLink}><Avatar name={person.name} id={person.id} size={22} className={css.avatarHide} /><span title={person.name}>{person.name}</span></Link></th>
                {person.days.map((day) => { const [s, letter] = MARK[day.status] ?? ["untracked", "–"]; return (
                  <td key={day.date} className={css.weekDay} title={person.name + ", " + longDay(day.date) + ": " + day.status}>
                    <span className={css.weekMark} data-s={s}><span className={css.weekWord}>{s === "upcoming" ? "" : day.status}</span><span className={css.weekLetter} aria-hidden="true">{letter}</span>{s === "upcoming" ? <span className={styles.srOnly}>{day.status}</span> : null}</span>
                  </td>
                ); })}
                <td className={css.weekSum}>{tally(person.days) || <span className={styles.muted}>Nothing recorded</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {hasAttendance(week) ? null : <Empty icon={CalendarCheck} compact title="No attendance records this week" text="Days without an attendance record stay marked “No data.” Marks appear as people check in; record a day for someone from Totals." action={{ href: "/hr?tab=attendance&view=totals", label: "Open Totals" }} />}
      </Panel>
    </Fit>
  );
}
