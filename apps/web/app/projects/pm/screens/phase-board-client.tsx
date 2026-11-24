"use client";
// PM-UI 03 Phase board, interactive part: the List | Board | Timeline switch, the phone's status tabs, pointer drag
// between columns (a status change under the same rules as the buttons, SPEC §4 + §5.3; `canMove` is pure and exported
// for tests) and the collapsible phase groups of "List by phase". Local state only; `onMove` wires the real mutation.
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { CalendarDays, ChartGantt, ChevronRight, CircleAlert, Columns3, List, X } from "lucide-react";
import type { BoardColumnKey, PhaseGroup } from "../contract/phase-board";
import type { HueKey, IsoDate, LateFlag, StepRow, StepStatus, Viewer } from "../contract/shared";
import { PersonLine, RoundTag, StepState, daysBetween, firstName, fmtDayShort, fmtRange, hued, nDays } from "../kit";
import css from "./phase-board.module.css";

/* ---------- Rules (pure) ---------- */

/** The five columns in order, with the words of their empty state. */
export const COLUMNS: { key: BoardColumnKey; title: string; empty: string }[] = [
  { key: "todo", title: "To do", empty: "Nothing to start" },
  { key: "doing", title: "Doing", empty: "Nothing in progress" },
  { key: "in_review", title: "In review", empty: "Nothing in review" },
  { key: "waiting_client", title: "Waiting on client", empty: "Nothing with the client" },
  { key: "done", title: "Done", empty: "Nothing done yet" },
];

/** The column a step sits in: blocked steps wait in To do, "Changes asked" is back in Doing, skipped sits with Done. */
export function columnOf(status: StepStatus): BoardColumnKey {
  switch (status) {
    case "blocked": case "todo": return "todo";
    case "doing": case "changes": return "doing";
    case "in_review": return "in_review";
    case "waiting_client": return "waiting_client";
    case "done": case "skipped": return "done";
  }
}

export type MoveCheck = { ok: true } | { ok: false; reason: string };
type MovableStep = Pick<StepRow, "status" | "owner" | "reviewer" | "toReview" | "needsClientApproval" | "blockedBy">;

/** May `viewer` drag `step` from one column to another? The same rules as the step's buttons (SPEC §4, §3.1, §6):
 *  - the owner (assignee) or the lead / an admin moves a step; nobody else;
 *  - a blocked step moves when what it waits on is done;
 *  - only the client's OK finishes a step that waits on the client; only the lead takes it back;
 *  - only the lead reopens a done step;
 *  - a step that needs an approval is done when the approval is given (the lead may still mark it done);
 *  - only a step that needs the client's approval goes to "Waiting on client".
 *  Refusals are plain words for the person who tried. */
export function canMove(step: MovableStep, from: BoardColumnKey, to: BoardColumnKey, viewer: Viewer): MoveCheck {
  if (from === to) return { ok: true };
  const no = (reason: string): MoveCheck => ({ ok: false, reason });
  if (viewer.orgRole === "client") return no("Clients answer from their own page.");
  const lead = viewer.isLead || viewer.orgRole === "owner" || viewer.orgRole === "admin";
  const mine = !!step.owner && step.owner.id === viewer.person.id;
  if (!lead && !mine) return no(step.owner ? `Only ${firstName(step.owner)} or the lead can move this step.` : "Only the lead can move this step.");
  if (step.status === "blocked") return no(step.blockedBy ? `This step waits on “${step.blockedBy}” first.` : "This step waits on another step first.");
  if (from === "done") return lead ? { ok: true } : no("Only the lead can reopen a done step.");
  if (from === "waiting_client") {
    if (to === "done") return no("The client approves this step from their page.");
    return lead ? { ok: true } : no("Only the lead can take a step back from the client.");
  }
  if (to === "waiting_client" && !step.needsClientApproval) return no("This step does not go to the client.");
  if (to === "done" && !lead && (step.needsClientApproval || step.reviewer)) return no("This step is done when its approval is given.");
  return { ok: true };
}

const STATUS_OF: Record<BoardColumnKey, StepStatus> = { todo: "todo", doing: "doing", in_review: "in_review", waiting_client: "waiting_client", done: "done" };

/** The step after a move: its new status and its late flag again (done steps carry none; with the client it is amber). */
export function moved(step: StepRow, to: BoardColumnKey, today: IsoDate): StepRow {
  const next: StepRow = { ...step, status: STATUS_OF[to] };
  delete next.late;
  const days = step.due ? daysBetween(step.due, today) : 0;
  if (to !== "done" && days > 0) next.late = { days, who: to === "waiting_client" ? "client" : "team" };
  return next;
}

/* ---------- Pieces ---------- */

function Flag({ late }: { late: LateFlag }) {
  return <span className={css.flag} data-who={late.who}><CircleAlert aria-hidden="true" /><span>{late.who === "client" ? "Client late" : "Late"}</span><span>· {nDays(late.days)}</span></span>;
}

export type PhaseLineData = {
  name: string; clock: string; hue: HueKey; /** "Phase 3 of 9: Shoot" for screen readers. */ label: string;
  dots: { id: string; state: "done" | "current" | "late" | "later" }[];
};

function PhaseLine({ p }: { p: PhaseLineData }) {
  return <div className={css.phaseLine}>
    <p className={css.phaseText}><strong>{p.name}</strong><span aria-hidden="true"> · </span><span>{p.clock}</span></p>
    <span {...hued(p.hue, css.dots)} role="img" aria-label={p.label}>
      {p.dots.map((d) => <i key={d.id} data-state={d.state} />)}
    </span>
  </div>;
}

type Drag = { id: string; from: BoardColumnKey; dx: number; dy: number; over: BoardColumnKey | null };

export function BoardViews({ view: view0, tab: tab0, steps: steps0, groups, viewer, today, notice: notice0, hrefs, stepHrefBase, phaseLine, onMove }: {
  view: "list" | "board"; tab: BoardColumnKey; steps: StepRow[]; groups: PhaseGroup[]; viewer: Viewer; today: IsoDate;
  notice: { stepId: string; text: string } | null; hrefs: { list: string; board: string; timeline: string }; stepHrefBase: string;
  /** The phase line (name · clock line · one dot per phase in the project's colour), beside the switch on a laptop. */
  phaseLine: PhaseLineData;
  /** Called after an allowed move (the real status mutation). */ onMove?: (stepId: string, to: BoardColumnKey) => void;
}) {
  const [view, setView] = useState(view0);
  const [tab, setTab] = useState(tab0);
  const [steps, setSteps] = useState(steps0);
  const [notice, setNotice] = useState(notice0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(groups.map((g) => [g.phase.id, g.open])));
  const start = useRef<{ id: string; from: BoardColumnKey; x: number; y: number; active: boolean } | null>(null);
  const justDragged = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  // Phone: keep the open status tab in view inside its own sideways-scrolling row (never the page).
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = tabsRef.current;
    const el = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row || !el || row.scrollWidth <= row.clientWidth) return;
    const left = el.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft, right = left + el.offsetWidth;
    if (left < row.scrollLeft) row.scrollLeft = left;
    else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth + 16;
  }, [tab, view]);

  const href = (id: string) => `${stepHrefBase}${id}`;
  const byCol = (k: BoardColumnKey) => steps.filter((s) => columnOf(s.status) === k);

  function finish(id: string, from: BoardColumnKey, to: BoardColumnKey | null) {
    setDrag(null);
    if (!to || to === from) return;
    const step = steps.find((s) => s.id === id);
    if (!step) return;
    const check = canMove(step, from, to, viewer);
    if (!check.ok) { setNotice({ stepId: id, text: check.reason }); return; }
    setNotice(null);
    setSteps((all) => all.map((s) => (s.id === id ? moved(s, to, today) : s)));
    onMove?.(id, to);
  }

  function onPointerDown(e: ReactPointerEvent<HTMLElement>, step: StepRow) {
    // Mouse and pen drag; on touch the page scrolls and the step's own buttons move it.
    if (e.button !== 0 || e.pointerType === "touch") return;
    const from = columnOf(step.status);
    start.current = { id: step.id, from, x: e.clientX, y: e.clientY, active: false };
    const colAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-col]")?.dataset.col as BoardColumnKey | undefined) ?? null;
    const move = (ev: PointerEvent) => {
      const st = start.current;
      if (!st) return;
      const dx = ev.clientX - st.x, dy = ev.clientY - st.y;
      if (!st.active && Math.hypot(dx, dy) < 6) return;
      st.active = true;
      ev.preventDefault();
      setDrag({ id: st.id, from: st.from, dx, dy, over: colAt(ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      const st = start.current;
      stop();
      if (!st?.active) return;
      justDragged.current = true;
      finish(st.id, st.from, ev.type === "pointercancel" ? null : colAt(ev.clientX, ev.clientY));
    };
    const stop = () => {
      start.current = null;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      cleanup.current = null;
    };
    cleanup.current?.();
    cleanup.current = stop;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  }

  const card = (s: StepRow, col: BoardColumnKey) => {
    const dragging = drag?.id === s.id;
    const style: CSSProperties | undefined = drag && dragging ? { transform: `translate(${drag.dx}px, ${drag.dy}px) rotate(1deg)` } : undefined;
    const late = s.late && s.status !== "done" && s.status !== "skipped" ? s.late : undefined;
    return <li key={s.id} className={css.card} data-dragging={dragging ? "" : undefined} data-refused={notice?.stepId === s.id ? "" : undefined} style={style}
      onPointerDown={(e) => onPointerDown(e, s)}>
      {/* The card's content is the link: the whole card is one tap target and one tab stop. */}
      <Link href={href(s.id)} className={css.cardLink} draggable={false}
        onClick={(e) => { if (justDragged.current) { e.preventDefault(); justDragged.current = false; } }}>
        <span className={css.cardTitle}>{s.title}</span>
        {s.round && (col === "in_review" || col === "waiting_client") ? <RoundTag round={s.round} /> : null}
        <span className={css.cardMeta}>
          {s.owner ? <PersonLine person={s.owner} size={24} /> : <span className={css.muted}>No owner yet</span>}
          {s.due ? <span className={css.date}><CalendarDays aria-hidden="true" />{fmtDayShort(s.due)}</span> : null}
        </span>
        {late ? <Flag late={late} /> : null}
      </Link>
    </li>;
  };

  const board = <div className={css.boardWrap}>
    <div className={css.tabs} role="tablist" aria-label="Status" ref={tabsRef}>
      {COLUMNS.map((c) => <button key={c.key} type="button" role="tab" id={`tab-${c.key}`} aria-controls={`col-${c.key}`} aria-selected={tab === c.key}
        className={css.tab} onClick={() => setTab(c.key)}>{c.title} ({byCol(c.key).length})</button>)}
    </div>
    <div className={css.board}>
      {COLUMNS.map((c) => {
        const items = byCol(c.key);
        return <section key={c.key} id={`col-${c.key}`} className={css.col} data-col={c.key} data-active={tab === c.key ? "" : undefined}
          data-over={drag && drag.over === c.key && drag.from !== c.key ? "" : undefined} aria-labelledby={`h-${c.key}`}>
          <h2 id={`h-${c.key}`} className={css.colTitle}>{c.title} <span className={css.count}>({items.length})</span></h2>
          {items.length ? <ul className={css.cards}>{items.map((s) => card(s, c.key))}</ul> : <p className={css.empty}>{c.empty}</p>}
        </section>;
      })}
    </div>
  </div>;

  const list = <div className={css.list}>
    {groups.map((g) => {
      const isOpen = !!open[g.phase.id];
      const rows = g.phase.isCurrent ? steps : g.steps;
      const done = g.phase.isCurrent ? steps.filter((s) => s.status === "done" || s.status === "skipped").length : g.doneCount;
      return <section key={g.phase.id} className={css.group} data-current={g.phase.isCurrent ? "" : undefined}>
        <h2 className={css.groupHead}>
          <button type="button" className={css.groupBtn} aria-expanded={isOpen} aria-controls={`grp-${g.phase.id}`}
            onClick={() => setOpen((o) => ({ ...o, [g.phase.id]: !isOpen }))}>
            <ChevronRight className={css.chev} aria-hidden="true" />
            <span className={css.groupName}>{g.phase.name}</span>
            {g.phase.isCurrent ? <span className={css.now}>Now</span> : null}
            <span className={css.groupMeta}>{g.phase.start && g.phase.end ? fmtRange(g.phase.start, g.phase.end) : null}</span>
            <span className={css.groupCount}>{done} of {g.stepCount} done</span>
          </button>
        </h2>
        {isOpen ? <ul id={`grp-${g.phase.id}`} className={css.rows}>
          {rows.map((s) => <li key={s.id} className={css.rowItem}>
            <Link href={href(s.id)} className={css.row}>
              <span className={css.rowTitle}>{s.title}</span>
              <span className={css.rowMeta}>
                {s.owner ? <PersonLine person={s.owner} size={20} /> : <span className={css.muted}>No owner yet</span>}
                {s.due ? <span className={css.date}><CalendarDays aria-hidden="true" />{fmtDayShort(s.due)}</span> : null}
                {s.round && (s.status === "in_review" || s.status === "waiting_client") ? <RoundTag round={s.round} /> : null}
              </span>
              <span className={css.rowState}><StepState step={s} /></span>
            </Link>
          </li>)}
          {g.moreHref && g.steps.length < g.stepCount ? <li className={css.more}><Link href={g.moreHref}>Show all {g.stepCount} steps</Link></li> : null}
        </ul> : null}
      </section>;
    })}
  </div>;

  return <>
    <div className={css.bar}>
      <PhaseLine p={phaseLine} />
      <nav className={css.switch} aria-label="View">
        <button type="button" className={css.sw} aria-pressed={view === "list"} onClick={() => setView("list")}><List aria-hidden="true" />List</button>
        <button type="button" className={css.sw} aria-pressed={view === "board"} onClick={() => setView("board")}><Columns3 aria-hidden="true" />Board</button>
        <Link href={hrefs.timeline} className={css.sw}><ChartGantt aria-hidden="true" />Timeline</Link>
      </nav>
    </div>
    {notice && view === "board" ? <div className={css.notice} role="status">
      <CircleAlert aria-hidden="true" /><p>{notice.text}</p>
      <button type="button" className={css.noticeClose} aria-label="Dismiss" onClick={() => setNotice(null)}><X aria-hidden="true" /></button>
    </div> : null}
    {view === "board" ? board : list}
  </>;
}
