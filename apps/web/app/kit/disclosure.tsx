"use client";
// BILLING-KIT (18 Oct 2026): the one "More details" (in place of raw <details> across the app) and "+ Add …" for
// optional fields that are blank. Rule 3 of the billing blueprint: ask only what this business needs; everything else
// waits behind "More details". Rule 4: optional empty fields don't appear at all until someone adds them.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Plus } from "lucide-react";
import css from "./disclosure.module.css";

/** A section that starts folded: a summary line (with a short hint of what's inside) that opens to its content.
 *  Native details/summary, so find-in-page and the keyboard work; 44 px tall on a phone. */
export function Disclosure({ summary = "More details", hint, defaultOpen = false, children, id, className, onToggle }: {
  summary?: ReactNode; hint?: ReactNode; defaultOpen?: boolean; children: ReactNode; id?: string; className?: string; onToggle?: (open: boolean) => void;
}) {
  return <details className={`${css.disclosure}${className ? ` ${className}` : ""}`} id={id} open={defaultOpen || undefined}
    onToggle={onToggle ? (e) => onToggle((e.currentTarget as HTMLDetailsElement).open) : undefined}>
    <summary className={css.summary}>
      <ChevronRight size={15} className={css.chevron} aria-hidden="true" />
      <span className={css.summaryText}>{summary}</span>
      {hint ? <span className={css.hint}>{hint}</span> : null}
    </summary>
    <div className={css.content}>{children}</div>
  </details>;
}

const FIELD = "input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled), [role=combobox], button:not(:disabled)";

/** An optional field that stays hidden behind "+ {label}" while it is blank. It shows when `show` (it has a value) or
 *  once the link is pressed, and then takes focus. */
export function AddField({ label, show, children, onReveal, className }: { label: string; show: boolean; children: ReactNode; onReveal?: () => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null), focus = useRef(false);
  useEffect(() => {
    if (!open || !focus.current) return;
    focus.current = false;
    box.current?.querySelector<HTMLElement>(FIELD)?.focus();
  }, [open]);
  if (show || open) return <div ref={box} className={`${css.added}${className ? ` ${className}` : ""}`}>{children}</div>;
  return <button type="button" className={css.add} onClick={() => { focus.current = true; setOpen(true); onReveal?.(); }}><Plus size={14} aria-hidden="true" />{label}</button>;
}

/** A row of AddFields: the "+ Add" links flow side by side; a field that is shown takes the whole width. */
export function AddGroup({ children, label }: { children: ReactNode; label?: string }) {
  return <div className={css.group} role="group" aria-label={label}>{children}</div>;
}
