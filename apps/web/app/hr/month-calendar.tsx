"use client";
// One person's month as a calendar (R43 polish of the round-4 calendar). The month is one tab stop: arrow keys move
// between days, Home/End go to the first and last day. Tapping a day, or Enter/Space on it, writes the day's full story
// under the grid — phones have no hover tooltips, so nothing is left only in a `title`.
import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { longDay, time } from "../lib/format";
import { MODE, duration, leaveName, type Day, type LeaveType } from "./types";
import css from "./hr.module.css";
import styles from "../ui.module.css";

const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LABEL: Record<Day["status"], string> = { present: "Present", leave: "On leave", holiday: "Holiday", off: "Weekly off", absent: "No check-in", upcoming: "", today: "Today", untracked: "", outcome: "Outcome-based" };
const half = (h: string | null) => h === "first" ? "first half" : h === "second" ? "second half" : "";

/** The short label (cell name and hover title) and the longer story shown when the day is picked. */
function story(d: Day, types: LeaveType[]): { label: string; detail: string } {
  const e = d.entry;
  if (e) {
    const label = `${d.sessions.length} session(s), ${d.attendance?.eligible ? `${duration(d.attendance.minutes!)} eligible` : `excluded: ${d.attendance?.labels.join("; ")}`}. ${MODE[e.mode]}: in ${time(e.in)}${e.out ? `, out ${time(e.out)}, ${duration(e.worked)} worked` : ", still in"}${e.late ? `, late by ${duration(e.late)}` : ""}${e.missedOut ? ", no check-out" : ""}`;
    const parts = [`${MODE[e.mode]}: in ${time(e.in)}${e.missedOut ? ", no check-out recorded" : e.out ? `, out ${time(e.out)}` : ", still in"}.`];
    if (e.out && !e.missedOut) parts.push(`${duration(e.worked)} worked${e.breakMinutes ? ` after ${duration(e.breakMinutes)} of breaks` : ""}${d.sessions.length > 1 ? ` across ${d.sessions.length} sessions` : ""}.`);
    if (e.late) parts.push(`Late by ${duration(e.late)}.`);
    if (d.attendance && !d.attendance.eligible) parts.push(`Not in your average until checked: ${d.attendance.labels.join("; ")}.`);
    if (e.source === "regularised") parts.push("Corrected after a request.");
    if (d.workApproved) parts.push("Approved work on a day off: it earns comp-off under HR’s rule.");
    if (d.leave?.halfDay) parts.push(`Half day of ${leaveName(types, d.leave.kind)} (${half(d.leave.halfDay)}).`);
    return { label, detail: parts.join(" ") };
  }
  if (d.leave) { const l = `${leaveName(types, d.leave.kind)}${d.leave.halfDay ? `, ${half(d.leave.halfDay)}` : ""}`; return { label: l, detail: `${l}. Approved leave: no check-in needed${d.leave.halfDay ? " for that half" : ""}.` }; }
  if (d.workApproved) return { label: "Approved day-off work", detail: "Approved work on a day off: check in as usual. The check-in earns comp-off under HR’s rule." };
  if (d.holiday) return { label: d.holiday, detail: `Holiday: ${d.holiday}. No check-in needed. To work anyway, ask first under “Working on a day off?”; approved work earns comp-off.` };
  if (d.status === "off") return { label: DAY_LABEL.off, detail: "Weekly off. No check-in needed. To work anyway, ask first under “Working on a day off?”; approved work earns comp-off." };
  if (d.pendingLeave) return { label: "Leave requested", detail: "Leave requested and waiting for a decision." };
  if (d.status === "absent") return { label: DAY_LABEL.absent, detail: "No check-in and no approved leave. If you worked that day, request a correction." };
  if (d.status === "outcome") return { label: DAY_LABEL.outcome, detail: "Outcome-based: your work counts by results, so no check-in is needed." };
  if (d.status === "untracked") return { label: "", detail: "Before the first check-in in Pulse, so not counted either way." };
  if (d.status === "today") return { label: DAY_LABEL.today, detail: "Today: no check-in yet." };
  return { label: DAY_LABEL[d.status], detail: "Still to come." };
}

export function MonthCalendar({ days, today, types }: { days: Day[]; today: string; types: LeaveType[] }) {
  const cells = useRef(new Map<string, HTMLDivElement>());
  const detailId = useId();
  const [moved, setFocus] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  if (!days.length) return <p className={styles.muted}>No days recorded in this month yet.</p>;
  // Another month keeps the component: the focused day falls back to today, or the 1st, when it is not in this one.
  const has = (date: string | null) => !!date && days.some((d) => d.date === date);
  const focus = has(moved) ? moved! : has(today) ? today : days[0].date;
  const lead = (new Date(`${days[0].date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const slots: (Day | null)[] = [...Array.from({ length: lead }, () => null), ...days];
  while (slots.length % 7) slots.push(null);
  const weeks = Array.from({ length: slots.length / 7 }, (_, i) => slots.slice(i * 7, i * 7 + 7));
  const move = (to: number) => { const d = days[Math.max(0, Math.min(days.length - 1, to))]; setFocus(d.date); cells.current.get(d.date)?.focus(); };
  const onKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    const at = days.findIndex((d) => d.date === focus); if (at < 0) return;
    const by: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (ev.key in by) { ev.preventDefault(); move(at + by[ev.key]); }
    else if (ev.key === "Home") { ev.preventDefault(); move(0); }
    else if (ev.key === "End") { ev.preventDefault(); move(days.length - 1); }
    else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setPicked(focus); }
  };
  const chosen = picked ? days.find((d) => d.date === picked) : null;
  return (
    <>
      <div className={css.calendar} style={{ "--weeks": weeks.length } as CSSProperties} role="grid" aria-label="Attendance this month" aria-describedby={detailId} onKeyDown={onKey}>
        <div role="row" className={css.week}>{WEEK.map((w) => <span key={w} className={css.weekday} role="columnheader">{w}</span>)}</div>
        {weeks.map((week, i) => <div role="row" className={css.week} key={i}>{week.map((d, j) => {
          if (!d) return <span key={`blank${j}`} role="gridcell" className={css.blank} />;
          const e = d.entry; const mark = e ? (e.mode === "wfh" ? "wfh" : e.mode === "field" ? "field" : "office") : d.status;
          const { label } = story(d, types);
          return (
            <div key={d.date} ref={(el) => { if (el) cells.current.set(d.date, el); else cells.current.delete(d.date); }} className={css.day} role="gridcell"
              tabIndex={d.date === focus ? 0 : -1} aria-selected={picked === d.date} aria-label={`${longDay(d.date)}${label ? `: ${label}` : ""}`}
              data-status={mark} data-work={d.workApproved ? "" : undefined} data-today={d.date === today ? "" : undefined} title={`${longDay(d.date)}${label ? `: ${label}` : ""}`}
              onClick={() => { setFocus(d.date); setPicked(d.date); }}>
              <span className={css.dayNo} aria-hidden="true">{Number(d.date.slice(8))}</span>
              {e ? <>
                <span className={css.dayMain} aria-hidden="true">{time(e.in)}<i>–</i><span className={css.dayOut}>{e.out && !e.missedOut ? time(e.out) : e.missedOut ? "?" : "…"}</span></span>
                <span className={css.dayTags} aria-hidden="true">
                  {e.mode !== "office" ? <em data-kind={e.mode}>{e.mode === "wfh" ? "Home" : "On duty"}</em> : null}
                  {e.late ? <em data-kind="late">Late</em> : null}
                  {e.missedOut ? <em data-kind="late">No check-out</em> : null}
                  {e.source === "regularised" ? <em>Corrected</em> : null}
                  {d.workApproved ? <em data-kind="work">Day-off work</em> : null}
                  {d.leave?.halfDay ? <em data-kind="leave">Half day</em> : null}
                </span>
              </> : <span className={css.dayNote} aria-hidden="true">{d.leave ? <>{leaveName(types, d.leave.kind)}{d.leave.halfDay ? " · half" : ""}</> : d.holiday ?? (d.status === "outcome" ? "Outcome-based" : d.status === "absent" ? "No check-in" : d.status === "off" ? "Off" : d.pendingLeave ? "Leave requested" : d.workApproved ? "Work approved" : "")}</span>}
            </div>
          );
        })}</div>)}
      </div>
      <p id={detailId} className={css.dayDetail} aria-live="polite">{chosen ? <><b>{longDay(chosen.date)}</b> {story(chosen, types).detail}</> : "Tap a day, or use the arrow keys and Enter, to see what happened that day."}</p>
    </>
  );
}
