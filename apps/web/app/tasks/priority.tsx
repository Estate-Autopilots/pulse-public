"use client";
// TASKS-4A: one Priority control (Low · Normal · High · Urgent) as icon chips with a small reaction when chosen, and the
// urgency a task carries worked out from its due date and priority instead of a second question (the owner: "Priority
// and Urgency both exist and confuse people"). Pip's suggestion shows as a spark on the chip it would pick.
import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ChevronsDown, ChevronsUp, Equal, Flame, Sparkles } from "lucide-react";
import { Tooltip } from "../kit";
import css from "./priority.module.css";

export type Priority = "low" | "normal" | "high" | "urgent";
export const PRIORITIES: { value: Priority; label: string; Icon: typeof Flame; tone: string; hint: string }[] = [
  { value: "low", label: "Low", Icon: ChevronsDown, tone: "var(--theme-text-muted)", hint: "Can wait; nobody is held up" },
  { value: "normal", label: "Normal", Icon: Equal, tone: "var(--theme-action)", hint: "The usual" },
  { value: "high", label: "High", Icon: ChevronsUp, tone: "var(--theme-warning)", hint: "Matters this week" },
  { value: "urgent", label: "Urgent", Icon: Flame, tone: "var(--theme-danger)", hint: "Drop other things for it" },
];
const DAY = 86400000;
/** Urgency from the due date and priority: due today or late, or Urgent → high; due within three days or High →
 *  normal; Low with no date → low; otherwise normal. Kept on the task so the pool can sort by it. */
export function urgencyFrom(priority: string, dueOn: string | null, today: string): "low" | "normal" | "high" {
  const days = dueOn ? Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY) : null;
  if (priority === "urgent" || (days !== null && days <= 0)) return "high";
  if (priority === "high" || (days !== null && days <= 3)) return "normal";
  if (priority === "low" && days === null) return "low";
  return "normal";
}
/** Where a task sits in Eisenhower's grid: important = High or Urgent priority, urgent = due within two days. */
export function eisenhower(t: { priority?: string | null; dueOn?: string | null }, today: string) {
  const important = t.priority === "high" || t.priority === "urgent";
  const days = t.dueOn ? Math.round((Date.parse(`${t.dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY) : null;
  const soon = t.priority === "urgent" || (days !== null && days <= 2);
  return important && soon ? "now" : important ? "plan" : soon ? "quick" : "later";
}
export const EISENHOWER: Record<string, { label: string; hint: string }> = {
  now: { label: "Do now", hint: "Important and due soon" }, plan: { label: "Schedule", hint: "Important, not due yet" },
  quick: { label: "Quick wins", hint: "Due soon, less important: hand over or do fast" }, later: { label: "Later", hint: "Neither: batch them or drop them" },
};

export function PriorityPicker({ value, onChange, suggested, label = "Priority", compact }: { value: string; onChange: (p: Priority) => void; suggested?: string | null; label?: string; compact?: boolean }) {
  const [popped, setPopped] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pick = (p: Priority) => { onChange(p); setPopped(p); setTimeout(() => setPopped(null), 420); };
  const keys = (e: KeyboardEvent, i: number) => {
    const n = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? PRIORITIES.length - 1 : null;
    if (n === null) return;
    e.preventDefault(); const p = PRIORITIES[(n + PRIORITIES.length) % PRIORITIES.length]; pick(p.value);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-p="${p.value}"]`)?.focus());
  };
  return <div ref={root} role="radiogroup" aria-label={label} className={css.group} data-compact={compact ? "" : undefined}>
    {PRIORITIES.map((p, i) => {
      const on = value === p.value, tip = suggested === p.value && !on ? `${p.hint} · Pip suggests ${p.label.toLowerCase()}` : p.hint;
      return <Tooltip key={p.value} content={tip}>
        <button type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-p={p.value} className={css.chip} data-pop={popped === p.value ? "" : undefined}
          style={{ "--tone": p.tone } as CSSProperties} onClick={() => pick(p.value)} onKeyDown={(e) => keys(e, i)}>
          <span className={css.icon} aria-hidden="true"><p.Icon size={15} strokeWidth={2.4} /></span>{p.label}
          {suggested === p.value && !on ? <Sparkles size={11} className={css.spark} aria-label="Pip’s suggestion" /> : null}
        </button>
      </Tooltip>;
    })}
  </div>;
}
