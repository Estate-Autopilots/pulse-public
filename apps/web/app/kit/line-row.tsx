"use client";
// BILLING-KIT (18 Oct 2026): one line per thing (rule 2 of the billing blueprint). Line items, parts, contacts and
// payments each take one row at least 48 px tall: a name and one quiet line under it, its amount on the right, and its
// controls (a +/− Stepper, "Not needed") outside the row's own button. Pressing the row opens its details (usually in the
// Drawer); rows never unfold into boxes in place. OpenAmount is a required amount that stays highlighted until it is
// filled or marked not needed (rule 4: an empty box means "needed").
import Link from "next/link";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Minus, Plus, Undo2 } from "lucide-react";
import css from "./line-row.module.css";

/** A bordered list of LineRows. */
export function LineList({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <div role="list" aria-label={label} className={`${css.list}${className ? ` ${className}` : ""}`}>{children}</div>;
}

export type LineRowProps = {
  title: ReactNode; sub?: ReactNode;
  /** An icon, a chevron or a photo before the name. */ lead?: ReactNode;
  amount?: ReactNode; amountSub?: ReactNode;
  /** "needed": an empty required amount (warning tint); "muted": a free or switched-off line. */ tone?: "needed" | "muted";
  /** The row is a button that opens its details. */ onOpen?: () => void;
  /** The row is a link. */ href?: string;
  /** The accessible name of the row's button or link, when the title alone isn't enough. */ label?: string;
  selected?: boolean;
  /** Below 480 px the name takes the first line and `end` and the amount the second (long names). */ stack?: boolean;
  /** With `onOpen`: the row folds open what `controls` names (a package's parts). */ expanded?: boolean; controls?: string;
  /** Controls kept outside the row's button: a Stepper, a "Not needed" button, a menu. */ end?: ReactNode;
  className?: string;
};

/** One row. The whole row presses (the button stretches over it); `end` controls sit above that. */
export function LineRow({ title, sub, lead, amount, amountSub, tone, onOpen, href, label, selected, expanded, controls, end, stack, className }: LineRowProps) {
  const text = <>{lead ? <span className={css.lead}>{lead}</span> : null}<span className={css.text}><span className={css.title}>{title}</span>{sub ? <span className={css.sub}>{sub}</span> : null}</span></>;
  return <div role="listitem" className={`${css.row}${className ? ` ${className}` : ""}`} data-tone={tone} data-selected={selected ? "" : undefined} data-press={onOpen || href ? "" : undefined} data-stack={stack ? "" : undefined}>
    {onOpen ? <button type="button" className={css.main} onClick={onOpen} aria-label={label} aria-current={selected ? "true" : undefined} aria-expanded={expanded} aria-controls={controls}>{text}</button>
      : href ? <Link href={href} className={css.main} aria-label={label}>{text}</Link>
      : <div className={css.main}>{text}</div>}
    {end ? <div className={css.end}>{end}</div> : null}
    {amount !== undefined && amount !== null ? <span className={css.amount}>{amount}{amountSub ? <small>{amountSub}</small> : null}</span> : null}
  </div>;
}

const clean = (n: number) => Math.round(n * 1000) / 1000;

/** −/+ with the number between them (typed too): arrows step it, Home/End jump to the ends. */
export function Stepper({ value, onChange, min = 0, max = Number.MAX_SAFE_INTEGER, step = 1, label = "Quantity", disabled, onInvalidValue }: {
  value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; label?: string; disabled?: boolean;
  /** Let a form retain an out-of-range typed number so its submit validation can explain the error. */
  onInvalidValue?: (n: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const set = (n: number) => onChange(clean(Math.min(max, Math.max(min, n))));
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    const by = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
    if (by) { e.preventDefault(); setText(null); set(value + by); }
    else if (e.key === "Home" && min > Number.MIN_SAFE_INTEGER) { e.preventDefault(); set(min); }
    else if (e.key === "End" && max < Number.MAX_SAFE_INTEGER) { e.preventDefault(); set(max); }
  };
  return <span className={css.stepper} role="group" aria-label={label}>
    <button type="button" className={css.stepBtn} aria-label={`Less: ${label}`} disabled={disabled || value - step < min} onClick={() => { setText(null); set(value - step); }}><Minus size={15} aria-hidden="true" /></button>
    <input className={css.stepValue} role="spinbutton" aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max < Number.MAX_SAFE_INTEGER ? max : undefined}
      inputMode="decimal" disabled={disabled} value={text ?? String(value)} onKeyDown={key}
      onChange={(e) => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value.trim() !== "" && Number.isFinite(n)) { if (n >= min && n <= max) onChange(clean(n)); else onInvalidValue?.(n); } }}
      onBlur={() => setText(null)} onFocus={(e) => e.currentTarget.select()} />
    <button type="button" className={css.stepBtn} aria-label={`More: ${label}`} disabled={disabled || value + step > max} onClick={() => { setText(null); set(value + step); }}><Plus size={15} aria-hidden="true" /></button>
  </span>;
}

const RUPEES = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
/** "12,500.50" or "12,500" from paise. */
export const amountText = (paise: number) => RUPEES.format(paise / 100);
/** Paise from what someone typed ("₹ 12,500.5"), or null when it isn't an amount. */
export function toPaiseLoose(text: string): number | null {
  const t = text.replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** A required amount: highlighted until filled or marked not needed. Opens the number keypad on a phone. */
export function OpenAmount({ value, notNeeded, onChange, onNotNeeded, label, placeholder = "₹ amount", disabled }: {
  value: number | null; notNeeded: boolean; onChange: (paise: number | null) => void; onNotNeeded: (no: boolean) => void; label: string; placeholder?: string; disabled?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  if (notNeeded) return <span className={css.open} data-state="no">
    <span className={css.openNo}>Not needed</span>
    <button type="button" className={css.openLink} disabled={disabled} onClick={() => onNotNeeded(false)} aria-label={`Needed after all: ${label}`}><Undo2 size={13} aria-hidden="true" />Undo</button>
  </span>;
  return <span className={css.open} data-state={value === null ? "needed" : "filled"}>
    {value === null ? <button type="button" className={css.openLink} disabled={disabled} onClick={() => onNotNeeded(true)} aria-label={`Not needed: ${label}`}>Not needed</button> : null}
    <input className={css.openInput} inputMode="decimal" aria-label={label} placeholder={placeholder} disabled={disabled} aria-invalid={value === null ? true : undefined}
      value={text ?? (value === null ? "" : amountText(value))}
      onFocus={() => setText(value === null ? "" : String(value / 100))}
      onChange={(e) => { setText(e.target.value); onChange(e.target.value.trim() === "" ? null : toPaiseLoose(e.target.value)); }}
      onBlur={() => setText(null)} />
  </span>;
}
