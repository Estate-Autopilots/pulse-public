"use client";
// PM-UI Step detail: the interactive bit (tick the checklist). Local state so the preview is clickable; `onToggle` is
// where the real mutation plugs in later.
import { useState } from "react";
import { Check, ListChecks } from "lucide-react";
import { SectionCard } from "../kit";
import css from "./step-detail.module.css";

type Item = { id: string; text: string; done: boolean };

/** The checklist: ticks only (never a state chip), "2 of 4" counting the ticks. */
export function StepChecklist({ items, canTick, onToggle }: { items: Item[]; /** The owner (or lead) may tick. */ canTick: boolean; onToggle?: (id: string, done: boolean) => void }) {
  const [list, setList] = useState(items);
  const done = list.filter((i) => i.done).length;
  return <SectionCard title="Checklist" icon={ListChecks} aside={<span className={css.count}>{done} of {list.length}</span>} className={css.card}>
    <ul className={css.checks}>{list.map((i) => <li key={i.id}>
      <label className={css.check} data-done={i.done ? "" : undefined}>
        <input type="checkbox" checked={i.done} disabled={!canTick} className={css.checkInput}
          onChange={(e) => { const v = e.currentTarget.checked; setList((l) => l.map((x) => (x.id === i.id ? { ...x, done: v } : x))); onToggle?.(i.id, v); }} />
        <span className={css.box} aria-hidden="true"><Check /></span>
        <span className={css.checkText}>{i.text}</span>
      </label>
    </li>)}</ul>
  </SectionCard>;
}
