// UX-POLISH-4 (owner's chosen concepts, 7 Nov 2026: CODEX-CONCEPTS hr-desk "Today board" and hr-time "Gantt day"):
//   - TodayTimeline: the day at a glance on the shift's time axis. Each check-in is a face placed at its time; faces
//     within the same quarter hour stack. On-time is green and late is amber, with a "now" marker. The legend carries
//     the day's counts, replacing the old stats strip.
//   - DayGantt: one bar per person from check-in to check-out, grouped by team on an 08:00-21:00 axis over the shift
//     band. A late check-in's time is amber, and a missing check-out is a hatched tail to the end of the shift. People
//     not in, on leave or off read as muted words in their row, not pills.
// Both read the HR desk's roster for the chosen day (desk.people); nothing is computed on the server for them.
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { initials } from "../../ui";
import { time } from "../../lib/format";
import { leaveName, type Desk, type RosterPerson } from "../types";
import { DayPicker } from "./controls";
import css from "./day-board.module.css";

const mins = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const at = (iso: string) => mins(time(iso));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** The day's counts, shared by the timeline legend and the Gantt header. */
export function dayCounts(desk: Desk) {
  const people = desk.people ?? [];
  const inside = people.filter((p) => p.entry);
  return {
    total: people.filter((p) => p.canSignIn || p.entry).length,
    present: inside.length,
    late: inside.filter((p) => p.entry!.late > 0).length,
    notIn: people.filter((p) => !p.entry && (p.status === "not_in" || p.status === "absent")).length,
    away: people.filter((p) => !p.entry && (p.status === "leave" || p.status === "off" || p.status === "holiday")).length,
    pending: desk.pending.leave.length + (desk.pending.regularisations?.length ?? 0),
  };
}

export function TodayTimeline({ desk, extra }: { desk: Desk; extra?: ReactNode }) {
  const start = mins(desk.policy.shiftStart), end = Math.max(mins(desk.policy.shiftEnd), start + 60);
  const span = end - start, isToday = desk.date === desk.today;
  const c = dayCounts(desk);
  const pos = (m: number) => `${(Math.min(Math.max(m, start), end) - start) / span * 100}%`;
  // Faces within the same quarter hour share a column; the column holds up to four faces, then "+N".
  const columns = new Map<number, RosterPerson[]>();
  for (const p of desk.people ?? []) if (p.entry) { const q = Math.floor(Math.min(Math.max(at(p.entry.in), start), end) / 15) * 15; columns.set(q, [...(columns.get(q) ?? []), p]); }
  const hours = Array.from({ length: Math.floor(span / 60) + 1 }, (_, i) => start + i * 60).filter((m) => m <= end);
  const now = isToday ? mins(desk.clock) : null;
  return <section className={css.glance} aria-label="Today at a glance">
    <header className={css.glanceHead}>
      <h2>{isToday ? "Today at a glance" : "The day at a glance"}</h2>
      <ul className={css.legendCounts}>
        <li><i data-tone="in" />{c.present} in</li>
        <li><i data-tone="out" />{c.notIn + c.away} out</li>
        <li><i data-tone="pending" />{c.pending} pending</li>
      </ul>
      <span className={css.headTools}>{extra}<DayPicker date={desk.date} today={desk.today} /></span>
    </header>
    <div className={css.track} role="img" aria-label={`${c.present} people checked in between ${desk.policy.shiftStart} and ${desk.policy.shiftEnd}${c.late ? `, ${c.late} late` : ""}`}>
      {[...columns.entries()].sort((a, b) => a[0] - b[0]).map(([q, list], i) => <div key={q} className={css.cluster} style={{ left: pos(q + 7), "--i": i } as CSSProperties}>
        {list.slice(0, 4).map((p) => <Link key={p.id} href={`/people/${p.id}?tab=attendance`} className={css.face} data-late={p.entry!.late > 0 ? "" : undefined} title={`${p.name} · in at ${time(p.entry!.in)}${p.entry!.late ? " · late" : ""}`}>{initials(p.name)}</Link>)}
        {list.length > 4 ? <span className={css.face} data-rest="" title={list.slice(4).map((p) => p.name).join(", ")}>+{list.length - 4}</span> : null}
      </div>)}
      {now !== null && now >= start && now <= end ? <span className={css.now} style={{ left: pos(now) }}><b>{desk.clock}</b></span> : null}
      <div className={css.axis} aria-hidden="true">{hours.map((m) => <span key={m} style={{ left: pos(m) }}>{hhmm(m)}</span>)}</div>
    </div>
    <ul className={css.legend} aria-label="Legend"><li><i data-tone="in" />On time</li><li><i data-tone="late" />Late</li>{now !== null ? <li><i data-tone="now" />Now</li> : null}</ul>
  </section>;
}

const AXIS_FROM = 8 * 60, AXIS_TO = 21 * 60;
export function DayGantt({ desk }: { desk: Desk }) {
  const c = dayCounts(desk), isToday = desk.date === desk.today;
  const from = Math.min(AXIS_FROM, mins(desk.policy.shiftStart) - 60), to = Math.max(AXIS_TO, mins(desk.policy.shiftEnd) + 60), span = to - from;
  const x = (m: number) => `${(Math.min(Math.max(m, from), to) - from) / span * 100}%`;
  const shiftStart = mins(desk.policy.shiftStart), shiftEnd = mins(desk.policy.shiftEnd), now = isToday ? mins(desk.clock) : shiftEnd;
  const groups = new Map<string, RosterPerson[]>();
  for (const p of desk.people ?? []) { const k = p.pod ?? p.department ?? "No team"; groups.set(k, [...(groups.get(k) ?? []), p]); }
  const hours = Array.from({ length: Math.floor(span / 60) + 1 }, (_, i) => from + i * 60);
  const R = 40, C = 2 * Math.PI * R, share = c.total ? c.present / c.total : 0;
  let row = 0;
  const word = (p: RosterPerson) => p.leave ? `${leaveName(desk.types, p.leave.kind)}${p.leave.halfDay ? " · half day" : ""}` : p.status === "off" ? "Weekly off" : p.status === "holiday" ? (desk.day?.name ?? "Holiday")
    : p.status === "outcome" ? "Outcome-based" : p.status === "untracked" || p.status === "upcoming" ? "Not tracked yet" : isToday ? "Not in yet" : "No check-in";
  return <div className={css.gantt}>
    <section className={css.ganttHead} aria-label="The day in numbers">
      <span className={css.ring}>
        <svg viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r={R} className={css.ringTrack} /><circle cx="48" cy="48" r={R} className={css.ringFill} style={{ "--c": C, "--to": C * (1 - share) } as CSSProperties} strokeDasharray={C} strokeDashoffset={C * (1 - share)} /></svg>
        <span><b>{c.present} of {c.total}</b><small>present</small></span>
      </span>
      <span className={css.stat} data-tone="late"><b>{c.late}</b>late</span>
      <span className={css.stat} data-tone="out"><b>{c.notIn}</b>not in</span>
      <span className={css.stat}><b>{c.away}</b>leave / off</span>
      <span className={css.headTools}><DayPicker date={desk.date} today={desk.today} /></span>
    </section>
    <section className={css.chart} aria-label={`Attendance on ${desk.date}`}>
      <div className={css.chartScroll}>
        <div className={css.gridHead}><span className={css.nameCol}>Person</span><span className={css.lane}>{hours.map((m) => <span key={m} className={css.hour} style={{ left: x(m) }}>{hhmm(m)}</span>)}</span></div>
        <div className={css.rows} style={{ "--band-from": x(shiftStart), "--band-to": x(shiftEnd) } as CSSProperties}>
          {[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([team, people]) => <details key={team} open className={css.group}>
            <summary><span>{team}</span><small>{people.filter((p) => p.entry).length} of {people.length} in</small></summary>
            {people.map((p) => { const e = p.entry, i = row++;
              const inM = e ? at(e.in) : 0, outM = e ? (e.out && !e.missedOut ? at(e.out) : e.missedOut ? Math.max(shiftEnd, inM + 30) : now) : 0;
              const dot = e ? (e.late ? "late" : "in") : p.leave || p.status === "off" || p.status === "holiday" ? "away" : p.status === "outcome" ? "away" : "out";
              return <div key={p.id} className={css.row}>
                <Link href={`/people/${p.id}?tab=attendance`} className={css.nameCol} title={`${p.name} · ${p.role}`}><i data-tone={dot} aria-hidden="true" /><span>{p.name}</span></Link>
                <span className={css.lane}>
                  {e ? <span className={css.bar} data-missed={e.missedOut ? "" : undefined} data-open={!e.out && !e.missedOut ? "" : undefined} style={{ left: x(inM), width: `calc(${x(outM)} - ${x(inM)})`, "--i": Math.min(i, 30) } as CSSProperties}
                    title={`${p.name}: in ${time(e.in)}${e.out && !e.missedOut ? `, out ${time(e.out)}` : e.missedOut ? ", no check-out recorded" : ", still in"}${e.late ? ", late" : ""}`}>
                    <b data-late={e.late ? "" : undefined}>{time(e.in)}</b>{e.out && !e.missedOut ? <b data-end="">{time(e.out)}</b> : null}</span>
                    : <span className={css.word} style={{ left: x(shiftStart) }}>{word(p)}</span>}
                </span>
              </div>; })}
          </details>)}
        </div>
      </div>
      <footer className={css.ganttFoot}>
        <span><i data-tone="in" />On time (within the shift)</span><span><i data-tone="late" />Late (in after {desk.policy.shiftStart})</span>
        <span><i data-tone="missed" />No check-out recorded</span><span><i data-tone="band" />Shift {desk.policy.shiftStart}–{desk.policy.shiftEnd}</span>
        <span className={css.footCount}>{(desk.people ?? []).length} people</span>
      </footer>
    </section>
  </div>;
}
