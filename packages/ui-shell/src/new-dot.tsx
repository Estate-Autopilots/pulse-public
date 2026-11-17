"use client";
// NEW-DOTS: one red "new" dot. It pops in with one gentle pulse, then sits still; when the person has looked, it shrinks
// away with a short fade instead of vanishing. prefers-reduced-motion: no pulse, no shrink (new-dot.module.css).
import { useEffect, useState, type ReactNode } from "react";
import { countText, NEW_DOTS_EVENT, NEW_LABEL, NO_DOTS, dotsFrom, type NewDots } from "./new-dots";
import styles from "./new-dot.module.css";

const LEAVE_MS = 460;

/** `place`: "corner" sits on an icon's corner (the rail, the phone's tabs, the More sheet, the avatar), "inline" ends a
 *  row (the panel's pages and sub-pages, a menu item), "after" follows a word. `count` shows a number in it (What's new).
 *  An <i>, like the rail's other badges: the rows style their own <span>s. */
export function NewDot({ on, place = "inline", count }: { on: boolean; place?: "corner" | "inline" | "after"; count?: number }): ReactNode {
  // Shown while on, and for a moment after it goes off (the leaving animation); adjusted while rendering, not in an effect.
  const [shown, setShown] = useState(on);
  const [was, setWas] = useState(on);
  if (on !== was) { setWas(on); if (on) setShown(true); }
  const leaving = shown && !on;
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setShown(false), LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);
  if (!shown) return null;
  const number = count && count > 0 ? countText(count) : null;
  return <i className={styles.dot} data-place={place} data-count={number ? "" : undefined} data-leaving={leaving ? "" : undefined}
    data-new-dot="" role={leaving ? undefined : "img"} aria-label={leaving ? undefined : number ? `${NEW_LABEL}: ${number}` : NEW_LABEL} aria-hidden={leaving ? true : undefined}>{number}</i>;
}

/** The person's dots as the app last sent them (window event NEW_DOTS_EVENT). */
export function useNewDots(): NewDots {
  const [dots, setDots] = useState<NewDots>(NO_DOTS);
  useEffect(() => {
    const changed = (event: Event) => setDots(dotsFrom((event as CustomEvent).detail));
    window.addEventListener(NEW_DOTS_EVENT, changed);
    // The app may have sent its list before the shell listened (it keeps the last one on window).
    const last = (window as unknown as { __pulseNewDots?: unknown }).__pulseNewDots;
    if (last) setDots(dotsFrom(last));
    return () => window.removeEventListener(NEW_DOTS_EVENT, changed);
  }, []);
  return dots;
}
