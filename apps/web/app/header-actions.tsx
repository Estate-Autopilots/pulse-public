"use client";
// A page header's actions (LAYOUT-SWEEP): what fits stays in the row; the rest is never cut off but waits behind
// "More", which opens those actions as a short menu under the header. RELEASE-6: the actions in the row and "More" stay
// where they are when it opens (the whole row used to move into the menu and back: People's header jumped by 0.08 on a
// phone once COMP-A added "People & pay"). Each action is still one element, so its own state (a drawer it opened) stays.
import { Ellipsis } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "./ui.module.css";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function HeaderActions({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null), row = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0), [open, setOpen] = useState(false);
  const openRef = useRef(false), measureRef = useRef<() => void>(() => {});
  useEffect(() => { openRef.current = open; if (!open) measureRef.current(); }, [open]);
  useIsoLayoutEffect(() => {
    const el = row.current, outer = box.current; if (!el || !outer) return;
    let frame = 0;
    const measure = () => {
      if (openRef.current) return;
      const items = [...el.children] as HTMLElement[];
      for (const i of items) { i.removeAttribute("data-overflow"); i.removeAttribute("data-fold-edge"); i.style.removeProperty("--fold"); }
      if (getComputedStyle(el).flexWrap !== "nowrap") { setHidden(0); return; }
      let n = 0;
      for (let i = items.length - 1; i >= 0 && el.scrollWidth > el.clientWidth + 1; i--) { items[i].setAttribute("data-overflow", ""); n++; }
      // RELEASE-6: each folded action's place in the menu (0 = first); the menu lists only them (ui.module.css).
      items.slice(items.length - n).forEach((item, k) => {
        item.style.setProperty("--fold", String(k));
        if (k === 0 || k === n - 1) item.setAttribute("data-fold-edge", [k === 0 ? "first" : "", k === n - 1 ? "last" : ""].join(" ").trim());
      });
      setHidden(n);
    };
    const soon = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measureRef.current = soon;
    const resize = new ResizeObserver(soon); resize.observe(outer); if (outer.parentElement) resize.observe(outer.parentElement);
    const change = new MutationObserver(soon); change.observe(el, { childList: true, subtree: true, characterData: true });
    // Pip's island sets the bar's room (--pulse-island-room-*, --pulse-bar-right) on <html> after it is placed.
    const room = new MutationObserver(soon); room.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", soon); void document.fonts?.ready.then(soon); measure();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); change.disconnect(); room.disconnect(); window.removeEventListener("resize", soon); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  return <div ref={box} className={styles.actions} data-hscroll="" data-open={open ? "" : undefined}>
    <div ref={row} className={styles.actionsRow} onClick={(e) => { if (open && (e.target as HTMLElement).closest("a, button")) setOpen(false); }}>{children}</div>
    {hidden || open ? <button type="button" className={`${styles.btn} ${styles.actionsMore}`} aria-expanded={open} aria-label={open ? "Fewer actions" : `More actions (${hidden})`}
      title={open ? "Fewer actions" : `${hidden} more ${hidden === 1 ? "action" : "actions"}`} onClick={() => setOpen((v) => !v)}><Ellipsis size={16} aria-hidden="true" /></button> : null}
  </div>;
}

/** A page header's context line: its parts whole and in order, as many as fit the room beside the title; the rest step
 *  aside (the title's tooltip lists them all). Phones wrap the line instead. */
export function HeaderContext({ children }: { children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  useIsoLayoutEffect(() => {
    const el = row.current; if (!el) return;
    let frame = 0;
    const measure = () => {
      const items = [...el.children] as HTMLElement[];
      for (const i of items) i.removeAttribute("data-overflow");
      if (getComputedStyle(el).flexWrap !== "nowrap") return;
      for (let i = items.length - 1; i >= 1 && el.scrollWidth > el.clientWidth + 1; i--) items[i].setAttribute("data-overflow", "");
    };
    const soon = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(soon); if (el.parentElement) resize.observe(el.parentElement); resize.observe(el);
    window.addEventListener("resize", soon); measure();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); window.removeEventListener("resize", soon); };
  }, []);
  return <div ref={row} className={styles.context}>{children}</div>;
}
