"use client";
// PM-UI 11 clock move, the live part: the project page behind (dimmed, not interactive while the sheet is open) and the
// move sheet (bottom sheet on a phone, centred dialog from 600 px). The new date and the reason are live: changing the date
// recomputes every row with `previewMove`; an empty reason shows "Reason is required" and turns the button off. Cancel / ×
// / Escape close it; "Move dates" applies the move to the page and shows a toast. Real wiring: pass `onConfirm`/`onCancel`.
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import {
  CalendarDays, Camera, Check, CircleAlert, CircleCheck, Circle, ClipboardCheck, Clock3, Database, Flag, Image as ImageIcon, Layers, Laptop, Megaphone, Rocket, Users, X,
  type LucideIcon,
} from "lucide-react";
import { DateField } from "../../../kit/date-field";
import { applyMove, previewMove, type ClockMovePage, type ClockMoveVM, type MovePreview } from "../contract/clock-move";
import type { Clock, IsoDate, Phase } from "../contract/shared";
import { BackLink, Chip, HealthChip, PersonLine, PmButton, PmCard, ProjectTile, SectionCard, daysBetween, fmtDayShort, hued, nDays, type Tone } from "../kit";
import css from "./clock-move.module.css";

/** A phase's icon by its name (presentation only; the template has no phase icons yet). */
const PHASE_ICONS: Record<string, LucideIcon> = {
  "Kick-off": Flag, "Brand blueprint": Layers, Shoot: Camera, "Creative assets": ImageIcon, "Landing page": Laptop,
  "CRM setup": Database, "Sales training": Users, Review: ClipboardCheck, "Ads live": Megaphone,
};
const PhaseIcon = ({ name }: { name: string }) => { const I = PHASE_ICONS[name] ?? Flag; return <I className={css.phaseIcon} aria-hidden="true" />; };

const PHASE_WORDS: Record<Phase["status"], { word: string; tone: Tone }> = {
  done: { word: "Done", tone: "done" }, active: { word: "Doing", tone: "info" }, not_started: { word: "To do", tone: "neutral" }, late: { word: "Late", tone: "problem" },
};
const clockDate = (c?: Clock) => c?.actual ?? c?.planned ?? null;

export type ClockMoveConfirm = { clockKey: string; to: IsoDate; reason: string };

export function ClockMoveView({ vm, onConfirm, onCancel }: { vm: ClockMoveVM; /** Save the move (real wiring); the preview applies it locally. */ onConfirm?: (move: ClockMoveConfirm) => void; onCancel?: () => void }) {
  const [open, setOpen] = useState(!!vm.sheet);
  const [page, setPage] = useState<ClockMovePage>(vm.page);
  const [toast, setToast] = useState(vm.toast);
  const dialog = useRef<HTMLDivElement>(null);

  const reopen = () => { setToast(undefined); setOpen(true); requestAnimationFrame(() => dialog.current?.focus()); };
  const close = () => { setOpen(false); onCancel?.(); };
  const confirm = (preview: MovePreview, reason: string) => {
    if (!vm.sheet) return;
    onConfirm?.({ clockKey: vm.sheet.clock.key, to: preview.to, reason });
    setPage(applyMove(vm, preview));
    setOpen(false);
    setToast(`Dates moved · ${preview.steps} ${preview.steps === 1 ? "step" : "steps"}`);
  };

  return <>
    <div className={css.behind} inert={open || undefined}>
      <ProjectPage page={page} onMove={vm.sheet && !open && page === vm.page ? reopen : undefined} />
    </div>
    {open && vm.sheet ? <MoveSheet vm={vm} dialogRef={dialog} onClose={close} onConfirm={confirm} /> : null}
    {toast && !open ? <p className={css.toast} role="status"><Check aria-hidden="true" />{toast}</p> : null}
  </>;
}

/* ---------- The page behind ---------- */

function ProjectPage({ page, onMove }: { page: ClockMovePage; onMove?: () => void }) {
  const day0 = page.clocks.find((c) => c.key === "inputs_complete");
  const ads = page.clocks.find((c) => c.key === "ads_live");
  const d0 = clockDate(day0), ad = clockDate(ads);
  const moveBtn = (label: string, cls: string) => onMove
    ? <PmButton variant="outline" icon={CalendarDays} className={cls} onClick={onMove}>{label}</PmButton>
    : <PmButton variant="outline" icon={CalendarDays} className={cls} href={page.moveHref}>{label}</PmButton>;
  return <div className={css.page}>
    <BackLink href={page.backHref} label="Projects" />
    <PmCard className={css.headCard}>
      <div className={css.head}>
        <ProjectTile project={page.project} size="lg" />
        <div className={css.headText}>
          <h1 className={css.h1}>{page.project.name}</h1>
          <p className={css.muted}>{page.project.client ? `${page.project.client} · ` : ""}{page.city}</p>
          <div className={css.headMeta}>
            <HealthChip health={page.health} />
            {d0 && ad ? <span className={css.dates}><CalendarDays aria-hidden="true" />Day 0 {fmtDayShort(d0)} · {ads?.label} {fmtDayShort(ad)}</span> : null}
          </div>
        </div>
        {moveBtn("Move dates", css.headAction)}
      </div>
    </PmCard>

    <div className={css.grid}>
      <div className={css.main}>
        <PmCard className={css.progress}>
          <div className={css.progressHead}><h2 className={css.h2}>Overall progress</h2><span className={css.muted}>{page.progress.done} / {page.progress.of} phases</span></div>
          <span {...hued(page.project.hue, css.bar)} role="img" aria-label={`${page.progress.done} of ${page.progress.of} phases done`}>
            <i style={{ width: `${(page.progress.done / Math.max(1, page.progress.of)) * 100}%` }} />
          </span>
        </PmCard>
        <SectionCard title="Phases & dates" flush>
          <ol className={css.phaseRows}>{page.phases.map((p) => {
            const w = PHASE_WORDS[p.status];
            return <li key={p.id} className={css.phaseRow}>
              <PhaseIcon name={p.name} />
              <span className={css.phaseName}>{p.name}</span>
              <Chip tone={w.tone}>{w.word}</Chip>
              <span className={css.phaseDate}>{p.end ? fmtDayShort(p.end) : ""}</span>
            </li>;
          })}</ol>
        </SectionCard>
      </div>
      <div className={css.aside}>
        <SectionCard title={<><span className={css.notWide}>Project clocks</span><span className={css.wideOnly}>Key dates</span></>}>
          <ul className={css.clocks}>{page.clocks.map((c) => {
            const d = clockDate(c);
            const n = d && d0 ? daysBetween(d0, d) : null;
            const dayTag = c.key !== "inputs_complete" && n !== null ? ` (Day ${n < 0 ? `−${-n}` : n})` : "";
            return <li key={c.key} className={css.clock} data-done={c.actual ? "" : undefined}>
              {c.actual ? <CircleCheck className={css.clockMark} role="img" aria-label="Done" /> : <Circle className={css.clockMark} role="img" aria-label="Not yet" />}
              <span><span className={css.clockLabel}>{c.label}</span><span className={css.muted}> · {d ? fmtDayShort(d) : "Not set"}{dayTag}</span></span>
            </li>;
          })}</ul>
        </SectionCard>
        <SectionCard title="Team" aside={<span className={css.muted}>{page.team.length}</span>} className={css.team}>
          <ul className={css.people}>{page.team.map((p) => <li key={p.id}><PersonLine person={p} role size={32} /></li>)}</ul>
        </SectionCard>
      </div>
    </div>
    <div className={css.foot}>{moveBtn("Update project", css.footAction)}</div>
  </div>;
}

/* ---------- The move sheet ---------- */

function MoveSheet({ vm, dialogRef, onClose, onConfirm }: { vm: ClockMoveVM; dialogRef: RefObject<HTMLDivElement | null>; onClose: () => void; onConfirm: (p: MovePreview, reason: string) => void }) {
  const s = vm.sheet!;
  const [to, setTo] = useState<IsoDate>(s.to);
  const [reason, setReason] = useState(s.reason);
  const [touched, setTouched] = useState(!!s.reasonError);
  const [picking, setPicking] = useState(false);
  const preview = useMemo(() => previewMove(vm, to), [vm, to]);
  const ids = useId();
  const titleId = `${ids}-t`, reasonId = `${ids}-r`, errId = `${ids}-e`;
  const empty = reason.trim() === "";
  const showError = touched && empty;
  const canSave = !empty && preview.shift !== 0;

  // Opened after a failed save (empty reason): show the field and its error, also inside the short phone sheet.
  const body = useRef<HTMLDivElement>(null);
  const startsWithError = !!s.reasonError;
  useEffect(() => {
    if (startsWithError && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [startsWithError]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const sign = preview.shift > 0 ? "+" : "−";
  const stepWord = preview.steps === 1 ? "step moves" : "steps move";
  const shiftText = preview.shift === 0 ? "Pick a new date to see what moves" : `${preview.steps} ${stepWord} ${sign}${nDays(Math.abs(preview.shift))}`;

  return <div className={css.backdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={dialogRef} className={css.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <span className={css.grip} aria-hidden="true" />
      <header className={css.sheetHead}>
        <span className={css.sheetIcon} aria-hidden="true"><Clock3 /></span>
        <div className={css.titles}>
          <h2 id={titleId} className={css.title}>Move {s.clock.label}</h2>
          <p className={css.sub}>
            <span>from {fmtDayShort(s.from)} to <b>{fmtDayShort(to)}</b></span>
            <button type="button" className={css.change} aria-expanded={picking} onClick={() => setPicking((v) => !v)}>{picking ? "Done" : "Change date"}</button>
          </p>
        </div>
        <button type="button" className={css.close} aria-label="Close" onClick={onClose}><X aria-hidden="true" /></button>
      </header>

      <div ref={body} className={css.sheetBody}>
        {picking ? <div className={css.dateRow}>
          <span className={css.label}>New date</span>
          <DateField value={to} required today={vm.today} aria-label={`New date for ${s.clock.label}`} onChange={(e) => { if (e.target.value) setTo(e.target.value); }} />
        </div> : null}

        <p className={css.band}><CalendarDays aria-hidden="true" /><b>{shiftText}</b></p>

        <table className={css.list}>
          <caption className={css.srOnly}>Phase end dates before and after the move</caption>
          <thead><tr><th scope="col">Phase</th><th scope="col">Before</th><th scope="col" className={css.arrowCol}><span className={css.srOnly}>to</span></th><th scope="col">After</th></tr></thead>
          <tbody>{preview.rows.map((r) => <tr key={r.phaseId}>
            <th scope="row"><span className={css.rowName}><PhaseIcon name={r.name} />{r.name}</span></th>
            <td className={css.before}>{fmtDayShort(r.before)}</td>
            <td className={css.arrowCol} aria-hidden="true">→</td>
            <td className={css.after} data-stays={r.stays ? "" : undefined}>{fmtDayShort(r.after)}{r.stays ? <span className={css.stays}>stays</span> : null}</td>
          </tr>)}</tbody>
        </table>

        <div className={css.wideWrap}>
          <table className={css.wide}>
            <caption className={css.srOnly}>Phase end dates before and after the move</caption>
            <thead><tr><th scope="col">Phase</th>{preview.rows.map((r) => <th key={r.phaseId} scope="col">{r.name}</th>)}</tr></thead>
            <tbody>
              <tr><th scope="row">Before</th>{preview.rows.map((r) => <td key={r.phaseId}>{fmtDayShort(r.before)}</td>)}</tr>
              <tr><th scope="row">After</th>{preview.rows.map((r) => <td key={r.phaseId} className={css.after} data-stays={r.stays ? "" : undefined}>{fmtDayShort(r.after)}{r.stays ? <span className={css.stays}>stays</span> : null}</td>)}</tr>
            </tbody>
          </table>
        </div>

        <p className={css.band}><Rocket aria-hidden="true" /><span>{preview.target.label} target moves {fmtDayShort(preview.target.before)} → <b className={css.accent}>{fmtDayShort(preview.target.after)}</b></span></p>

        <div className={css.field}>
          <label htmlFor={reasonId} className={css.label}>Reason (required)</label>
          <input id={reasonId} className={css.input} type="text" value={reason} placeholder="Enter a reason" autoComplete="off" required
            aria-invalid={showError || undefined} aria-describedby={showError ? errId : undefined}
            onChange={(e) => { setReason(e.target.value); setTouched(true); }} onBlur={() => setTouched(true)} />
          {showError ? <p id={errId} className={css.error}><CircleAlert aria-hidden="true" />{s.reasonError ?? "Reason is required"}</p> : null}
        </div>

        {!empty && s.noTeamLate && preview.shift !== 0 ? <p className={css.note}><CircleCheck aria-hidden="true" />No one on your team will show as late for this</p> : null}
      </div>

      <footer className={css.sheetFoot}>
        <PmButton variant="outline" size="lg" className={css.cancel} onClick={onClose}>Cancel</PmButton>
        <PmButton variant="primary" size="lg" disabled={!canSave} onClick={() => { if (canSave) onConfirm(preview, reason.trim()); else setTouched(true); }}>{s.submit.label}</PmButton>
      </footer>
    </div>
  </div>;
}
