"use client";
// TASKS-P0: the board a person can read in five seconds. For one person it groups by when (Overdue · Today · This week
// · Later · No date) with status as a chip; a toggle brings back the status columns. Columns scroll on their own and
// window long lists; empty ones fold into a thin rail that still takes a drop. Cards: a priority edge, a countdown,
// the project's icon, the doer's photo, value, subtasks, proof and comments, a quiet tick and drag for the rest.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowRightLeft, Check, Hourglass, ListTree, MessageSquare, Paperclip, Sparkles, Unlock } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { Avatar, styles } from "../ui";
import { ByDevice } from "../kit";
import { FOCUS, focusGroup, nextUp, todaysFocus, urgency } from "../lib/task-sense.mjs";
import { AcceptDialog, celebrate } from "./client";
import { ProjectDot } from "./chips";
import { COLUMNS, STATUS } from "./parts";
import type { Board, Column, Same, Task } from "./types";
import { zoneDay } from "../lib/zone.mjs";
import { useOrgZone } from "../org-code";
import css from "./board.module.css";
import { armedClass, tickDone, tickProps, useArmedTask } from "./confirm-done";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const first = (name: string | null | undefined) => String(name ?? "").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
const FINISHED = ["done", "in_review", "accepted"];
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
type Group = "focus" | "status";
type Lane = { key: string; label: string; tone?: string; drop: boolean; hint: string; /** EST-1205: the hint on a touch screen. */ touch?: string; /** Folded into a rail until opened, even with cards. */ fold?: boolean };

/** The card: what, by when, for how much, and who; a tick to finish, drag (or the move menu) for the rest. */
export function TaskCard({ task: t, now, me, same, focus, dragging, busy, landed, onDone, onMove, onPointerDown, onKey }: {
  task: Task; now: number; me: string | null; same?: Same; focus: boolean; dragging?: boolean; busy?: boolean; landed?: boolean;
  onDone: (t: Task) => void; onMove: (t: Task, to: Column) => void; onPointerDown?: (e: ReactPointerEvent<HTMLLIElement>, t: Task) => void; onKey?: (e: KeyboardEvent, t: Task) => void;
}) {
  const u = urgency(t, now); const st = STATUS[t.status] ?? STATUS.unknown; const finished = FINISHED.includes(t.status);
  const unlocked = !!t.unlockedAt && now - Date.parse(t.unlockedAt) < 86400000 && !finished;
  const mine = !!me && t.assigneeId === me;
  const column = STATUS[t.status]?.column ?? "todo";
  const asking = useArmedTask() === t.id, tick = tickProps(t.title, asking);
  return <li className={css.card} tabIndex={0} data-task={t.id} data-priority={t.priority} data-unlocked={unlocked ? "" : undefined} data-dragging={dragging ? "" : undefined} data-busy={busy ? "" : undefined}
    data-landed={landed ? "" : undefined} onPointerDown={(e) => onPointerDown?.(e, t)} onKeyDown={(e) => onKey?.(e, t)}
    aria-label={`${t.title}. ${focus ? `${u.text}. ` : ""}${st.label}${t.assigneeName ? `, ${t.assigneeName}` : ""}. Arrow keys move it; Enter opens it.`}>
    <div className={css.top}>
      <button type="button" className={asking ? `${css.tick} ${armedClass}` : css.tick} data-done={finished ? "" : undefined} data-armed={asking ? "" : undefined} disabled={finished || busy || !me}
        onClick={(e) => { e.stopPropagation(); tickDone(t.id, t.title, () => onDone(t)); }}
        aria-label={finished ? `${t.title}: ${st.label}` : tick.label} title={finished ? st.label : tick.tip}><Check size={12} strokeWidth={3} /></button>
      <Link href={`/tasks/${t.id}`} className={css.title} draggable={false} title={t.title}>{t.title}</Link>
    </div>
    <div className={css.meta}>
      {!finished && u.key !== "none" ? <span className={css.due} data-tone={u.tone} title={u.text}>{u.short}</span> : null}
      {focus && t.status !== "open" && t.status !== "unknown" ? <span className={css.status} data-tone={st.tone}>{st.label}</span> : null}
      <ProjectDot name={t.projectName} color={t.projectColor} icon={t.projectIcon} />
      {t.subtasks ? <span title="Subtasks done"><ListTree size={12} aria-hidden="true" />{t.subtasksDone}/{t.subtasks}</span> : null}
      {t.proof ? <span title={`${t.proof} proof`}><Paperclip size={12} aria-hidden="true" />{t.proof}</span> : null}
      {t.comments ? <span title={`${t.comments} comments`}><MessageSquare size={12} aria-hidden="true" />{t.comments}</span> : null}
    </div>
    {unlocked || (t.waiting ?? 0) > 0 || same || t.openBlockers > 0 || t.assigneeName || !finished ? <div className={css.foot}>
      <span className={css.badges}>
        {unlocked ? <span className={css.badge} data-kind="unlocked" title="Everything it waited on is done"><Unlock size={11} aria-hidden="true" />Just unlocked</span> : null}
        {(t.waiting ?? 0) > 0 && !finished ? <span className={css.badge} data-kind="waiting" title="Open tasks wait on this one"><Hourglass size={11} aria-hidden="true" />{t.waiting} waiting on {mine ? "you" : first(t.assigneeName) || "this"}</span> : null}
        {t.openBlockers > 0 && !finished ? <span className={css.badge} data-kind="blocked">Waits on {t.openBlockers}</span> : null}
        {same ? <Link href={`/tasks/${t.id}`} className={css.badge} data-kind="same" title={`Looks like the same work as “${same.title}”`}>{same.linked ? "Same work" : "Duplicate?"}</Link> : null}
      </span>
      <span className={css.end}>
        {!finished ? <label className={css.move} title="Move"><ArrowRightLeft size={14} aria-hidden="true" />
          <select aria-label={`Move “${t.title}”`} value={column} onChange={(e) => onMove(t, e.target.value as Column)}>{COLUMNS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select></label> : null}
        {t.assigneeName ? <span title={t.assigneeName}><Avatar name={t.assigneeName} id={t.assigneeId ?? undefined} photoAt={t.assigneePhotoAt} size={24} /></span> : null}
      </span>
    </div> : null}
  </li>;
}

/** Long columns draw only the cards near the visible part (about 30 at a time); short ones draw everything. */
function Cards({ items, render, scroller }: { items: Task[]; render: (t: Task) => ReactNode; scroller: RefObject<HTMLDivElement | null> }) {
  const EST = 112, MANY = 40;
  const [view, setView] = useState({ top: 0, height: 900 });
  useEffect(() => {
    const el = scroller.current; if (!el || items.length <= MANY) return;
    const read = () => setView({ top: el.scrollTop, height: el.clientHeight || window.innerHeight });
    read(); el.addEventListener("scroll", read, { passive: true }); const ro = new ResizeObserver(read); ro.observe(el);
    return () => { el.removeEventListener("scroll", read); ro.disconnect(); };
  }, [scroller, items.length]);
  if (items.length <= MANY) return <ul className={css.cards}>{items.map(render)}</ul>;
  const start = Math.max(0, Math.floor(view.top / EST) - 8), end = Math.min(items.length, Math.ceil((view.top + view.height) / EST) + 8);
  return <ul className={css.cards} data-windowed="" style={{ paddingTop: start * EST, paddingBottom: (items.length - end) * EST }}>{items.slice(start, end).map(render)}</ul>;
}

function Lane({ lane, items, picked, over, dragging, render }: { lane: Lane; items: Task[]; picked: boolean; over: boolean; dragging: boolean; render: (t: Task) => ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null); const [opened, setOpened] = useState(false);
  const rail = (!items.length || lane.fold) && !picked && !opened && !(dragging && over);
  return <section className={`${css.column}${rail ? ` ${css.rail}` : ""}`} aria-label={lane.label} data-tone={lane.tone} data-picked={picked ? "" : undefined} data-over={over ? "" : undefined}
    data-lane={lane.drop ? lane.key : undefined} data-target={dragging && lane.drop ? "" : undefined}>
    <h3 className={css.head}><b>{lane.label}</b><span>{items.length}</span></h3>
    {rail ? <button type="button" className={css.railOpen} onClick={() => setOpened(true)} title={lane.hint}>{items.length ? "Show" : lane.drop ? "Drop here" : "Empty"}</button>
      : <div className={css.scroll} ref={scroller} data-scroll="">{items.length ? <Cards items={items} render={render} scroller={scroller} /> : <p className={css.empty}>{lane.touch ? <ByDevice keys={lane.hint} touch={lane.touch} /> : lane.hint}</p>}</div>}
  </section>;
}

/** The board. `group` is "focus" (by when) or "status" (the RT1 columns). */
export function BoardView({ board, group, now }: { board: Board; group: Group; now: number }) {
  const zone = useOrgZone();
  const router = useRouter();
  const [columns, setColumns] = useState(board.columns), [base, setBase] = useState(board);
  if (base !== board) { setBase(board); setColumns(board.columns); }
  const [over, setOver] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null), [accepting, setAccepting] = useState<Task | null>(null);
  // TASKS-3: drag with the pointer (mouse or pen): the card lifts and follows, the column under it lights up, long
  // columns and the board scroll at their edges, Escape puts it back; the card lands with a short glow. Phones keep the
  // Move menu, and the arrow keys move a focused card.
  const [drag, setDrag] = useState<{ id: string; w: number; dx: number; dy: number; x: number; y: number } | null>(null), [landed, setLanded] = useState<string | null>(null);
  const pending = useRef<{ id: string; x: number; y: number; rect: DOMRect } | null>(null), dragging = useRef<typeof drag>(null), ghost = useRef<HTMLDivElement>(null), overRef = useRef<string | null>(null);
  const dropRef = useRef<(id: string, lane: string) => void>(() => undefined), boardRef = useRef<HTMLDivElement>(null);
  const today = board.today ?? zoneDay(zone, now);
  const all = useMemo(() => COLUMNS.flatMap((c) => columns[c.key]), [columns]);
  const active = useMemo(() => all.filter((t) => !FINISHED.includes(t.status)), [all]);
  const lanes: Lane[] = group === "focus"
    ? [...FOCUS.map((g) => ({ key: g.key, label: g.label, tone: g.key === "overdue" ? "late" : g.key === "today" ? "now" : undefined, drop: g.key !== "overdue",
        hint: { overdue: "Nothing overdue.", today: "Nothing due today. Drop a card here to do it today.", week: "Nothing in the next seven days.", later: "Nothing later.", none: "Everything has a date." }[g.key] ?? "" })),
      { key: "done", label: "Done", drop: true, fold: true, hint: "Finished work waits here for its reviewer." }]
    : COLUMNS.map((c) => ({ key: c.key, label: c.label, drop: true, hint: c.hint, touch: c.touch }));
  const laneOf = useCallback((t: Task) => group === "focus" ? (FINISHED.includes(t.status) ? "done" : focusGroup(t, now)) : (STATUS[t.status]?.column ?? "todo"), [group, now]);
  const items = useMemo(() => {
    const out: Record<string, Task[]> = Object.fromEntries(lanes.map((l) => [l.key, []]));
    for (const t of all) out[laneOf(t)]?.push(t);
    if (group === "focus") for (const k of Object.keys(out)) if (k !== "done") out[k].sort((a, b) => (Date.parse(a.dueAt ?? "") || Infinity) - (Date.parse(b.dueAt ?? "") || Infinity) || ({ urgent: 0, high: 1, normal: 2, low: 3 }[a.priority] - { urgent: 0, high: 1, normal: 2, low: 3 }[b.priority]));
    return out;
  }, [all, lanes.length, laneOf, group]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picked, setPicked] = useState<string>(() => lanes.find((l) => items[l.key]?.length)?.key ?? lanes[0].key);

  const find = (id: string) => { for (const c of COLUMNS) { const t = columns[c.key].find((x) => x.id === id); if (t) return { task: t, from: c.key }; } return null; };
  const patch = (id: string, change: Partial<Task>, to?: Column) => {
    const hit = find(id); if (!hit) return columns;
    const next = { ...columns, [hit.from]: columns[hit.from].filter((t) => t.id !== id) };
    const dest = to ?? hit.from; next[dest] = [{ ...hit.task, ...change }, ...next[dest]];
    return next;
  };
  async function move(t: Task, to: Column) {
    const from = STATUS[t.status]?.column ?? "todo"; if (from === to) return;
    if (to === "accepted") { setAccepting(t); return; }
    const status = COLUMNS.find((c) => c.key === to)!.status; const before = columns;
    setColumns(patch(t.id, { status }, to)); setBusy(t.id);
    try { const r = await post<{ weekDone?: number; streak?: number; released?: number }>(`tasks/${t.id}/move`, { status }); if (status === "done") celebrate(r, t.title, nextUp(active, t.id)); router.refresh(); }
    catch (e) { setColumns(before); notify({ id: "board-move", tone: "error", title: "Not moved", message: msg(e) }); } finally { setBusy(null); }
  }
  /** Focus lanes change the due day: Today, in two days, in two weeks, or none. */
  async function redate(t: Task, lane: string) {
    if (laneOf(t) === lane) return;
    if (lane === "done") { void move(t, "done"); return; }
    const dueOn = lane === "today" ? today : lane === "week" ? addDays(today, 2) : lane === "later" ? addDays(today, 14) : null;
    const before = columns; setColumns(patch(t.id, { dueOn, dueAt: dueOn ? new Date(Date.parse(`${dueOn}T12:30:00Z`)).toISOString() : null })); setBusy(t.id);
    try { await post(`tasks/${t.id}`, { dueOn }); notify({ id: "board-move", tone: "success", title: dueOn ? `Due ${lane === "today" ? "today" : dueOn}` : "No due date", message: t.title, timeout: 2200 }); router.refresh(); }
    catch (e) { setColumns(before); notify({ id: "board-move", tone: "error", title: "Not moved", message: msg(e) }); } finally { setBusy(null); }
  }
  useEffect(() => { dropRef.current = (id: string, lane: string) => { const hit = find(id); if (!hit) return; setLanded(id); setTimeout(() => setLanded((x) => x === id ? null : x), 900);
    if (group === "focus") void redate(hit.task, lane); else void move(hit.task, lane as Column); }; });
  useEffect(() => {
    const laneAt = (x: number, y: number) => { for (const el of document.elementsFromPoint(x, y)) { const lane = (el as HTMLElement).closest?.("[data-lane]") as HTMLElement | null; if (lane) return lane; } return null; };
    const end = () => { pending.current = null; dragging.current = null; overRef.current = null; setDrag(null); setOver(null); document.documentElement.classList.remove(css.draggingPage); };
    const move = (e: PointerEvent) => {
      const p = pending.current; if (!p) return;
      if (!dragging.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
        dragging.current = { id: p.id, w: p.rect.width, dx: p.x - p.rect.left, dy: p.y - p.rect.top, x: e.clientX, y: e.clientY };
        setDrag(dragging.current); document.documentElement.classList.add(css.draggingPage);
      }
      const d = dragging.current; d.x = e.clientX; d.y = e.clientY;
      if (ghost.current) ghost.current.style.transform = `translate(${e.clientX - d.dx}px, ${e.clientY - d.dy}px) rotate(1.2deg)`;
      const lane = laneAt(e.clientX, e.clientY), key = lane?.dataset.lane ?? null;
      if (key !== overRef.current) { overRef.current = key; setOver(key); }
      // Scroll a long column, or the board itself, when the card nears an edge.
      const list = lane?.querySelector<HTMLElement>("[data-scroll]");
      if (list) { const r = list.getBoundingClientRect(); if (e.clientY > r.bottom - 48) list.scrollTop += 14; else if (e.clientY < r.top + 48) list.scrollTop -= 14; }
      const b = boardRef.current; if (b) { const r = b.getBoundingClientRect(); if (e.clientX > r.right - 56) b.scrollLeft += 16; else if (e.clientX < r.left + 56) b.scrollLeft -= 16; }
    };
    const up = (e: PointerEvent) => {
      const d = dragging.current, p = pending.current;
      if (d && p) {
        const key = laneAt(e.clientX, e.clientY)?.dataset.lane;
        if (key) dropRef.current(d.id, key);
        // The click that ends a drag must not open the card's link.
        const swallow = (c: MouseEvent) => { c.preventDefault(); c.stopPropagation(); };
        document.addEventListener("click", swallow, { capture: true, once: true }); setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 50);
      }
      end();
    };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && dragging.current) { e.preventDefault(); end(); } };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up); document.addEventListener("pointercancel", end); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", end); document.removeEventListener("keydown", key); };
  }, []);
  const lift = (e: ReactPointerEvent<HTMLLIElement>, t: Task) => {
    if (e.button !== 0 || e.pointerType === "touch" || busy) return;
    if ((e.target as HTMLElement).closest("button,select,input,textarea,label")) return;
    pending.current = { id: t.id, x: e.clientX, y: e.clientY, rect: e.currentTarget.getBoundingClientRect() };
  };
  const key = (e: KeyboardEvent, t: Task) => {
    if (e.target !== e.currentTarget) return;
    const order = lanes.filter((l) => l.drop || l.key === laneOf(t)).map((l) => l.key); const i = order.indexOf(laneOf(t));
    const go = e.key === "ArrowRight" ? order[i + 1] : e.key === "ArrowLeft" ? order[i - 1] : null;
    if (go) { e.preventDefault(); if (group === "focus") void redate(t, go); else void move(t, go as Column); }
    if (e.key === "Enter") router.push(`/tasks/${t.id}`);
  };
  const render = (t: Task) => <TaskCard key={t.id} task={t} now={now} me={board.me} same={board.same?.[t.id]} focus={group === "focus"} dragging={drag?.id === t.id} busy={busy === t.id}
    landed={landed === t.id} onDone={(x) => move(x, "done")} onMove={move} onKey={key} onPointerDown={lift} />;
  const lifted = drag ? all.find((t) => t.id === drag.id) ?? null : null;
  return <>
    <div className={`${styles.segmented} ${css.pick}`} role="group" aria-label="Column">{lanes.map((l) =>
      <button key={l.key} type="button" className={styles.segment} aria-pressed={picked === l.key} onClick={() => setPicked(l.key)}>{l.label}<span className={styles.muted}>{items[l.key]?.length ?? 0}</span></button>)}</div>
    <div ref={boardRef} className={css.board} data-dragging={drag ? "" : undefined} aria-label={`${group === "focus" ? "Board by when it is due" : "Board by status"}. Drag a card, or focus it and use the arrow keys.`}>
      {lanes.map((l) => <Lane key={l.key} lane={l} items={items[l.key] ?? []} picked={picked === l.key} over={over === l.key} dragging={!!drag} render={render} />)}
    </div>
    {drag && lifted && typeof document !== "undefined" ? createPortal(<div ref={ghost} className={css.ghost} aria-hidden="true" style={{ width: drag.w, transform: `translate(${drag.x - drag.dx}px, ${drag.y - drag.dy}px) rotate(1.2deg)` }}>
      <ul className={css.cards}><TaskCard task={lifted} now={now} me={board.me} same={board.same?.[lifted.id]} focus={group === "focus"} onDone={() => undefined} onMove={() => undefined} /></ul></div>, document.body) : null}
    {accepting ? <AcceptDialog task={accepting} onClose={() => setAccepting(null)} /> : null}
  </>;
}

/** Whose board: everyone the viewer may see, the viewer first. */
export function PersonSwitch({ people, current, me }: { people: { id: string; name: string }[]; current: string | null; me: string | null }) {
  const router = useRouter();
  return <select className={css.switch} aria-label="Whose work" value={current ?? ""} onChange={(e) => router.push(e.target.value === me || !e.target.value ? "/tasks?view=board&scope=mine" : `/tasks?view=board&scope=person&person=${e.target.value}`)}>
    {me ? <option value={me}>My work</option> : null}
    {people.filter((p) => p.id !== me).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
  </select>;
}

/** A ring that fills as the day (or the week) gets done. */
function Ring({ done, total, label }: { done: number; total: number; label: string }) {
  const r = 17, c = 2 * Math.PI * r, part = total ? Math.min(1, done / total) : 0;
  return <div className={css.ring} role="img" aria-label={`${label}: ${done} of ${total} done`}>
    <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true"><circle className={css.track} cx="22" cy="22" r={r} /><circle className={css.fill} cx="22" cy="22" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - part)} transform="rotate(-90 22 22)" /></svg>
    <span><b>{done}/{total || 0}</b><small>{label}</small></span>
  </div>;
}

/** Today's focus: the three tasks to do first (by urgency), and how the day and week are going. Gentle: no
 *  red counts, no comparison with anyone. */
export function TodaysFocus({ tasks, now, whose }: { tasks: Task[]; now: number; whose: string | null }) {
  const zone = useOrgZone(), today = zoneDay(zone, now);
  const weekStart = (() => { const d = new Date(`${today}T00:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; return addDays(today, -dow); })();
  const dayOf = (iso: string | null) => iso ? zoneDay(zone, iso) : null;
  const doneDay = tasks.filter((t) => FINISHED.includes(t.status) && dayOf(t.doneAt) === today).length;
  const dueDay = tasks.filter((t) => !FINISHED.includes(t.status) && t.status !== "cancelled" && (t.dueOn ?? "9999") <= today).length;
  const doneWeek = tasks.filter((t) => FINISHED.includes(t.status) && (dayOf(t.doneAt) ?? "") >= weekStart).length;
  const dueWeek = tasks.filter((t) => !FINISHED.includes(t.status) && t.status !== "cancelled" && (t.dueOn ?? "9999") <= addDays(weekStart, 6)).length;
  const top = todaysFocus(tasks, now);
  if (!top.length && !doneWeek) return null;
  return <section className={css.focus} aria-label="Up next">
    <div>
      <h3 className={css.focusHead}><Sparkles size={14} aria-hidden="true" />Up next<small>{whose ? `for ${whose}: ` : ""}most urgent first</small></h3>
      {top.length ? <ol className={css.focusList}>{top.map((t, i) => { const u = urgency(t, now); return <li key={t.id}>
        <Link className={css.focusCard} href={`/tasks/${t.id}`} data-priority={t.priority}>
          <span className={css.focusN}>{i === 0 ? "First" : i === 1 ? "Then" : "After that"}</span><b title={t.title}>{t.title}</b>
          <span className={css.meta}>{u.key !== "none" ? <span className={css.due} data-tone={u.tone}>{u.short}</span> : null}{(t.waiting ?? 0) > 0 ? <span><Hourglass size={12} aria-hidden="true" />{t.waiting} waiting</span> : null}</span>
        </Link></li>; })}</ol> : <p className={css.empty}>Nothing open that can move right now.</p>}
    </div>
    {doneWeek + dueWeek > 0 ? <div className={css.rings}><Ring done={doneDay} total={doneDay + dueDay} label="today" /><Ring done={doneWeek} total={doneWeek + dueWeek} label="this week" /></div> : null}
  </section>;
}

