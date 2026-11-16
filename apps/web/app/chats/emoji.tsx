"use client";
// CHAT-V6: the emoji picker: search ("thumb", "party", "chai"), categories with a tab for each, Recent first, and the
// keyboard: arrows move through the grid (rows and columns, across sections), Enter picks, Tab to the tabs, Esc closes.
// Focus stays in the search box while the arrows move (aria-activedescendant), so typing always searches. On a phone it
// is a sheet across the bottom with 44 px cells, and the search box does not pop the keyboard until tapped.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { EMOJI_GROUPS, emojiName, searchEmoji } from "../lib/emoji-data.mjs";
import { noteEmoji, recentEmoji } from "./v5";
import v6 from "./v6.module.css";

type Section = { key: string; label: string; icon: string; items: string[] };
const coarse = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

export function EmojiPicker({ onPick, onClose, keepOpen = true, note = true, label = "Emoji", className }: { onPick: (e: string) => void; onClose: () => void; keepOpen?: boolean; /** count it for Recent (a reaction counts itself) */ note?: boolean; label?: string; className?: string }) {
  const id = useId();
  const [q, setQ] = useState(""), [active, setActive] = useState(0), [tab, setTab] = useState("recent"), [cols, setCols] = useState(8);
  const body = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), root = useRef<HTMLDivElement>(null);
  // Recent as it was when the picker opened: the grid does not move under the finger while emoji are picked.
  const [recentKey] = useState(() => recentEmoji(24).join("\u0001"));
  const sections: Section[] = useMemo(() => {
    if (q.trim()) return [{ key: "found", label: "Found", icon: "🔍", items: searchEmoji(q, 120) }];
    const r = recentKey ? [{ key: "recent", label: "Recent", icon: "🕘", items: recentKey.split("\u0001") }] : [];
    return [...r, ...EMOJI_GROUPS.map((g) => ({ key: g.key, label: g.label, icon: g.icon, items: g.items.map((x) => x.e) }))];
  }, [q, recentKey]);
  // The grid as rows (per section) of cell indices, for moving up and down by columns.
  const { cells, rows } = useMemo(() => {
    const cells: { e: string; section: string }[] = [], rows: number[][] = [];
    for (const s of sections) for (let i = 0; i < s.items.length; i += cols) { const row: number[] = []; for (const e of s.items.slice(i, i + cols)) { row.push(cells.length); cells.push({ e, section: s.key }); } rows.push(row); }
    return { cells, rows };
  }, [sections, cols]);
  useLayoutEffect(() => {
    const el = body.current; if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => { const cell = coarse() || el.clientWidth < 360 ? 44 : 38; setCols(Math.max(5, Math.floor((el.clientWidth - 12) / cell))); };
    fit(); const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect();
  }, []);
  useEffect(() => { if (!coarse()) input.current?.focus(); }, []);
  useEffect(() => { queueMicrotask(() => setActive(0)); body.current?.scrollTo({ top: 0 }); }, [q]);
  // Close on a tap outside (the Emoji button toggles it itself) and on Esc anywhere in it.
  useEffect(() => {
    const down = (e: PointerEvent) => { const t = e.target as Element | null; if (root.current && t && !root.current.contains(t) && !t.closest("[data-emoji-toggle]")) onClose(); };
    document.addEventListener("pointerdown", down); return () => document.removeEventListener("pointerdown", down);
  }, [onClose]);
  // The tab follows the section in view.
  function onScroll() {
    const el = body.current; if (!el || q.trim()) return;
    const top = el.getBoundingClientRect().top; let now = sections[0]?.key ?? "";
    for (const h of el.querySelectorAll<HTMLElement>("[data-emoji-section]")) { if (h.getBoundingClientRect().top - top <= 8) now = h.dataset.emojiSection!; }
    if (now !== tab) setTab(now);
  }
  const show = (i: number) => { setActive(i); requestAnimationFrame(() => document.getElementById(`${id}-${i}`)?.scrollIntoView({ block: "nearest" })); };
  function pick(e: string) { if (note) noteEmoji(e); onPick(e); if (!keepOpen) onClose(); }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (!cells.length) return;
    const r = rows.findIndex((row) => row.includes(active)), c = Math.max(0, rows[r]?.indexOf(active) ?? 0);
    const go = (row: number) => { const target = rows[Math.max(0, Math.min(rows.length - 1, row))]; show(target[Math.min(c, target.length - 1)]); };
    switch (e.key) {
      case "ArrowRight": e.preventDefault(); show(Math.min(cells.length - 1, active + 1)); break;
      case "ArrowLeft": if ((e.target as HTMLElement).tagName === "INPUT" && (input.current?.selectionStart ?? 0) > 0) return; e.preventDefault(); show(Math.max(0, active - 1)); break;
      case "ArrowDown": e.preventDefault(); go(r + 1); break;
      case "ArrowUp": e.preventDefault(); go(r - 1); break;
      case "PageDown": e.preventDefault(); go(r + 5); break;
      case "PageUp": e.preventDefault(); go(r - 5); break;
      case "Home": if ((e.target as HTMLElement).tagName === "INPUT") return; e.preventDefault(); show(0); break;
      case "End": if ((e.target as HTMLElement).tagName === "INPUT") return; e.preventDefault(); show(cells.length - 1); break;
      case "Enter": e.preventDefault(); if (cells[active]) pick(cells[active].e); break;
    }
  }
  function jump(key: string) {
    setQ(""); setTab(key);
    requestAnimationFrame(() => { const el = body.current, h = el?.querySelector<HTMLElement>(`[data-emoji-section="${key}"]`); if (el && h) el.scrollTo({ top: h.offsetTop - el.offsetTop - 4 }); const i = cells.findIndex((x) => x.section === key); if (i >= 0) setActive(i); });
  }
  let n = 0;
  return <div ref={root} className={`${v6.picker} ${className ?? ""}`} role="dialog" aria-label={label} data-emoji-picker="" onKeyDown={onKey}>
    <div className={v6.pickerTop}>
      <label className={v6.pickerSearch}><Search size={15} aria-hidden="true" />
        <input ref={input} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search emoji" aria-label="Search emoji" enterKeyHint="done" autoComplete="off"
          role="combobox" aria-expanded="true" aria-controls={`${id}-grid`} aria-activedescendant={cells[active] ? `${id}-${active}` : undefined} />
        {q ? <button type="button" onClick={() => { setQ(""); input.current?.focus(); }} aria-label="Clear the search"><X size={14} aria-hidden="true" /></button> : null}
      </label>
      <button type="button" className={v6.pickerClose} onClick={onClose} aria-label="Close emoji"><X size={16} aria-hidden="true" /></button>
    </div>
    {q.trim() ? null : <div className={v6.pickerTabs} role="tablist" aria-label="Emoji categories">
      {sections.map((s) => <button key={s.key} type="button" role="tab" aria-selected={tab === s.key} title={s.label} aria-label={s.label} onClick={() => jump(s.key)} data-emoji-tab={s.key}>{s.icon}</button>)}
    </div>}
    <div ref={body} className={v6.pickerBody} onScroll={onScroll} id={`${id}-grid`} role="listbox" aria-label={q.trim() ? "Emoji found" : "Emoji"}>
      {sections.map((s) => <div key={s.key} role="group" aria-label={s.label}>
        <p className={v6.pickerHead} data-emoji-section={s.key} aria-hidden="true">{s.label}</p>
        {s.items.length ? <div className={v6.pickerGrid} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {s.items.map((e) => { const i = n++; return <button key={`${s.key}-${e}`} id={`${id}-${i}`} type="button" role="option" tabIndex={-1} aria-selected={i === active} data-active={i === active || undefined}
            aria-label={`${e} ${emojiName(e)}`.trim()} title={emojiName(e)} onMouseDown={(ev) => ev.preventDefault()} onClick={() => { setActive(i); pick(e); }} data-emoji={e} {...(s.key === "recent" ? { "data-recent-emoji": "" } : {})}>{e}</button>; })}
        </div> : <p className={v6.pickerNone}>No emoji for “{q.trim()}”.</p>}
      </div>)}
    </div>
  </div>;
}
