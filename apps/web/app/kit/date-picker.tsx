"use client";
// TASKS-4A kit: the date picker. A button shows the day (and time); it opens quick choices (Today, Tomorrow, This
// Friday, Next Monday…) beside a month calendar. The calendar is a grid: ← → move a day, ↑ ↓ a week, PageUp/PageDown a
// month (Shift: a year), Home/End the week's start and end, Enter or Space chooses. An optional time (chips for the usual
// hours, or any time) rides along. Dates are plain "YYYY-MM-DD" days in the company's calendar; times "HH:MM" (24 h).
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { Popover } from "./popover";
import type { Placement } from "./layer";
import css from "./kit.module.css";

export type DateTime = { date: string | null; time: string | null };
const DAY = 86400000;
const D = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => iso(new Date(D(day).getTime() + n * DAY));
export const weekday = (day: string) => D(day).getUTCDay();
/** The next given weekday (0 = Sunday) after today; today itself only with `orToday`. */
export const nextWeekday = (today: string, wd: number, orToday = false) => addDays(today, ((wd - weekday(today) + 7) % 7) || (orToday ? 0 : 7));
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "Today", "Tomorrow", "Yesterday", "Fri 16 Oct" (with the year when it is not this year's). */
export function dayLabel(day: string, today?: string, plain?: boolean) {
  if (today && !plain) { if (day === today) return "Today"; if (day === addDays(today, 1)) return "Tomorrow"; if (day === addDays(today, -1)) return "Yesterday"; }
  const d = D(day); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}${today && day.slice(0, 4) !== today.slice(0, 4) ? ` ${day.slice(0, 4)}` : ""}`;
}
/** "5:30 pm", "9 am". */
export function timeLabel(t: string) { const [h, m] = t.split(":").map(Number); const h12 = h % 12 || 12; return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`; }
const spoken = (day: string) => { const d = D(day); return `${WD_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

export type QuickDate = { key: string; label: string; date: (today: string) => string | null };
export const QUICK_DATES: QuickDate[] = [
  { key: "today", label: "Today", date: (t) => t },
  { key: "tomorrow", label: "Tomorrow", date: (t) => addDays(t, 1) },
  { key: "friday", label: "This Friday", date: (t) => nextWeekday(t, 5, true) },
  { key: "monday", label: "Next Monday", date: (t) => nextWeekday(t, 1) },
  { key: "week", label: "In a week", date: (t) => addDays(t, 7) },
  { key: "fortnight", label: "In 2 weeks", date: (t) => addDays(t, 14) },
  { key: "month", label: "End of month", date: (t) => { const d = D(t); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); } },
];
const TIMES = ["10:00", "13:00", "17:00", "18:30"];

/** The calendar and quick choices, for a popover or inline. */
export function Calendar({ value, onChange, today, min, max, quick = QUICK_DATES, withTime, onDone, onClear, label = "Choose a date" }: { value: DateTime; onChange: (v: DateTime, how: "day" | "quick" | "time") => void;
  today: string; min?: string; max?: string; quick?: QuickDate[] | false; withTime?: boolean; onDone?: () => void; onClear?: () => void; label?: string }) {
  const [focus, setFocus] = useState(value.date ?? today);
  const [month, setMonth] = useState((value.date ?? today).slice(0, 7));
  const grid = useRef<HTMLTableElement>(null);
  const headId = useId();
  const moveTo = (day: string) => { setFocus(day); setMonth(day.slice(0, 7)); requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`[data-day="${day}"]`)?.focus()); };
  const weeks = useMemo(() => {
    const first = D(`${month}-01`), lead = (first.getUTCDay() + 6) % 7, start = addDays(iso(first), -lead);
    return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)));
  }, [month]);
  const blocked = (day: string) => (!!min && day < min) || (!!max && day > max);
  const choose = (day: string) => { if (!blocked(day)) onChange({ date: day, time: value.time }, "day"); };
  const keys = (e: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next: string | null = null;
    if (e.key in step) next = addDays(focus, step[e.key]);
    else if (e.key === "PageUp" || e.key === "PageDown") { const d = D(focus), n = (e.key === "PageUp" ? -1 : 1) * (e.shiftKey ? 12 : 1); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); next = iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d.getUTCDate(), last)))); }
    else if (e.key === "Home") next = addDays(focus, -((weekday(focus) + 6) % 7));
    else if (e.key === "End") next = addDays(focus, 6 - ((weekday(focus) + 6) % 7));
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(focus); return; }
    if (next) { e.preventDefault(); moveTo(next); }
  };
  const shift = (n: number) => { const d = D(`${month}-01`); setMonth(iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))).slice(0, 7)); };
  const [y, m] = month.split("-").map(Number);
  return <div className={css.dp} style={quick ? undefined : { gridTemplateColumns: "auto" }}>
    {quick ? <div className={css.dpQuick} role="group" aria-label="Quick dates">
      {quick.map((q) => { const day = q.date(today); return <button key={q.key} type="button" className={css.dpQuickItem} aria-pressed={!!day && value.date === day} disabled={!!day && blocked(day)}
        onClick={() => { if (day) { setMonth(day.slice(0, 7)); setFocus(day); } onChange({ date: day, time: day ? value.time : null }, "quick"); }}>{q.label}{day ? <small>{dayLabel(day, undefined, true).replace(/ \w+$/, "")}</small> : null}</button>; })}
      {onClear && value.date ? <button type="button" className={css.dpQuickItem} onClick={onClear}>No date</button> : null}
    </div> : null}
    <div className={css.dpCal}>
      <div className={css.dpHead}>
        <button type="button" className={css.dpNav} onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft size={16} aria-hidden="true" /></button>
        <span id={headId} className={css.dpMonth} aria-live="polite">{MONTHS[m - 1]} {y}</span>
        <button type="button" className={css.dpNav} onClick={() => shift(1)} aria-label="Next month"><ChevronRight size={16} aria-hidden="true" /></button>
      </div>
      <table ref={grid} role="grid" aria-labelledby={headId} aria-label={label} className={css.dpGrid} onKeyDown={keys}>
        <thead><tr>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => <th key={d} scope="col" abbr={WD_LONG[(i + 1) % 7]}>{d.slice(0, 2)}</th>)}</tr></thead>
        <tbody>{weeks.map((w) => <tr key={w[0]}>{w.map((day) => {
          const sel = value.date === day, outside = day.slice(0, 7) !== month, wd = weekday(day);
          return <td key={day} role="gridcell" aria-selected={sel}>
            <button type="button" className={css.dpDay} data-day={day} tabIndex={day === focus && !outside ? 0 : -1} aria-label={`${spoken(day)}${day === today ? ", today" : ""}`} aria-current={day === today ? "date" : undefined}
              aria-pressed={sel} data-outside={outside ? "" : undefined} data-weekend={wd === 0 ? "" : undefined} data-today={day === today ? "" : undefined} disabled={blocked(day)}
              onClick={() => { setFocus(day); choose(day); }}>{D(day).getUTCDate()}</button></td>;
        })}</tr>)}</tbody>
      </table>
      {withTime || onDone ? <div className={css.dpFoot}>
        {withTime ? <span className={css.dpTime} role="group" aria-label="Time">
          <Clock size={14} aria-hidden="true" style={{ color: "var(--theme-text-muted)" }} />
          <button type="button" className={css.dpTimeChip} aria-pressed={!value.time} onClick={() => onChange({ ...value, time: null }, "time")}>Any time</button>
          {TIMES.map((t) => <button key={t} type="button" className={css.dpTimeChip} aria-pressed={value.time === t} onClick={() => onChange({ date: value.date ?? today, time: t }, "time")}>{timeLabel(t)}</button>)}
          <input type="time" aria-label="Another time" value={value.time && !TIMES.includes(value.time) ? value.time : ""} onChange={(e) => onChange({ date: value.date ?? today, time: e.target.value || null }, "time")} step={900} />
        </span> : null}
        {onDone ? <span className={css.dpActions}>{onClear && value.date ? <button type="button" className={css.dpBtn} onClick={onClear}>Clear</button> : null}<button type="button" className={css.dpBtn} data-primary="" onClick={onDone}>Done</button></span> : null}
      </div> : null}
    </div>
  </div>;
}

/** A button that shows the chosen day (and time) and opens the calendar under it. */
export function DatePicker({ value, onChange, today, label = "Date", placeholder = "Pick a date", withTime, min, max, quick, variant = "field", size, icon, placement = "bottom-start", className, keepOpenOnDay, renderValue, highlight }: {
  value: DateTime; onChange: (v: DateTime) => void; today: string; label?: string; placeholder?: string; withTime?: boolean; min?: string; max?: string; quick?: QuickDate[] | false;
  variant?: "field" | "chip" | "ghost"; size?: "sm" | "md"; icon?: ReactNode; placement?: Placement; className?: string; keepOpenOnDay?: boolean; renderValue?: (v: DateTime) => ReactNode;
  /** Whether the button looks chosen (default: when there is a date); a form whose chips already show the day passes false. */ highlight?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState(value);
  const text = value.date ? (renderValue ? renderValue(value) : `${dayLabel(value.date, today)}${value.time ? ` · ${timeLabel(value.time)}` : ""}`) : null;
  const done = (v = draft) => { onChange(v); setOpen(false); anchor.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={anchor} type="button" className={`${css.trigger}${className ? ` ${className}` : ""}`} data-variant={variant} data-size={size} data-set={(highlight ?? !!value.date) ? "" : undefined}
      aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}: ${value.date ? `${spoken(value.date)}${value.time ? ` at ${timeLabel(value.time)}` : ""}` : "not set"}`} onClick={() => { if (!open) setDraft(value); setOpen(!open); }}>
      <span className={css.triggerValue}>{icon ?? <CalendarDays size={15} aria-hidden="true" />}<span className={text ? undefined : css.triggerPlaceholder}>{text ?? placeholder}</span></span>
      {variant === "field" ? <ChevronDown size={15} className={css.chev} aria-hidden="true" /> : null}
    </button>
    <Popover open={open} onClose={() => { if (draft.date !== value.date || draft.time !== value.time) onChange(draft); setOpen(false); }} anchor={anchor} label={label} placement={placement} focus="none" sheet>
      <CalendarFocus />
      <Calendar value={draft} today={today} min={min} max={max} quick={quick} withTime={withTime} label={label}
        onChange={(v, how) => { setDraft(v); if ((how === "day" || how === "quick") && !withTime && !keepOpenOnDay) done(v); }}
        onDone={withTime || keepOpenOnDay ? () => done() : undefined} onClear={() => done({ date: null, time: null })} />
    </Popover>
  </>;
}
/** Puts focus on the calendar's focusable day when the popover opens. */
function CalendarFocus() {
  const me = useRef<HTMLSpanElement>(null);
  useEffect(() => { const t = requestAnimationFrame(() => me.current?.parentElement?.querySelector<HTMLElement>('[role="grid"] button[tabindex="0"]')?.focus({ preventScroll: true })); return () => cancelAnimationFrame(t); }, []);
  return <span ref={me} hidden />;
}
