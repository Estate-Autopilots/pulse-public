"use client";
// TASKS-4A kit: the floating layer under every popover, listbox, menu and tooltip. It renders in place, so a parent
// dialog's focus trap, its Escape handling and React events still see what is inside, but it shows in the browser's top
// layer (`popover="manual"`), so no overflow, transform or z-index of a page can clip it or hide it. Browsers without
// the Popover API get the same box as position: fixed on a high layer. It opens below its anchor and only goes above
// when there is less than `minRoom` px below (the owner: lists open downward); it follows scrolling and resizing.
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type RefObject } from "react";
import css from "./kit.module.css";

export type Placement = "bottom-start" | "bottom-end" | "bottom" | "top-start" | "top-end" | "top" | "right" | "left";
export type FloatOptions = { placement?: Placement; offset?: number; matchWidth?: boolean; minRoom?: number;
  /** Below 600 px wide, show as a sheet along the bottom of the screen instead (calendars, long forms). */ sheet?: boolean };

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const canPop = () => typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

/** Keeps something mounted for its closing animation: `{ mounted, closing }`. */
export function usePresence(open: boolean, ms = 140) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    const t = setTimeout(() => setMounted(false), reduced() ? 0 : ms);
    return () => clearTimeout(t);
  }, [open, mounted, ms]);
  return { mounted: open || mounted, closing: !open && mounted };
}

/** Puts `el` next to `anchor` inside the visible viewport; writes left/top/max-height straight to the element. */
export function placeFloating(el: HTMLElement, anchor: DOMRect, { placement = "bottom-start", offset = 6, matchWidth, minRoom = 220, sheet }: FloatOptions = {}) {
  const vv = typeof visualViewport !== "undefined" && visualViewport ? visualViewport : null;
  const vw = document.documentElement.clientWidth || innerWidth, top0 = vv?.offsetTop ?? 0, vh = (vv?.height ?? innerHeight) + top0, pad = 8;
  if (sheet && vw < 600) {
    el.dataset.sheet = ""; el.dataset.side = "bottom";
    Object.assign(el.style, { left: "0px", top: "auto", bottom: `${Math.max(0, innerHeight - vh)}px`, minWidth: "0px", maxWidth: "none", maxHeight: `${Math.round((vh - top0) * 0.88)}px` });
    return;
  }
  delete el.dataset.sheet; el.style.bottom = "";
  el.style.maxWidth = `${vw - pad * 2}px`;
  if (matchWidth) el.style.minWidth = `${Math.min(anchor.width, vw - pad * 2)}px`;
  el.style.maxHeight = "none";
  const w = el.offsetWidth, h = el.offsetHeight;
  if (placement === "right" || placement === "left") {
    const fits = placement === "right" ? anchor.right + offset + w <= vw - pad : anchor.left - offset - w >= pad;
    const side = fits ? placement : placement === "right" ? "left" : "right";
    el.style.left = `${side === "right" ? anchor.right + offset : anchor.left - offset - w}px`;
    el.style.top = `${Math.round(Math.min(Math.max(top0 + pad, anchor.top + anchor.height / 2 - h / 2), vh - pad - h))}px`;
    el.dataset.side = side; el.style.maxHeight = ""; return;
  }
  const below = vh - anchor.bottom - offset - pad, above = anchor.top - top0 - offset - pad;
  const wantTop = placement.startsWith("top");
  const side = wantTop ? (above >= Math.min(h, minRoom) || above >= below ? "top" : "bottom") : (below >= Math.min(h, minRoom) || below >= above ? "bottom" : "top");
  const room = Math.max(96, side === "bottom" ? below : above), height = Math.min(h, room);
  el.style.maxHeight = h > room ? `${room}px` : "";
  const align = placement.endsWith("-end") ? "end" : placement === "top" || placement === "bottom" ? "center" : "start";
  const x = align === "end" ? anchor.right - w : align === "center" ? anchor.left + anchor.width / 2 - w / 2 : anchor.left;
  el.style.left = `${Math.round(Math.min(Math.max(pad, x), vw - pad - Math.min(w, vw - pad * 2)))}px`;
  el.style.top = `${Math.round(side === "bottom" ? anchor.bottom + offset : anchor.top - offset - height)}px`;
  el.dataset.side = side;
}

/** Keeps a mounted floating element placed against its anchor while the page scrolls, resizes or either one changes size. */
export function useFloating(open: boolean, anchor: RefObject<HTMLElement | null> | (() => HTMLElement | null), float: RefObject<HTMLElement | null>, options: FloatOptions) {
  const { placement, offset, matchWidth, minRoom, sheet } = options;
  const anchorEl = useCallback(() => typeof anchor === "function" ? anchor() : anchor.current, [anchor]);
  useLayoutEffect(() => {
    const el = float.current; if (!open || !el) return;
    let frame = 0;
    const place = () => { const a = anchorEl(); if (a && el.isConnected) placeFloating(el, a.getBoundingClientRect(), { placement, offset, matchWidth, minRoom, sheet }); };
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    place();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(later) : null;
    ro?.observe(el); const a = anchorEl(); if (a) ro?.observe(a);
    addEventListener("scroll", later, { capture: true, passive: true }); addEventListener("resize", later);
    visualViewport?.addEventListener("resize", later);
    return () => { cancelAnimationFrame(frame); ro?.disconnect(); removeEventListener("scroll", later, { capture: true }); removeEventListener("resize", later); visualViewport?.removeEventListener("resize", later); };
  }, [open, anchorEl, float, placement, offset, matchWidth, minRoom, sheet]);
}

/** Calls `onOutside` for a pointer press outside every given element (the anchor toggles itself). */
export function useOutside(open: boolean, refs: RefObject<HTMLElement | null>[], onOutside: () => void) {
  const cb = useRef(onOutside);
  useEffect(() => { cb.current = onOutside; });
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => { const t = e.target as Node; if (!refs.some((r) => r.current?.contains(t))) cb.current(); };
    document.addEventListener("pointerdown", off, true);
    return () => document.removeEventListener("pointerdown", off, true);
    // The refs are stable objects; their elements are read at the time of the press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

type LayerProps = HTMLAttributes<HTMLDivElement> & { closing?: boolean; tone?: "panel" | "tip" | "bare"; style?: CSSProperties };
/** The element itself: shown in the top layer when mounted, animated in and (with `closing`) out. */
export const Layer = forwardRef<HTMLDivElement, LayerProps>(function Layer({ closing, tone = "panel", className, children, ...rest }, ref) {
  const own = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = own.current; if (!el || !canPop()) return;
    try { if (!el.matches(":popover-open")) el.showPopover(); } catch { /* already shown, or detached */ }
  }, []);
  const set = (el: HTMLDivElement | null) => { own.current = el; if (typeof ref === "function") ref(el); else if (ref) ref.current = el; };
  return <div ref={set} popover="manual" className={`${css.layer} ${tone === "panel" ? css.panel : tone === "tip" ? css.tip : ""}${className ? ` ${className}` : ""}`} data-closing={closing ? "" : undefined} {...rest}>{children}</div>;
});

/** Moves focus into `root` (its first focusable, or `first`) and gives it back to whatever had it, on close. */
export function useFocusInside(open: boolean, root: RefObject<HTMLElement | null>, how: "first" | "none" | RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open || how === "none") return;
    const before = document.activeElement as HTMLElement | null, rootEl = root.current;
    const t = requestAnimationFrame(() => {
      const target = typeof how === "object" ? how.current : root.current?.querySelector<HTMLElement>('[data-autofocus], button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])');
      target?.focus({ preventScroll: true });
    });
    return () => { cancelAnimationFrame(t); if (rootEl?.contains(document.activeElement) || document.activeElement === document.body) before?.focus?.({ preventScroll: true }); };
    // `how` is read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
