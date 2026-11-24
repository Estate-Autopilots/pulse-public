"use client";
// PM-UI 15 Goals: the interactive parts. The header ("Goals", the quarter, "+ Add goal" as an outline), the empty card
// with its one filled "Add goal", and the add-goal sheet (a bottom sheet on a phone, a centred dialog from 600 px).
// Local state only, so the preview is clickable; `onSave` lets the real page post the goal later.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Plus, Target } from "lucide-react";
import { PersonSelect, Select } from "../../../kit";
import type { AddGoalVM } from "../contract/goals";
import { PROJECT_ICONS, PmButton, PmCard, PmSheet, hued } from "../kit";
import css from "./goals.module.css";

export type NewGoal = { title: string; target: string; period: string; ownerId: string | null; projectIds: string[] };

function AddGoalSheet({ add, me, onClose, onSave, focusTitle }: { add: AddGoalVM; me: string; onClose: () => void; onSave?: (g: NewGoal) => void; focusTitle: boolean }) {
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [period, setPeriod] = useState<string | null>(add.periods[0]?.key ?? null);
  const [ownerId, setOwnerId] = useState<string | null>(me);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setError("Give the goal a title."); return; }
    onSave?.({ title: title.trim(), target, period: period ?? "", ownerId, projectIds: picked });
    onClose();
  };
  const toggle = (id: string) => setPicked((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));

  return <div className={css.layer} onClick={(e) => { if (e.target === e.currentTarget.firstElementChild) onClose(); }}>
    <PmSheet title="Add goal" label="Add goal" footer={<>
      <PmButton variant="outline" size="lg" onClick={onClose}>Cancel</PmButton>
      <PmButton variant="primary" size="lg" type="submit" form="pm-goal-form">Save goal</PmButton>
    </>}>
      <form id="pm-goal-form" className={css.form} onSubmit={submit} noValidate>
        <div className={css.field}>
          <label htmlFor="pm-goal-title" className={css.label}>Title</label>
          <input id="pm-goal-title" className={css.input} value={title} autoFocus={focusTitle} autoComplete="off" placeholder="e.g. 9 launches live by 31 Dec"
            aria-invalid={error ? true : undefined} aria-describedby={error ? "pm-goal-error" : undefined}
            onChange={(e) => { setTitle(e.target.value); if (error) setError(null); }} />
          {error ? <p id="pm-goal-error" className={css.error} role="alert">{error}</p> : null}
        </div>
        <div className={css.field}>
          <label htmlFor="pm-goal-target" className={css.label}>Target <span className={css.optional}>(optional)</span></label>
          <input id="pm-goal-target" className={css.input} value={target} inputMode="decimal" autoComplete="off" placeholder="e.g. 9"
            onChange={(e) => setTarget(e.target.value.replace(/[^0-9.]/g, ""))} />
        </div>
        <div className={css.field}>
          <span className={css.label}>Period</span>
          <Select label="Period" value={period} onChange={(v) => setPeriod(v)} options={add.periods.map((p) => ({ value: p.key, label: p.label }))} />
        </div>
        <div className={css.field}>
          <span className={css.label}>Owner</span>
          <PersonSelect label="Owner" people={add.people} value={ownerId} me={me} onChange={(p) => setOwnerId(p?.id ?? null)} />
        </div>
        <fieldset className={css.field}>
          <legend className={css.label}>Projects</legend>
          <div className={css.pickRow}>
            {add.projects.map((p) => {
              const Icon = PROJECT_ICONS[p.icon];
              const on = picked.includes(p.id);
              return <button key={p.id} type="button" {...hued(p.hue, css.pick)} aria-pressed={on} onClick={() => toggle(p.id)}>
                <Icon aria-hidden="true" /><span>{p.name}</span>
              </button>;
            })}
          </div>
        </fieldset>
      </form>
    </PmSheet>
  </div>;
}

export function GoalsClient({ sub, addGoal, initialOpen, empty, me, onSave, children }: {
  /** "This quarter · Oct–Dec 2026" */ sub: string; addGoal: AddGoalVM | null; /** Sheet open on first paint. */ initialOpen: boolean;
  /** No goals: the empty card (with the one filled "Add goal") replaces the list and the header button hides. */ empty: boolean;
  /** The viewer's id (default owner). */ me: string; onSave?: (g: NewGoal) => void; children: ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [byTap, setByTap] = useState(false);
  const show = () => { setByTap(true); setOpen(true); };
  const close = () => setOpen(false);

  return <div className={css.wrap}>
    <header className={css.header}>
      <div className={css.heading}>
        <h1 className={css.h1}>Goals</h1>
        <p className={css.sub}>{sub}</p>
      </div>
      {addGoal && !empty ? <PmButton variant="outline" icon={Plus} className={css.addBtn} onClick={show} aria-haspopup="dialog">{addGoal.label}</PmButton> : null}
    </header>

    {empty ? <PmCard className={css.empty}>
      <span className={css.emptyIcon} aria-hidden="true"><Target /></span>
      <h2 className={css.emptyTitle}>No goals yet.</h2>
      <p className={css.emptyText}>Set one number the whole team can see.</p>
      {addGoal ? <PmButton variant="primary" size="lg" icon={Plus} onClick={show} aria-haspopup="dialog">{addGoal.label}</PmButton> : null}
    </PmCard> : children}

    {addGoal && open ? <AddGoalSheet add={addGoal} me={me} onClose={close} onSave={onSave} focusTitle={byTap} /> : null}
  </div>;
}
