"use client";

// SIDEBAR-HOVER: a sidebar group's pages fold open and shut (height and opacity, FOLD_MS, ease-out), and a folded
// rail's icon shows its group's pages beside it. The timing lives in sidebar-hover.ts.

import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { foldMs, itemKey } from "./sidebar-hover";
import navCss from "./nav.module.css";

/** A media query's answer, kept current (false before the page runs in a browser). */
export function useMatch(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(query); const sync = () => setMatches(media.matches); sync();
    media.addEventListener("change", sync); return () => media.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

// useLayoutEffect warns during server rendering; the fold only animates in a browser.
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Shows its children while `open`; it folds open and shut, and keeps them on screen while it folds shut (not
 *  reachable then). The first paint never animates. `instant`: no animation (less motion). */
export function Fold({ open, instant, children }: { open: boolean; instant: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  const box = useRef<HTMLDivElement>(null);
  useBrowserLayoutEffect(() => {
    if (open) {
      setMounted(true);
      // Laid out folded first, so the browser animates from folded to open.
      if (!instant && box.current && !shown) void box.current.getBoundingClientRect();
      setShown(true);
      return;
    }
    setShown(false);
    if (instant) { setMounted(false); return; }
    const t = window.setTimeout(() => setMounted(false), foldMs(instant));
    return () => window.clearTimeout(t);
  }, [open, instant]);
  if (!mounted && !open) return null;
  const state = open && shown ? "open" : "closed";
  return (
    <div ref={box} className={navCss.fold} data-state={state} data-instant={instant ? "" : undefined} aria-hidden={open ? undefined : true} inert={!open}>
      <div className={navCss.foldInner}>{children}</div>
    </div>
  );
}

/** Moves focus between the links of a group or a flyout with ↓ ↑, and sends ← (and Escape in a flyout) to `onHead`. */
export function itemKeys(event: KeyboardEvent<HTMLElement>, inFlyout: boolean, onHead: () => void) {
  const act = itemKey(event.key, inFlyout);
  if (!act || event.altKey || event.ctrlKey || event.metaKey) return;
  const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>("a[href]")];
  const at = links.indexOf(document.activeElement as HTMLAnchorElement);
  if (at < 0) return;
  event.preventDefault();
  if (act === "head") onHead();
  else if (act === "next") links[Math.min(links.length - 1, at + 1)]?.focus();
  else if (at === 0) onHead(); else links[at - 1]?.focus();
}

/** A folded rail's group, beside its icon: the group's name, then its pages. It sits on the page (a portal), so the
 *  rail keeps its own links; the keyboard reaches it from the icon (→, ↓ or Space) and ←, Escape or Tab leave it. */
export function RailFlyout({ id, label, anchor, focusFirst, onFocused, instant, onPointerEnter, onPointerLeave, onFocusIn, onFocusOut, onLeave, children }: {
  id: string; label: string; anchor: HTMLElement | null; focusFirst: boolean; onFocused: () => void; instant: boolean;
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void; onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onFocusIn: () => void; onFocusOut: () => void;
  /** Focus goes back to the icon (←, Escape: `back`) or on past it (Tab: `next`, Shift+Tab: `prev`). */
  onLeave: (to: "back" | "next" | "prev") => void; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useBrowserLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const icon = anchor.getBoundingClientRect();
      const rail = anchor.closest("aside")?.getBoundingClientRect();
      const height = box.current?.offsetHeight ?? 0;
      const top = Math.max(12, Math.min(icon.top - 6, window.innerHeight - 12 - height));
      setAt({ left: Math.round((rail?.right ?? icon.right) + 8), top: Math.round(top) });
    };
    place();
    window.addEventListener("resize", place); return () => window.removeEventListener("resize", place);
  }, [anchor, label]);
  useEffect(() => {
    if (!focusFirst || !at) return;
    box.current?.querySelector<HTMLAnchorElement>("a[href]")?.focus();
    onFocused();
  }, [focusFirst, at]); // eslint-disable-line react-hooks/exhaustive-deps
  if (typeof document === "undefined" || !document.body) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>("a[href]")];
      const i = links.indexOf(document.activeElement as HTMLAnchorElement);
      if (event.shiftKey && i === 0) { event.preventDefault(); onLeave("back"); }
      else if (!event.shiftKey && i === links.length - 1) { event.preventDefault(); onLeave("next"); }
      return;
    }
    itemKeys(event, true, () => onLeave("back"));
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onFocusOut(); };
  return createPortal(
    <div ref={box} id={id} role="group" aria-labelledby={`${id}-name`} className={navCss.flyout} data-instant={instant ? "" : undefined} data-placed={at ? "" : undefined}
      style={at ? { left: at.left, top: at.top } : undefined} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onKeyDown={onKeyDown} onFocus={onFocusIn} onBlur={onBlur}>
      <p id={`${id}-name`} className={navCss.flyoutName}>{label}</p>
      <div className={navCss.flyoutList}>{children}</div>
    </div>,
    document.body,
  );
}
