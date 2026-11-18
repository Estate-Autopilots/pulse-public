"use client";
// DITASU-2 (orchestrator decision under the owner's delegation, 17 Nov 2026, AC card 7): a task's circle finishes the task
// in ONE click, right where you clicked, with Undo there too. Ditasu's replays showed the old flow: the first click only
// turned the circle green and the question ("Mark … done?") with its button appeared in Pip's corner, far from the
// pointer, so he clicked the circle again and again. This is the kit's toast for that: a small "Done · Undo" pill beside
// the element that was clicked (it follows it while the page scrolls), for a few seconds, longer while the pointer or the
// keyboard is on it. Escape closes it. One at a time: a newer one replaces it. Mounted once in the app's layout.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Undo2 } from "lucide-react";
import css from "./undo-here.module.css";
import { bannerOver, placeUndo } from "../lib/undo-place.mjs";

type Item = { key: number; title: string; message?: string; undo: () => unknown; origin: Element | null; at: DOMRect | null; ms: number };
let item: Item | null = null, seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** Shows "title · Undo" beside `origin` (the circle that was clicked). `undo` runs once, on Undo. */
export function undoHere(origin: Element | null | undefined, o: { title: string; message?: string; undo: () => unknown; ms?: number }) {
  const el = origin && typeof (origin as Element).getBoundingClientRect === "function" ? origin as Element : null;
  item = { key: ++seq, title: o.title, message: o.message, undo: o.undo, origin: el, at: el ? el.getBoundingClientRect() : null, ms: o.ms ?? 6500 };
  emit();
}
export function dismissUndoHere() { if (item) { item = null; emit(); } }
/** For tests and the page: what is showing now. */
export const currentUndoHere = () => item;

export function UndoHereLayer() {
  const it = useSyncExternalStore(subscribe, () => item, () => null);
  // One pill per item: a newer one is a fresh pill (its own hold state, its own timer).
  return it ? <Pill key={it.key} it={it} /> : null;
}

function Pill({ it }: { it: Item }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hold, setHold] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0, at = it.at;
    const place = () => {
      frame = 0;
      const live = it.origin && it.origin.isConnected ? it.origin.getBoundingClientRect() : null;
      if (live && live.width) at = live;
      const view = { width: document.documentElement.clientWidth || innerWidth, height: innerHeight };
      // In a row (a list item, a table row, a card): a banner over that row; otherwise a pill beside what was clicked.
      const rowEl = it.origin && it.origin.isConnected ? it.origin.closest("li, tr, [data-task]") : null, row = rowEl?.getBoundingClientRect();
      if (at && row && row.width > 0 && row.height < 120) {
        const b = bannerOver(at, row, view);
        el.dataset.row = ""; Object.assign(el.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
        return;
      }
      if (!row && el.dataset.row !== undefined) return; // the row left the page: stay where it was
      delete el.dataset.row; el.style.width = ""; el.style.height = "";
      const p = placeUndo(at, { width: el.offsetWidth, height: el.offsetHeight }, view);
      el.style.left = `${p.left}px`; el.style.top = `${p.top}px`;
    };
    place();
    const later = () => { if (!frame) frame = requestAnimationFrame(place); };
    window.addEventListener("scroll", later, true); window.addEventListener("resize", later);
    return () => { window.removeEventListener("scroll", later, true); window.removeEventListener("resize", later); if (frame) cancelAnimationFrame(frame); };
  }, [it]);
  useEffect(() => {
    if (hold) return;
    const t = setTimeout(() => { if (item?.key === it.key) dismissUndoHere(); }, it.ms);
    return () => clearTimeout(t);
  }, [it, hold]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") dismissUndoHere(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return <div ref={ref} className={css.pill} role="status" aria-live="polite" data-undo-here=""
    onPointerEnter={() => setHold(true)} onPointerLeave={() => setHold(false)} onFocus={() => setHold(true)} onBlur={() => setHold(false)}>
    <span className={css.tick} aria-hidden="true"><Check size={13} strokeWidth={3} /></span>
    <span className={css.words}>{/^Done: /.test(it.title)
      ? <b title={it.title}><span className={css.doneWord}>Done</span>{it.title.slice(6)}</b> : <b title={it.title}>{it.title}</b>}{it.message ? <small>{it.message}</small> : null}</span>
    <button type="button" className={css.undo} onClick={() => { const run = it.undo; dismissUndoHere(); void run(); }}><Undo2 size={14} aria-hidden="true" />Undo</button>
  </div>;
}
