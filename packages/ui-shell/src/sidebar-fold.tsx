"use client";

// SIDEBAR-HOVER: a sidebar group's pages fold open and shut (height and opacity, FOLD_MS, ease-out), and a folded
// rail's icon shows its group's pages beside it. The timing lives in sidebar-hover.ts.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { flyoutPlace, foldMs, itemKey } from "./sidebar-hover";
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

/** A rail icon's group, beside its icon: the group's name, then its pages. It sits on the page (a portal), so the
 *  rail keeps its own links; the keyboard reaches it from the icon (→, ↓ or Space) and ←, Escape or Tab leave it.
 *  NAV-CONNECT: it shows with the sidebar open too, over the sidebar, level with the icon (flyoutPlace) with a pointer
 *  at the icon, and it follows its own height (a dot or a page arriving) and the window's. */
export function RailFlyout({ id, label, icon, count, compact = false, bare = false, anchor, focusFirst, onFocused, instant, onPointerEnter, onPointerLeave, onFocusIn, onFocusOut, onLeave, children }: {
  id: string; label: string; icon?: ReactNode; count?: number; /** Rows without a second line: shorter rows. */ compact?: boolean; /** One page: no header, the one row says the group. */ bare?: boolean; anchor: HTMLElement | null; focusFirst: boolean; onFocused: () => void; instant: boolean;
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void; onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onFocusIn: () => void; onFocusOut: () => void;
  /** Focus goes back to the icon (←, Escape: `back`) or on past it (Tab: `next`, Shift+Tab: `prev`). */
  onLeave: (to: "back" | "next" | "prev") => void; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; arrow: number } | null>(null);
  useBrowserLayoutEffect(() => {
    if (!anchor) return;
    // The rail's own right edge (#pulse-rail), not the sidebar's: with the sidebar open the flyout lies over it, next to
    // the icon the pointer is on.
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const rail = (anchor.closest("#pulse-rail") ?? anchor.closest("aside"))?.getBoundingClientRect();
      const next = flyoutPlace(r, rail?.right ?? r.right, window.innerHeight, box.current?.offsetHeight ?? 0);
      setAt((was) => was && was.left === next.left && was.top === next.top && was.arrow === next.arrow ? was : next);
    };
    place();
    const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (box.current) sized?.observe(box.current);
    window.addEventListener("resize", place);
    return () => { sized?.disconnect(); window.removeEventListener("resize", place); };
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
  return createPortal(<>
    {at ? <i className={navCss.flyoutScrim} style={{ left: at.left - 10 }} aria-hidden="true" data-flyout-scrim="" /> : null}
    <div ref={box} id={id} role="group" aria-labelledby={`${id}-name`} className={navCss.flyout} data-instant={instant ? "" : undefined} data-placed={at ? "" : undefined} data-bare={bare ? "" : undefined}
      style={at ? { left: at.left, top: at.top, "--flyout-arrow": `${at.arrow}px` } as CSSProperties : undefined} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onKeyDown={onKeyDown} onFocus={onFocusIn} onBlur={onBlur}>
      <i className={navCss.flyoutArrow} aria-hidden="true" />
      <div className={navCss.flyoutHead} hidden={bare}>
        {icon ? <span className={navCss.flyoutMark} aria-hidden="true">{icon}</span> : null}
        <p id={`${id}-name`} className={navCss.flyoutName}>{label}</p>
        {count ? <span className={navCss.flyoutNew}>{count > 9 ? "9+" : count} new</span> : null}
      </div>
      <div className={navCss.flyoutList} data-compact={compact ? "" : undefined}>{children}</div>
    </div></>,
    document.body,
  );
}
