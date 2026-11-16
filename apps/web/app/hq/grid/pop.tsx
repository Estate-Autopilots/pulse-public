"use client";
// PULSE-HQ: a small floating list anchored to a cell or chip (fixed to the window so a scrolling table never clips it),
// and the option list inside it: type to filter, ↑ ↓ to move, Enter picks, Tab picks and moves on, Esc closes.
// DROPDOWNS (4 Nov 2026): Home/End and PageUp/PageDown too, the active row stays in view inside the list, and the list
// fits the window and keeps wheel and touch scrolling to itself (fitMenu, as every dropdown menu).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check } from "lucide-react";
import { fitMenu } from "@pulse/ui-shell";
import css from "./grid.module.css";

export function Floating({ anchor, onClose, width = 260, children, label }: { anchor: HTMLElement | null; onClose: () => void; width?: number; children: ReactNode; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const pos: CSSProperties = { visibility: "hidden", width };
  // Placed straight on the element (measured after layout), so a re-render never moves it back.
  useLayoutEffect(() => {
    if (!anchor) return;
    let shown = false;
    const place = () => {
      const el = box.current; if (!el) return;
      const r = anchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
      const w = Math.min(width, vw - 16), h = el.offsetHeight || 240;
      const left = Math.max(8, Math.min(r.left, vw - w - 8));
      const below = r.bottom + 6 + h <= vh - 8 || r.top < h + 14;
      el.style.left = `${left}px`; el.style.width = `${w}px`;
      el.style.top = `${below ? Math.max(8, Math.min(r.bottom + 6, vh - h - 8)) : Math.max(8, r.top - h - 6)}px`;
      el.style.visibility = "visible";
      fitMenu(el);
      // autoFocus does not take while the list is still hidden for measuring: focus its field the first time it shows.
      if (!shown) { shown = true; if (!el.contains(document.activeElement)) el.querySelector<HTMLElement>("input, textarea")?.focus({ preventScroll: true }); }
    };
    place();
    const raf = requestAnimationFrame(place);
    // A scroll or a resize moves the list with its cell (a phone scrolls when its keyboard opens); it never closes it.
    const follow = () => requestAnimationFrame(place);
    window.addEventListener("scroll", follow, true); window.addEventListener("resize", follow);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("scroll", follow, true); window.removeEventListener("resize", follow); };
  }, [anchor, width]);
  useEffect(() => {
    const away = (e: Event) => { if (box.current && !box.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [anchor, onClose]);
  return <div ref={box} className={css.floating} style={pos} role="dialog" aria-label={label}>{children}</div>;
}

export type Choice = { key: string; label: string; hint?: string; swatch?: string };

export function OptionList({ choices, value, onPick, onCancel, placeholder = "Find…", multi }: { choices: Choice[]; value: string[]; onPick: (key: string, move?: 1 | -1) => void;
  onCancel: () => void; placeholder?: string; multi?: boolean }) {
  const [find, setFind] = useState("");
  const shown = useMemo(() => { const q = find.trim().toLowerCase(); return q ? choices.filter((c) => c.label.toLowerCase().includes(q)) : choices; }, [find, choices]);
  const first = Math.max(0, shown.findIndex((c) => value.includes(c.key)));
  const [at, setAt] = useState(first);
  const cur = Math.min(at, Math.max(0, shown.length - 1));
  const list = useRef<HTMLDivElement>(null), byPointer = useRef(false);
  useEffect(() => {
    if (byPointer.current) { byPointer.current = false; return; }
    const box = list.current, row = box?.children[cur] as HTMLElement | undefined; if (!box || !row) return;
    const top = row.offsetTop - box.offsetTop; // both measured from the floating box
    if (top < box.scrollTop) box.scrollTop = top;
    else if (top + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + row.offsetHeight - box.clientHeight;
  }, [cur]);
  return <div className={css.options}>
    <input className={css.optFind} autoFocus value={find} placeholder={placeholder} aria-label={placeholder}
      onChange={(e) => { setFind(e.target.value); setAt(0); }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setAt((cur + 1) % Math.max(1, shown.length)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setAt((cur - 1 + shown.length) % Math.max(1, shown.length)); }
        else if ((e.key === "PageDown" || e.key === "PageUp") && shown.length) { e.preventDefault(); setAt(Math.max(0, Math.min(shown.length - 1, cur + (e.key === "PageDown" ? 8 : -8)))); }
        else if ((e.key === "Home" || e.key === "End") && shown.length && !find) { e.preventDefault(); setAt(e.key === "Home" ? 0 : shown.length - 1); }
        else if (e.key === "Enter") { e.preventDefault(); if (shown[cur]) onPick(shown[cur].key); }
        else if (e.key === "Tab") { e.preventDefault(); if (shown[cur]) onPick(shown[cur].key, e.shiftKey ? -1 : 1); else onCancel(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
      }} />
    <div ref={list} className={css.optList} role="listbox" aria-multiselectable={multi || undefined}>
      {shown.length ? shown.map((c, i) => <button key={c.key || "-"} type="button" role="option" aria-selected={value.includes(c.key)} className={css.optRow}
        data-on={i === cur ? "" : undefined} onMouseEnter={() => { if (i !== cur) { byPointer.current = true; setAt(i); } }} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(c.key)}>
        {c.swatch ? <i className={css.swatch} style={{ background: c.swatch }} aria-hidden="true" /> : null}
        <span>{c.label}</span>{c.hint ? <small>{c.hint}</small> : null}
        {value.includes(c.key) ? <Check size={14} aria-hidden="true" /> : null}
      </button>) : <p className={css.optEmpty}>Nothing matches</p>}
    </div>
  </div>;
}
