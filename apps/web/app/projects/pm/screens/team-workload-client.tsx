"use client";
// PM-UI: the live part of 09 Team workload: filters, the people × days grid, the day sheet and the suggestion card.
// Everything works on local state so the preview is clickable (week switch, filters, open a day, Reassign, Not now,
// Undo); pass the callbacks to wire the real reads and writes later. Tones come from the hours: ≤ 8 h On track,
// 9–10 h High load, > 10 h Overloaded (words in the legend, the day sheet chip and "Over by 5 h", never colour only).
import Link from "next/link";
import { useEffect, useRef, useState, type RefObject } from "react";
import { CalendarDays, CircleCheck, ChevronLeft, ChevronRight, FolderOpen, Lightbulb, Users, X } from "lucide-react";
import { Avatar } from "../../../avatar";
import { Select } from "../../../kit";
import type { IsoDate } from "../contract/shared";
import type { TeamWorkloadVM, WorkloadMove, WorkloadStep } from "../contract/team-workload";
import { Chip, PmButton, firstName, fmtDay, hued } from "../kit";
import css from "./team-workload.module.css";

/** Words for one week, made on the server (fixed locale): group head, phone switcher, day and weekend headers. */
export type WeekLabels = {
  group: string; switcher: string;
  days: { date: IsoDate; wd: string; short: string; num: string }[];
  weekend: { date: IsoDate; wd: string; num: string }[];
};

type Load = "ok" | "high" | "over";
const WORD: Record<Load, string> = { ok: "On track", high: "High load", over: "Overloaded" };
const CHIP: Record<Load, "done" | "action" | "problem"> = { ok: "done", high: "action", over: "problem" };
type Hours = Record<string, number[][]>;
type Cell = { personId: string; date: IsoDate };

type Props = {
  vm: TeamWorkloadVM;
  labels: WeekLabels[];
  rangeLabel: string;
  /** Called after the local change; wire to the real writes later. */
  onReassign?: (move: WorkloadMove) => void;
  onUndo?: (move: WorkloadMove) => void;
  onDismiss?: (move: WorkloadMove) => void;
  /** A filter changed (null = All); wire to a fresh read. */
  onFilter?: (f: { role: string | null; projectId: string | null }) => void;
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function Workload({ vm, labels, rangeLabel, onReassign, onUndo, onDismiss, onFilter }: Props) {
  const cap = vm.capacity;
  const [hours, setHours] = useState<Hours>(() => Object.fromEntries(vm.people.map((p) => [p.person.id, p.hours.map((w) => [...w])])));
  const [week, setWeek] = useState(vm.phoneWeek);
  const [role, setRole] = useState(vm.filters.role ?? "all");
  const [projectId, setProjectId] = useState(vm.filters.projectId ?? "all");
  const [suggestion, setSuggestion] = useState<WorkloadMove | null>(vm.suggestion);
  const [moved, setMoved] = useState<WorkloadMove | null>(vm.moved);
  const [open, setOpen] = useState<Cell | null>(vm.openDay);
  const opener = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const userOpened = useRef(false);

  const tone = (h: number): Load => (h <= cap.day ? "ok" : h <= cap.highUpTo ? "high" : "over");
  /** A span of days: its total, its tone (red only with an overloaded day) and how far over capacity. */
  const span = (days: number[]) => {
    const total = sum(days); const capacity = cap.day * days.length;
    const load: Load = days.some((h) => tone(h) === "over") ? "over" : total > capacity ? "high" : "ok";
    return { total, load, overBy: total - capacity };
  };
  const dayIndex = (date: IsoDate) => { for (let w = 0; w < vm.weeks.length; w++) { const d = vm.weeks[w].days.indexOf(date); if (d >= 0) return [w, d] as const; } return null; };
  const shift = (h: Hours, m: WorkloadMove, sign: 1 | -1): Hours => {
    const at = dayIndex(m.date); if (!at) return h;
    const [w, d] = at;
    const add = (id: string, n: number) => (h[id] ? { [id]: h[id].map((wk, i) => (i === w ? wk.map((x, j) => (j === d ? x + n : x)) : wk)) } : {});
    return { ...h, ...add(m.from.id, -sign * m.hours), ...add(m.to.id, sign * m.hours) };
  };

  const rows = vm.people.filter((p) => role === "all" || p.person.role === role);
  const shownIds = new Set(rows.map((r) => r.person.id));
  const anyOver = rows.some((r) => (hours[r.person.id] ?? []).flat().some((h) => tone(h) === "over"));
  const showSuggestion = suggestion && shownIds.has(suggestion.from.id) && shownIds.has(suggestion.to.id) ? suggestion : null;

  const reassign = (m: WorkloadMove) => { setHours((h) => shift(h, m, 1)); setSuggestion(null); setMoved(m); setOpen(null); onReassign?.(m); };
  const undo = (m: WorkloadMove) => { setHours((h) => shift(h, m, -1)); setMoved(null); setSuggestion(m); onUndo?.(m); };
  const dismiss = (m: WorkloadMove) => { setSuggestion(null); onDismiss?.(m); };
  const close = () => { setOpen(null); opener.current?.focus({ preventScroll: true }); };

  // The day sheet: Escape closes; a sheet the user opened takes focus on its close button.
  useEffect(() => {
    if (!open) return;
    if (userOpened.current) { closeRef.current?.focus({ preventScroll: true }); userOpened.current = false; }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(null); opener.current?.focus({ preventScroll: true }); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  /** The steps behind a cell, with the move applied (the moved step leaves the giver's day and joins the receiver's). */
  const stepsOf = (c: Cell): WorkloadStep[] => {
    const base = vm.days.find((d) => d.personId === c.personId && d.date === c.date)?.steps ?? [];
    const all = vm.days.flatMap((d) => d.steps);
    if (!moved || moved.date !== c.date) return base;
    if (c.personId === moved.from.id) return base.filter((s) => s.id !== moved.stepId);
    if (c.personId === moved.to.id && !base.some((s) => s.id === moved.stepId)) {
      const s = all.find((x) => x.id === moved.stepId);
      return s ? [...base, { ...s, hours: moved.hours }] : base;
    }
    return base;
  };

  const setFilter = (next: { role?: string; projectId?: string }) => {
    const r = next.role ?? role, p = next.projectId ?? projectId;
    if (next.role !== undefined) setRole(r);
    if (next.projectId !== undefined) setProjectId(p);
    onFilter?.({ role: r === "all" ? null : r, projectId: p === "all" ? null : p });
  };

  const openPerson = open ? vm.people.find((p) => p.person.id === open.personId) : undefined;
  const openAt = open ? dayIndex(open.date) : null;
  const openHours = openPerson && openAt ? hours[openPerson.person.id]?.[openAt[0]]?.[openAt[1]] ?? 0 : 0;
  const sheet = open && openPerson ? <DaySheet name={firstName(openPerson.person)} date={open.date} hours={openHours} load={tone(openHours)} steps={stepsOf(open)} closeRef={closeRef} onClose={close} /> : null;
  const capWeek = cap.day * (vm.weeks[0]?.days.length ?? 5);

  return <>
    <div className={css.wrap}>
      <div className={css.filters}>
        <span className={css.rangeField}>
          <Select label="Dates" className={css.filter} value="next2" onChange={() => undefined}
            options={[{ value: "next2", label: rangeLabel }]} renderValue={(o) => <><CalendarDays aria-hidden="true" className={css.filterIcon} /><span>{o.label}</span></>} />
        </span>
        <span className={css.filterBox}><Select label="Role" className={css.filter} value={role} onChange={(v) => setFilter({ role: v ?? "all" })}
          options={[{ value: "all", label: "All" }, ...vm.filters.roles.map((r) => ({ value: r, label: r }))]}
          renderValue={(o) => <><Users aria-hidden="true" className={css.filterIcon} /><span>Role: {o.label}</span></>} /></span>
        <span className={css.filterBox}><Select label="Project" className={css.filter} value={projectId} onChange={(v) => setFilter({ projectId: v ?? "all" })}
          options={[{ value: "all", label: "All" }, ...vm.filters.projects.map((p) => ({ value: p.id, label: p.name }))]}
          renderValue={(o) => <><FolderOpen aria-hidden="true" className={css.filterIcon} /><span>Project: {o.label}</span></>} /></span>
      </div>

      <section className={css.card} aria-label="Hours per person per day">
        <div className={css.switcher}>
          <button type="button" className={css.arrow} aria-label="Previous week" disabled={week <= 0} onClick={() => setWeek((w) => Math.max(0, w - 1))}><ChevronLeft aria-hidden="true" /></button>
          <h2 className={css.switchLabel} aria-live="polite">{labels[week]?.switcher}</h2>
          <button type="button" className={css.arrow} aria-label="Next week" disabled={week >= labels.length - 1} onClick={() => setWeek((w) => Math.min(labels.length - 1, w + 1))}><ChevronRight aria-hidden="true" /></button>
        </div>

        <div className={css.scroll}>
          <div role="table" className={css.grid} data-week={week} aria-label={`Team workload, ${rangeLabel}`}>
            <div role="rowgroup">
              <div role="row" className={css.groupRow}>
                <span role="columnheader" className={css.corner} aria-hidden="true" />
                {labels.map((l, w) => <span key={l.group} role="columnheader" className={css.groupHead} data-w={w} aria-colspan={5}>{l.group}</span>)}
              </div>
              <div role="row" className={css.headRow}>
                <span role="columnheader" className={css.nameHead}>Team member</span>
                {labels.map((l, w) => [
                  ...l.days.map((d) => <span key={d.date} role="columnheader" className={css.dayHead} data-w={w}>
                    <b>{d.wd}</b><span className={css.wide}>{d.short}</span><span className={css.narrow}>{d.num}</span>
                  </span>),
                  ...(w < labels.length - 1 ? l.weekend.map((d) => <span key={d.date} role="columnheader" className={css.endHead}><b>{d.wd}</b><span>{d.num}</span></span>) : []),
                ])}
                <span role="columnheader" className={css.totalHead} data-phone="">Total /<br />{capWeek} h</span>
                <span role="columnheader" className={css.totalHead} data-wide="">Total /<br />{capWeek * labels.length} h</span>
              </div>
            </div>
            <div role="rowgroup">
              {rows.map((r) => {
                const id = r.person.id;
                const h = hours[id] ?? r.hours;
                const all = span(h.flat());
                const wk = span(h[week] ?? []);
                return <div key={id} role="row" className={css.row}>
                  <span role="rowheader" className={css.nameCell} title={r.person.name}>
                    <span className={css.avatar}><Avatar name={r.person.name} id={r.person.id} photoAt={r.person.photoAt} size={32} /></span>
                    <span className={css.nameText}>
                      <span className={css.name}>{firstName(r.person)}</span>
                      <span className={css.role}>{r.person.role}</span>
                      {all.load === "over" && all.overBy > 0 ? <span className={css.over} data-wide="">Over by {all.overBy} h</span> : null}
                      {wk.load === "over" && wk.overBy > 0 ? <span className={css.over} data-phone="">Over by {wk.overBy} h</span> : null}
                    </span>
                  </span>
                  {h.map((days, w) => [
                    ...days.map((n, d) => {
                      const date = vm.weeks[w].days[d];
                      const t = tone(n);
                      const selected = open?.personId === id && open.date === date;
                      return <span key={date} role="cell" className={css.cellWrap} data-w={w}>
                        <button type="button" className={css.cell} data-tone={t} aria-pressed={selected}
                          aria-label={`${firstName(r.person)}, ${fmtDay(date)}: ${n} h, ${WORD[t]}`}
                          onClick={(e) => { opener.current = e.currentTarget; userOpened.current = true; setOpen(selected ? null : { personId: id, date }); }}>
                          {n} h
                        </button>
                      </span>;
                    }),
                    ...(w < h.length - 1 ? [0, 1].map((k) => <span key={`we-${w}-${k}`} role="cell" className={css.endCell} aria-label="Weekend">–</span>) : []),
                  ])}
                  <span role="cell" className={css.totalCell} data-phone="">
                    <span className={css.total} data-tone={wk.load}>{wk.total} h</span>
                  </span>
                  <span role="cell" className={css.totalCell} data-wide="">
                    <span className={css.total} data-tone={all.load}>{all.total} h{all.load === "over" && all.overBy > 0 ? <small>Over by {all.overBy} h</small> : null}</span>
                  </span>
                </div>;
              })}
            </div>
          </div>
        </div>

        <p className={css.legend}>
          <span><i data-tone="ok" aria-hidden="true" /><span>≤{" "}{cap.day}{" "}h <b>On track</b></span></span>
          <span><i data-tone="high" aria-hidden="true" /><span>{cap.day + 1}–{cap.highUpTo}{" "}h <b>High load</b></span></span>
          <span><i data-tone="over" aria-hidden="true" /><span>&gt;{" "}{cap.highUpTo}{" "}h <b>Overloaded</b></span></span>
        </p>
      </section>

      <div className={css.below} data-open={sheet ? "" : undefined}>
        <div className={css.belowMain}>
          {showSuggestion ? <section className={css.suggest} aria-label="Suggestion">
            <span className={css.suggestIcon} aria-hidden="true"><Lightbulb /></span>
            <p className={css.suggestText}>
              {/* Non-breaking spaces keep "6 h, Tue" and "6 h free." whole when the line wraps. */}
              Move <b>{showSuggestion.title}</b> <span className={css.keep}>({showSuggestion.hours}{" "}h, {fmtDay(showSuggestion.date).split(",")[0]})</span> from <b>{firstName(showSuggestion.from)}</b> to <b>{firstName(showSuggestion.to)}</b>, {showSuggestion.to.role}, <span className={css.keep}>{showSuggestion.freeHours}{" "}h{" "}free.</span>
            </p>
            <div className={css.suggestActions}>
              <PmButton variant="primary" size="lg" className={css.reassign} onClick={() => reassign(showSuggestion)}>Reassign</PmButton>
              <button type="button" className={css.linkBtn} onClick={() => dismiss(showSuggestion)}>Not now</button>
            </div>
          </section>
          : moved ? <p className={css.note} role="status">
            <CircleCheck aria-hidden="true" className={css.noteIcon} data-done="" />
            <span className={css.noteText}>{moved.title} moved to {firstName(moved.to)}. {firstName(moved.from)} and {firstName(moved.to)} were told.{" "}
              <button type="button" className={`${css.linkBtn} ${css.undo}`} onClick={() => undo(moved)}>Undo</button></span>
          </p>
          : !anyOver ? <p className={css.note}>
            <CircleCheck aria-hidden="true" className={css.noteIcon} data-done="" />
            <span className={css.noteText}>Nobody is overloaded in these two weeks.</span>
          </p> : null}
        </div>
        {sheet ? <div className={css.anchored}>{sheet}</div> : null}
      </div>
    </div>

    {/* Phone: bottom sheet; tablet: side sheet over a dimmed page (laptop uses the anchored panel above). */}
    {sheet ? <div className={css.overlay} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>{sheet}</div> : null}
  </>;
}

function DaySheet({ name, date, hours, load, steps, closeRef, onClose }: { name: string; date: IsoDate; hours: number; load: Load; steps: WorkloadStep[]; closeRef: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const listed = sum(steps.map((s) => s.hours));
  const rest = hours - listed;
  const title = `${name} · ${fmtDay(date)}`;
  return <div className={css.sheet} role="dialog" aria-label={title}>
    <span className={css.grip} aria-hidden="true" />
    <header className={css.sheetHead}>
      <div className={css.sheetTitles}>
        <h2 className={css.sheetTitle}>{title}</h2>
        <Chip tone={CHIP[load]}>{WORD[load]} · {hours} h</Chip>
      </div>
      <button ref={closeRef} type="button" className={css.close} aria-label="Close" onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <h3 className={css.stepsHead}>Steps for the day</h3>
    {steps.length > 0 || rest > 0 ? <ul className={css.steps}>
      {steps.map((s) => <li key={s.id}>
        <Link href={s.href} className={css.step}>
          <span {...hued(s.project.hue, css.dot)} aria-hidden="true" />
          <span className={css.stepText}><span className={css.stepTitle}>{s.title}</span><span className={css.stepProject}>{s.project.name}</span></span>
          <span className={css.stepHours}>{s.hours} h</span>
        </Link>
      </li>)}
      {rest > 0 && steps.length > 0 ? <li className={css.step} data-rest=""><span className={css.dot} aria-hidden="true" /><span className={css.stepText}><span className={css.stepProject}>Other steps</span></span><span className={css.stepHours}>{rest} h</span></li> : null}
    </ul> : null}
    {steps.length === 0 ? <p className={css.sheetEmpty}>{hours > 0 ? `${hours} h planned across this day's steps.` : "Nothing planned for this day."}</p> : null}
  </div>;
}
