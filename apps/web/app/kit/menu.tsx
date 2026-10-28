"use client";
// TASKS-4A kit: the dropdown menu. A button opens a list of actions (role=menu): ↑ ↓ Home End move, a letter jumps to the
// next item starting with it, Enter or Space runs one, Escape or Tab closes and gives focus back. Items can be links,
// carry an icon, a second line, a shortcut, a check (menuitemradio) or a danger tone; separators and headings group them.
import Link from "next/link";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Popover, Keycap } from "./popover";
import type { Placement } from "./layer";
import css from "./kit.module.css";

export type MenuItem = { key: string; label: ReactNode; text?: string; icon?: ReactNode; hint?: ReactNode; shortcut?: string | string[]; href?: string; onSelect?: () => void;
  danger?: boolean; disabled?: boolean; checked?: boolean; separator?: boolean; heading?: string };

export function Menu({ label, items, children, className, placement = "bottom-end", buttonLabel, title }: { label: string; items: MenuItem[];
  /** The button's content (an icon, or text with a chevron). */ children: ReactNode; className?: string; placement?: Placement; buttonLabel?: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  const id = useId();
  const live = () => [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
  const focusAt = (i: number) => { const all = live(); all[(i + all.length) % all.length]?.focus(); };
  const openWith = (at: "first" | "last") => { setOpen(true); requestAnimationFrame(() => focusAt(at === "first" ? 0 : -1)); };
  const run = (m: MenuItem) => { if (m.disabled) return; setOpen(false); anchor.current?.focus({ preventScroll: true }); m.onSelect?.(); };
  const keys = (e: KeyboardEvent) => {
    const all = live(), i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusAt(i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusAt(i - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusAt(0); }
    else if (e.key === "End") { e.preventDefault(); focusAt(-1); }
    else if (e.key === "Tab") setOpen(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = (e.key ?? "").toLowerCase(), text = (el: HTMLElement) => (el.dataset.text ?? el.textContent ?? "").trim().toLowerCase();
      const next = [...all.slice(i + 1), ...all.slice(0, i + 1)].find((el) => text(el).startsWith(k)); next?.focus();
    }
  };
  return <>
    <button ref={anchor} type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={buttonLabel} title={title}
      onClick={() => open ? setOpen(false) : openWith("first")} onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openWith(e.key === "ArrowDown" ? "first" : "last"); } }}>{children}</button>
    <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={label} role="none" placement={placement} focus="none">
      <div ref={list} id={id} role="menu" aria-label={label} className={css.menu} onKeyDown={keys}>
        {items.map((m) => {
          const role = m.checked === undefined ? "menuitem" : "menuitemradio";
          const body = <>{m.icon ?? null}<span className={css.menuLabel}>{m.label}{m.hint ? <small>{m.hint}</small> : null}</span>
            {m.checked ? <Check size={15} aria-hidden="true" /> : m.shortcut ? <Keycap keys={m.shortcut} hideOnTouch /> : null}</>;
          const common = { role, tabIndex: -1, className: css.menuItem, "data-danger": m.danger ? "" : undefined, "aria-disabled": m.disabled || undefined, "aria-checked": m.checked, "data-text": m.text };
          return <div key={m.key} role="none">
            {m.separator ? <div role="separator" className={css.menuSep} /> : null}
            {m.heading ? <div role="presentation" className={css.menuHead}>{m.heading}</div> : null}
            {m.href && !m.disabled ? <Link href={m.href} {...common} onClick={() => setOpen(false)}>{body}</Link>
              : <button type="button" {...common} onClick={() => run(m)}>{body}</button>}
          </div>;
        })}
      </div>
    </Popover>
  </>;
}
