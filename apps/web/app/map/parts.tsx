"use client";

import { Info, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Pager } from "../fit";
import { PRECISION_LABEL, type Precision } from "./geo";
import css from "./map.module.css";

const useLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * A tab strip or segmented control: the marker slides to the chosen item; ← → move between items.
 * `tabs` is the panel's main strip (icon over label), `sub` the second level, `seg` a plain switch.
 */
export function Seg<T extends string>({ items, value, onChange, label, variant = "seg" }: {
  items: { key: T; label: ReactNode; icon?: LucideIcon; title?: string; count?: number; disabled?: boolean }[]; value: T; onChange: (key: T) => void; label: string; variant?: "tabs" | "sub" | "seg";
}) {
  const box = useRef<HTMLDivElement>(null);
  const [mark, setMark] = useState<{ left: number; width: number } | null>(null);
  useLayout(() => {
    const el = box.current; if (!el) return;
    const place = () => { const on = el.querySelector<HTMLElement>('[aria-selected="true"]'); setMark(on ? { left: on.offsetLeft, width: on.offsetWidth } : null); };
    place(); const watch = new ResizeObserver(place); watch.observe(el); return () => watch.disconnect();
  }, [value, items.length]);
  const keys = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!step) return;
    e.preventDefault(); e.stopPropagation();
    const on = items.filter((i) => !i.disabled), next = on[(on.findIndex((i) => i.key === value) + step + on.length) % on.length]; onChange(next.key);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };
  return (
    <div ref={box} className={variant === "tabs" ? css.tabs : variant === "sub" ? css.sub : css.seg} role="tablist" aria-label={label} onKeyDown={keys}>
      {mark ? <span className={css.mark} style={{ transform: `translateX(${mark.left}px)`, width: mark.width }} aria-hidden="true" /> : null}
      {items.map(({ key, label: text, icon: Icon, title, count, disabled }) => (
        <button key={key} type="button" role="tab" aria-label={typeof text === "string" ? text : undefined} aria-selected={key === value} tabIndex={key === value ? 0 : -1} title={title} disabled={disabled} onClick={() => onChange(key)}>
          {Icon ? <Icon size={variant === "tabs" ? 18 : 16} strokeWidth={1.8} aria-hidden="true" /> : null}<span>{text}</span>{count !== undefined ? <small>{count.toLocaleString("en-IN")}</small> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * A list that never scrolls on a desktop: the app's Pager shows the rows that fit the height it is given and pages
 * through the rest. On a phone it pages by eight and the sheet scrolls.
 */
export function List<T>({ items, keyOf, render, empty, unit, columns, resetKey }: { items: T[]; keyOf: (item: T) => string; render: (item: T, index: number) => ReactNode; empty?: ReactNode; unit: string; columns?: boolean; resetKey?: string }) {
  if (!items.length) return <div className={css.emptyBox}>{empty}</div>;
  return (
    <Pager key={resetKey} unit={unit} mobile={8} className={css.list}>
      <ul data-items="" className={css.rows} data-columns={columns ? "" : undefined}>{items.map((item, i) => <li key={keyOf(item)}>{render(item, i)}</li>)}</ul>
    </Pager>
  );
}

/** How precisely Pulse knows the place: solid for confirmed, a ring for approximate. */
export function PrecisionBadge({ precision, pinned }: { precision: Precision | null; pinned?: boolean }) {
  return <span className={css.precision} data-precision={precision ?? "none"}><i aria-hidden="true" />{pinned ? "Pinned in Pulse" : precision ? PRECISION_LABEL[precision] : "No point yet"}</span>;
}

/** A KPI tile: label, a large value, one line of context. */
export function Stat({ label, value, note, title }: { label: string; value: ReactNode; note?: ReactNode; title?: string }) {
  return <div className={css.stat} title={title}><span>{label}</span><b>{value}</b>{note ? <small>{note}</small> : null}</div>;
}

export function Note({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return <div className={css.note}><span className={css.noteIcon}><Icon size={20} strokeWidth={1.7} aria-hidden="true" /></span><b>{title}</b>{children ? <p>{children}</p> : null}</div>;
}

/** The rule behind a number, one click away: a small button that opens the explanation above it. */
export function How({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc, true); };
  }, [open]);
  return (
    <div ref={box} className={css.how}>
      <button type="button" className={css.howButton} aria-expanded={open} aria-label="How this is counted" title="How this is counted" onClick={() => setOpen(!open)}><Info size={16} aria-hidden="true" /></button>
      {open ? <p role="note">{children}</p> : null}
    </div>
  );
}

/** A sub-tab row: the switch, then the rule behind the numbers. */
export function SubHead({ children, how }: { children: ReactNode; how: ReactNode }) {
  return <div className={css.subHead}>{children}<How>{how}</How></div>;
}

/**
 * Normal width: a summary and lists as sub-tabs, so each gets the full height. Focus mode (wide): the summary
 * stays on the left and the lists take the right.
 */
export function Layout<T extends string>({ wide, summary, views, view, setView, how, children, label }: {
  wide: boolean; summary?: ReactNode; views: { key: T; label: string; count?: number }[]; view: T | "summary"; setView: (v: T | "summary") => void; how: ReactNode; children: ReactNode; label: string;
}) {
  const items = [...(summary && !wide ? [{ key: "summary" as const, label: "Summary" }] : []), ...views];
  const shown = wide && view === "summary" ? views[0].key : view;
  return (
    <div className={css.pane} data-wide={wide ? "" : undefined} data-split={wide && summary ? "" : undefined}>
      {wide && summary ? <div className={css.side}>{summary}</div> : null}
      <div className={css.main}>
        {items.length > 1 || how ? <SubHead how={how}>{items.length > 1 ? <Seg variant="sub" label={label} value={shown} onChange={setView} items={items} /> : <span />}</SubHead> : null}
        {shown === "summary" ? <div className={css.summary}>{summary}</div> : children}
      </div>
    </div>
  );
}

