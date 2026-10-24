"use client";
// TASKS-4A views: Calendar. A month of due dates. Drag a task to another day to move it (or focus it and press Alt with
// an arrow key: a day either way, a week up or down); tasks without a date wait in a tray beside the month and can be
// dragged onto a day. On a phone the month becomes an agenda, day by day.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { Avatar } from "../../ui";
import { Tooltip, addDays, dayLabel } from "../../kit";
import type { Task } from "../types";
import { isFinished } from "./model";
import css from "./views.module.css";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

export function CalendarView({ rows, today, me }: { rows: Task[]; today: string; me: string | null }) {
  const router = useRouter();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [moved, setMoved] = useState<Record<string, string | null>>({});
  const [over, setOver] = useState<string | null>(null), [openDay, setOpenDay] = useState<string | null>(null);
  const dueOf = (t: Task) => (t.id in moved ? moved[t.id] : t.dueOn) ?? null;
  const byDay = useMemo(() => { const m = new Map<string, Task[]>(); for (const t of rows) { const d = t.id in moved ? moved[t.id] : t.dueOn; if (d) m.set(d, [...(m.get(d) ?? []), t]); } return m; }, [rows, moved]);
  const undated = rows.filter((t) => !dueOf(t) && !isFinished(t));
  const first = new Date(`${month}-01T00:00:00Z`), lead = (first.getUTCDay() + 6) % 7, start = addDays(`${month}-01`, -lead);
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d))).filter((w, i) => i < 5 || w[0].slice(0, 7) === month);
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
  const chip = (t: Task) => <li key={t.id}><Link href={`/tasks/${t.id}`} className={css.calTask} data-cal-task={t.id} data-priority={t.priority} data-done={isFinished(t) ? "" : undefined} draggable={!!me && !isFinished(t)}
    onDragStart={(e: DragEvent<HTMLAnchorElement>) => { e.dataTransfer.setData("text/x-pulse-task", t.id); e.dataTransfer.effectAllowed = "move"; }} onKeyDown={(e: KeyboardEvent<HTMLAnchorElement>) => keys(e, t)} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
    title={`${t.title}${t.assigneeName ? ` · ${t.assigneeName}` : ""}`}>
    {t.assigneeName ? <Avatar name={t.assigneeName} id={t.assigneeId ?? undefined} photoAt={t.assigneePhotoAt} size={16} /> : null}<span>{t.title}</span></Link></li>;
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
    <div className={css.calBody}>
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
      <aside className={css.tray} aria-label="No due date" data-over={over === "none" ? "" : undefined} {...target(null)}>
        <h4><Inbox size={14} aria-hidden="true" />No due date<span className={css.count}>{undated.length}</span></h4>
        {undated.length ? <ul className={css.dayTasks}>{undated.slice(0, 60).map(chip)}</ul> : <p className={css.muted}>Everything open has a day.</p>}
      </aside>
    </div>
    <div className={css.agenda} aria-label="Agenda">
      {agendaDays.length ? agendaDays.map((d) => <section key={d} aria-label={dayLabel(d, today)} data-today={d === today ? "" : undefined}>
        <h4>{dayLabel(d, today)}</h4><ul className={css.dayTasks}>{(byDay.get(d) ?? []).map(chip)}</ul></section>)
        : <p className={css.muted}>Nothing is due in {MONTHS[first.getUTCMonth()]}.</p>}
    </div>
  </div>;
}
