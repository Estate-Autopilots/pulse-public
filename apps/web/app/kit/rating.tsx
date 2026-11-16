"use client";
// TASKS-4A kit: Rating. Stars (1–5 by default) or labelled levels ("Great · Good · Needs work"), as a radio group: one
// tab stop, ← → (or ↑ ↓) move and choose, Home/End jump; hovering previews; the choice pops a little (not under reduced
// motion). `readOnly` draws the same thing as a figure.
import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Star } from "lucide-react";
import css from "./kit.module.css";

export type Level = { value: number; label: string; icon?: ReactNode; tone?: string };

export function Rating({ value, onChange, max = 5, label, levels, words, readOnly, size = 22, name }: { value: number | null; onChange?: (v: number) => void; max?: number; label: string;
  /** Labelled levels instead of stars. */ levels?: Level[];
  /** Words for the stars (1 = first), shown beside them: ["Poor", "Fair", "Good", "Great", "Outstanding"]. */ words?: string[];
  readOnly?: boolean; size?: number; name?: string }) {
  const [hover, setHover] = useState<number | null>(null), [popped, setPopped] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const values = levels ? levels.map((l) => l.value) : Array.from({ length: max }, (_, i) => i + 1);
  const pick = (v: number) => { if (readOnly) return; onChange?.(v); setPopped(v); setTimeout(() => setPopped(null), 340); };
  const keys = (e: KeyboardEvent, v: number) => {
    const i = values.indexOf(v);
    const next = e.key === "ArrowRight" || e.key === "ArrowUp" ? values[Math.min(values.length - 1, i + 1)] : e.key === "ArrowLeft" || e.key === "ArrowDown" ? values[Math.max(0, i - 1)]
      : e.key === "Home" ? values[0] : e.key === "End" ? values.at(-1)! : null;
    if (next === null || next === undefined) return;
    e.preventDefault(); pick(next); requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-v="${next}"]`)?.focus());
  };
  const stop = (v: number) => value === v || (value === null && v === values[0]) ? 0 : -1;
  if (levels) return <div ref={root} role="radiogroup" aria-label={label} aria-readonly={readOnly || undefined} className={css.levels}>
    {levels.map((l) => <button key={l.value} type="button" role="radio" aria-checked={value === l.value} tabIndex={stop(l.value)} data-v={l.value} className={css.level} disabled={readOnly && value !== l.value}
      data-pop={popped === l.value ? "" : undefined} style={l.tone ? { "--tone": l.tone } as CSSProperties : undefined} onClick={() => pick(l.value)} onKeyDown={(e) => keys(e, l.value)} name={name}>{l.icon ?? null}{l.label}</button>)}
  </div>;
  const shown = hover ?? value ?? 0;
  return <div ref={root} role={readOnly ? "img" : "radiogroup"} aria-label={readOnly ? `${label}: ${value ?? 0} of ${max}` : label} aria-readonly={readOnly || undefined} className={css.rating} onPointerLeave={() => setHover(null)}>
    {values.map((v) => readOnly ? <span key={v} className={css.star} data-on={v <= shown ? "" : undefined} aria-hidden="true"><Star size={size} /></span>
      : <button key={v} type="button" role="radio" aria-checked={value === v} aria-label={`${v} of ${max}${words?.[v - 1] ? `: ${words[v - 1]}` : ""}`} tabIndex={stop(v)} data-v={v} className={css.star}
        data-on={v <= shown ? "" : undefined} data-pop={popped === v ? "" : undefined} onPointerEnter={(e) => { if (e.pointerType === "mouse") setHover(v); }} onClick={() => pick(v)} onKeyDown={(e) => keys(e, v)}><Star size={size} aria-hidden="true" /></button>)}
    {words ? <span className={css.ratingText} aria-hidden="true">{shown ? words[shown - 1] : ""}</span> : null}
  </div>;
}
