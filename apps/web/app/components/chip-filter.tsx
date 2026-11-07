"use client";
// UX-BILLING (5 Nov 2026): My day's company chips, for any list: one chip per view with its count, the chosen one pressed.
// On a phone the row scrolls sideways inside itself (never the page); 44 px tall, 36 px on a computer with a mouse.
import { useEffect, useRef, type ReactNode } from "react";
import { toneStyle, type Tone } from "./calm";
import css from "./chip-filter.module.css";

export type Chip<T extends string> = { value: T; label: ReactNode; count?: number; tone?: Tone; /** a coloured dot before the label */ dot?: boolean };

export function ChipFilter<T extends string>({ label, chips, value, onChange, hideEmpty }: { label: string; chips: Chip<T>[]; value: T; onChange: (v: T) => void; /** leave out chips with a count of 0 (the chosen one stays) */ hideEmpty?: boolean }) {
  // Like the kit's Segmented, the row marks itself data-ready once React owns it: chips painted by the server do nothing
  // until then (browser checks wait for it before they tap a row of the list it filters).
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.setAttribute("data-ready", ""); }, []);
  return <div ref={root} className={css.chips} role="group" aria-label={label}>
    {chips.filter((c) => !hideEmpty || c.count === undefined || c.count > 0 || c.value === value).map((c) => <button key={c.value} type="button" className={css.chip} aria-pressed={c.value === value}
      style={c.tone ? toneStyle(c.tone) : undefined} onClick={() => onChange(c.value)}>
      {c.dot ? <i className={css.dot} aria-hidden="true" /> : null}{c.label}
      {c.count ? <span className={css.count}>{c.count}</span> : null}
    </button>)}
  </div>;
}
