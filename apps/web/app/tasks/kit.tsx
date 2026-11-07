"use client";
// TASKS-4B: the review rating speaks in words ("great", "good", "needs_work", or "1"–"5"); the shared kit's Rating
// (TASKS-4A, apps/web/app/kit) draws it: labelled levels for the three words, stars with words for five. Toggle is a
// yes/no switch the kit does not have yet; move it there when it does.
import type { ReactNode } from "react";
import { Rating as KitRating } from "../kit";
import css from "./kit.module.css";

export type RatingOption = { value: string; label: string; hint?: string };
const TONE: Record<string, string> = { great: "var(--theme-success)", needs_work: "var(--theme-warning)" };
const WORDS = ["Poor", "Needs work", "Okay", "Good", "Great"];

/** One choice from a few (Great / Good / Needs work, or 1–5). */
export function Rating({ label, options, value, onChange, size = "md", disabled, hideLabel }: { label: string; options: RatingOption[]; value: string | null; onChange: (v: string) => void;
  size?: "sm" | "md"; disabled?: boolean; hideLabel?: boolean }) {
  const five = options.length === 5 && options.every((o, i) => o.value === String(i + 1));
  const at = options.findIndex((o) => o.value === value);
  const pick = (n: number) => onChange(options[n - 1]?.value ?? options[0].value);
  return <div className={css.rating} data-size={size}>
    {hideLabel ? null : <span className={css.ratingLabel} aria-hidden="true">{label}</span>}
    {five ? <KitRating label={label} value={at >= 0 ? at + 1 : null} onChange={pick} words={WORDS} size={size === "sm" ? 18 : 22} readOnly={disabled} />
      : <KitRating label={label} value={at >= 0 ? at + 1 : null} onChange={pick} readOnly={disabled}
        levels={options.map((o, i) => ({ value: i + 1, label: o.label, tone: TONE[o.value] }))} />}
  </div>;
}

/** A yes/no switch with its words beside it. */
export function Toggle({ label, checked, onChange, disabled, children }: { label: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; children?: ReactNode }) {
  return <label className={css.toggle}>
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span className={css.track} aria-hidden="true"><i /></span>
    <span>{label}{children}</span>
  </label>;
}
