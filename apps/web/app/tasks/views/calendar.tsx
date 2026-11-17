"use client";
// TASKS-4A views: Calendar. A month of due dates. Drag a task to another day to move it (or focus it and press Alt with
// an arrow key: a day either way, a week up or down); tasks without a date wait in a tray beside the month and can be
// dragged onto a day. On a phone the month becomes an agenda, day by day.
import { RowLink } from "../../kit/row-link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { Tooltip, addDays, dayLabel } from "../../kit";
import type { Task } from "../types";
import { isFinished } from "./model";
import css from "./views.module.css";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

/** PROJECTS-FIX (owner, 10 Nov 2026: "Calendar shows nothing" on a project with tasks): the month to open on is this
 *  month when anything is due in it, else the month of the next open task, else the last month that holds a task. */
export function startMonth(rows: Pick<Task, "dueOn" | "status">[], today: string) {
  const now = today.slice(0, 7), dated = rows.filter((t) => t.dueOn).map((t) => ({ m: t.dueOn!.slice(0, 7), d: t.dueOn!, open: !isFinished(t) }));
  if (!dated.length || dated.some((x) => x.m === now)) return now;
  const next = dated.filter((x) => x.open && x.d >= today).sort((a, b) => a.d.localeCompare(b.d))[0];
  return next ? next.m : dated.map((x) => x.m).sort().at(-1)!;
}

export function CalendarView({ rows, today, me }: { rows: Task[]; today: string; me: string | null }) {
  const router = useRouter();
  const [month, setMonth] = useState(() => startMonth(rows, today));
  const [moved, setMoved] = useState<Record<string, string | null>>({});
  const [over, setOver] = useState<string | null>(null), [openDay, setOpenDay] = useState<string | null>(null), [allUndated, setAllUndated] = useState(false);
  const dueOf = (t: Task) => (t.id in moved ? moved[t.id] : t.dueOn) ?? null;
  const byDay = useMemo(() => { const m = new Map<string, Task[]>(); for (const t of rows) { const d = t.id in moved ? moved[t.id] : t.dueOn; if (d) m.set(d, [...(m.get(d) ?? []), t]); } return m; }, [rows, moved]);
  // Every task is somewhere: on its day, or (with no day) in the tray, finished ones too, open ones first.
  const undated = rows.filter((t) => !dueOf(t)).sort((a, b) => Number(isFinished(a)) - Number(isFinished(b)));
  // The months other than this one that hold tasks, to jump to (a project's work is often a few months apart).
  const months = [...byDay.entries()].reduce((m, [d, items]) => m.set(d.slice(0, 7), (m.get(d.slice(0, 7)) ?? 0) + items.length), new Map<string, number>());
  const elsewhere = [...months.entries()].filter(([m]) => m !== month).sort(([a], [b]) => a.localeCompare(b));
  // PROJECTS-FIX (judges: "the No due date list is longer than the calendar"): the first few, then Show all.
  // Open work first: the count above is the open tasks, "Show N more" the rest of them (finished ones come with it).
  const openUndated = undated.filter((t) => !isFinished(t));
  const FEW = 5, trayItems = allUndated ? undated : openUndated.slice(0, FEW), agendaItems = allUndated ? undated : openUndated.slice(0, 3);
  const moreWords = (n: number) => openUndated.length > n ? `Show ${openUndated.length - n} more` : `Show ${undated.length - Math.min(n, openUndated.length)} done`;
  const showAll = undated.length > trayItems.length || allUndated ? <button type="button" className={css.more} onClick={() => setAllUndated((v) => !v)}>{allUndated ? "Show fewer" : moreWords(FEW)}</button> : null;
  const monthWord = (m: string) => `${MONTHS[Number(m.slice(5)) - 1].slice(0, 3)}${m.slice(0, 4) !== today.slice(0, 4) ? ` ’${m.slice(2, 4)}` : ""}`;
  const first = new Date(`${month}-01T00:00:00Z`), lead = (first.getUTCDay() + 6) % 7, start = addDays(`${month}-01`, -lead);
  const allWeeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d))).filter((w, i) => i < 5 || w[0].slice(0, 7) === month);
  // PROJECTS-FIX (judges: "the first weeks shown are empty past days"): this month starts at its first week that is not
  // both over and empty.
  let skip = 0; if (month === today.slice(0, 7)) while (skip < allWeeks.length - 1 && allWeeks[skip][6] < today && allWeeks[skip].every((d) => !byDay.get(d)?.length)) skip++;
  const weeks = allWeeks.slice(skip);
  const shift = (n: number) => { const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + n, 1)); setMonth(d.toISOString().slice(0, 7)); };
  async function move(t: Task, day: string | null) {
    if (dueOf(t) === day) return;
    setMoved((m) => ({ ...m, [t.id]: day }));
    try { await post(`tasks/${t.id}`, { dueOn: day }); notify({ id: "cal-move", tone: "success", title: day ? `Due ${dayLabel(day, today)}` : "No due date", message: t.title, timeout: 2600 }); router.refresh(); }
    catch (e) { setMoved((m) => { const n = { ...m }; delete n[t.id]; return n; }); notify({ id: "cal-move", tone: "error", title: "Not moved", message: msg(e) }); }
  }
  const drop = (day: string | null) => (e: DragEvent) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/x-pulse-task"); const t = rows.find((x) => x.id === id); if (t) void move(t, day); };
  const keys = (e: KeyboardEvent, t: Task) => {
    if (!e.altKey) return; const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]; if (step === undefined) return;
    e.preventDefault(); const next = addDays(dueOf(t) ?? today, step); void move(t, next); if (next.slice(0, 7) !== month) setMonth(next.slice(0, 7));
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-cal-task="${t.id}"]`)?.focus());
  };
  const chip = (t: Task) => <li key={t.id}><RowLink href={`/tasks/${t.id}`} className={css.calTask} data-cal-task={t.id} data-priority={t.priority} data-done={isFinished(t) ? "" : undefined} data-late={!isFinished(t) && !!t.dueOn && t.dueOn < today ? "" : undefined} draggable={!!me && !isFinished(t)}
    onDragStart={(e: DragEvent<HTMLAnchorElement>) => { e.dataTransfer.setData("text/x-pulse-task", t.id); e.dataTransfer.effectAllowed = "move"; }} onKeyDown={(e: KeyboardEvent<HTMLAnchorElement>) => keys(e, t)} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
    title={`${t.title}${t.assigneeName ? ` · ${t.assigneeName}` : ""}`}>
    <span>{t.title}</span></RowLink></li>;
  const target = (day: string | null) => ({ onDragOver: (e: DragEvent) => { if (!me) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(day ?? "none"); }, onDragLeave: () => setOver((o) => o === (day ?? "none") ? null : o), onDrop: drop(day) });
  const agendaDays = [...byDay.keys()].filter((d) => d.slice(0, 7) === month).sort();
  return <div className={css.cal}>
    <div className={css.calHead}>
      <button type="button" className={css.navBtn} onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft size={16} aria-hidden="true" /></button>
      <h3 aria-live="polite">{MONTHS[first.getUTCMonth()]} {first.getUTCFullYear()}</h3>
      <button type="button" className={css.navBtn} onClick={() => shift(1)} aria-label="Next month"><ChevronRight size={16} aria-hidden="true" /></button>
      <button type="button" className={css.todayBtn} onClick={() => setMonth(today.slice(0, 7))} disabled={month === today.slice(0, 7)}>Today</button>
      <Tooltip content="Drag a task to another day, or focus it and press Alt with an arrow key"><span className={css.calHint}>Drag to move</span></Tooltip>
    </div>
    {elsewhere.length ? <p className={css.calElse} aria-label="Tasks in other months"><span>Also due in</span>{elsewhere.map(([m, n]) =>
      <button key={m} type="button" onClick={() => setMonth(m)} aria-label={`${monthWord(m)}: ${n} task${n === 1 ? "" : "s"}`}>{monthWord(m)}<small>{n}</small></button>)}</p> : null}
    <div className={css.calBody}>
      <div className={css.monthCol}>{skip ? <p className={css.calSkip}>Nothing was due earlier in {MONTHS[first.getUTCMonth()]}.</p> : null}
      <div className={css.month} role="table" aria-label={`${MONTHS[first.getUTCMonth()]} ${first.getUTCFullYear()}`}>
        <div className={css.weekRow} role="row">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span key={d} role="columnheader" className={css.wd}>{d}</span>)}</div>
        {weeks.map((w) => <div key={w[0]} className={css.weekRow} role="row">{w.map((day) => {
          const items = byDay.get(day) ?? [], shown = openDay === day ? items : items.slice(0, 3);
          return <div key={day} role="cell" className={css.day} data-outside={day.slice(0, 7) !== month ? "" : undefined} data-today={day === today ? "" : undefined} data-over={over === day ? "" : undefined}
            data-past={day < today ? "" : undefined} aria-label={`${dayLabel(day, undefined, true)}: ${items.length} task${items.length === 1 ? "" : "s"}`} {...target(day)}>
            <span className={css.dayNum}>{Number(day.slice(8))}</span>
            {items.length ? <ul className={css.dayTasks}>{shown.map(chip)}</ul> : null}
            {items.length > 3 ? <button type="button" className={css.more} onClick={() => setOpenDay(openDay === day ? null : day)}>{openDay === day ? "Less" : `+${items.length - 3} more`}</button> : null}
          </div>;
        })}</div>)}
      </div>
      </div>
      {undated.length || over ? <aside className={css.tray} aria-label="No due date" data-over={over === "none" ? "" : undefined} {...target(null)}>
        <h4><Inbox size={14} aria-hidden="true" />No due date<span className={css.count}>{undated.filter((t) => !isFinished(t)).length}</span></h4>
        {undated.length ? <><ul className={css.dayTasks}>{trayItems.map(chip)}</ul>{showAll}</> : <p className={css.muted}>Everything has a day.</p>}
      </aside> : null}
    </div>
    <div className={css.agenda} aria-label="Agenda">
      {agendaDays.length ? agendaDays.map((d) => <section key={d} aria-label={dayLabel(d, today)} data-today={d === today ? "" : undefined}>
        <h4>{dayLabel(d, today)}</h4><ul className={css.dayTasks}>{(byDay.get(d) ?? []).map(chip)}</ul></section>)
        : <p className={css.muted}>Nothing is due in {MONTHS[first.getUTCMonth()]}.</p>}
      {/* On a phone the tray is part of the agenda. */}
      {undated.length ? <section aria-label="No due date" data-undated=""><h4><Inbox size={14} aria-hidden="true" />No due date<span className={css.count}>{undated.filter((t) => !isFinished(t)).length}</span></h4>
        <ul className={css.dayTasks}>{agendaItems.map(chip)}</ul>{undated.length > agendaItems.length || allUndated ? <button type="button" className={css.more} onClick={() => setAllUndated((v) => !v)}>{allUndated ? "Show fewer" : moreWords(3)}</button> : null}</section> : null}
    </div>
  </div>;
}
