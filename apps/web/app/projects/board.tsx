"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { styles } from "../ui";
import css from "./projects.module.css";

const DESKTOP = "(min-width: 1180px) and (min-height: 600px)";
/** Narrowest a column may get before the board shows fewer of them and offers arrows instead: three roomy columns on a laptop, four on a wide screen. */
const MIN = 340, GAP = 12;
const useLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The board's row of columns. Every column shares the width; when the window cannot hold them all at a legible
 * width it shows as many as fit and the arrows slide to the rest. Nothing scrolls sideways on a desktop.
 */
export function Board({ children, columns }: { children: ReactNode; columns: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [per, setPer] = useState(Math.min(columns, 4)); const [first, setFirst] = useState(0);
  const dir = useRef(1);
  useLayout(() => {
    const el = box.current; if (!el) return;
    const size = () => setPer(window.matchMedia(DESKTOP).matches ? Math.max(1, Math.min(columns, Math.floor((el.clientWidth + GAP) / (MIN + GAP)))) : columns);
    size();
    const sizes = new ResizeObserver(size); sizes.observe(el);
    return () => sizes.disconnect();
  }, [columns]);
  const start = Math.max(0, Math.min(first, columns - per));
  // The columns are rendered on the server; the ones outside the window are only hidden.
  useLayout(() => {
    const el = box.current; if (!el) return;
    const cols = Array.from(el.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.tagName === "SECTION");
    cols.forEach((c, i) => { if (i < start || i >= start + per) c.setAttribute("data-off", ""); else c.removeAttribute("data-off"); });
  }, [start, per, children]);
  const shown = useRef(0);
  useLayout(() => {
    if (shown.current === start) return; shown.current = start;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    box.current?.querySelectorAll<HTMLElement>(":scope > section:not([data-off])").forEach((c) => c.animate([{ opacity: 0, transform: `translateX(${dir.current * 18}px)` }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }));
  }, [start]);
  const go = (by: number) => { dir.current = by; setFirst(Math.max(0, Math.min(columns - per, start + by))); };
  return (
    <div ref={box} className={`${styles.fit} ${css.board}`} style={{ "--cols": per } as CSSProperties} data-enter="">
      {children}
      {per < columns ? <>
        <button type="button" className={css.boardNav} data-side="left" onClick={() => go(-1)} disabled={start === 0} aria-label="Earlier stages" title="Earlier stages"><ChevronLeft size={15} aria-hidden="true" /></button>
        <button type="button" className={css.boardNav} data-side="right" onClick={() => go(1)} disabled={start >= columns - per} aria-label="More stages" title="More stages"><ChevronRight size={15} aria-hidden="true" /></button>
      </> : null}
    </div>
  );
}
