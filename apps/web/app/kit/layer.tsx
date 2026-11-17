"use client";
// TASKS-4A kit: the floating layer under every popover, listbox, menu and tooltip. It renders in place, so a parent
// dialog's focus trap, its Escape handling and React events still see what is inside, but it shows in the browser's top
// layer (`popover="manual"`), so no overflow, transform or z-index of a page can clip it or hide it. Browsers without
// the Popover API get the same box as position: fixed on a high layer. It opens below its anchor when it fits there and
// otherwise on the side with more room, never taller than the window (it scrolls inside); it follows scrolling and
// resizing. A wheel or finger over it scrolls it, never the page behind (DROPDOWNS, 4 Nov 2026).
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
export function placeFloating(el: HTMLElement, anchor: DOMRect, { placement = "bottom-start", offset = 6, matchWidth, minRoom, sheet }: FloatOptions = {}) {
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
  // DROPDOWNS (4 Nov 2026): the full height is read from scrollHeight, never by lifting max-height. Lifting it clamped
  // the list's scrollTop to 0 on every re-placement, and the list re-placed on its own scroll events: a wheel, trackpad
  // or arrow key moved the list and it jumped straight back to the top (owner, Billing → New document → Package).
  const w = el.offsetWidth, h = el.scrollHeight + (el.offsetHeight - el.clientHeight);
  const fitV = (height: number, top: number) => Math.round(Math.min(Math.max(top0 + pad, top), Math.max(top0 + pad, vh - pad - height)));
  if (placement === "right" || placement === "left") {
    const fits = placement === "right" ? anchor.right + offset + w <= vw - pad : anchor.left - offset - w >= pad;
    const side = fits ? placement : placement === "right" ? "left" : "right";
    const room = Math.max(0, vh - top0 - pad * 2), height = Math.min(h, room);
    el.style.maxHeight = h > room ? `${room}px` : "";
    el.style.left = `${side === "right" ? anchor.right + offset : anchor.left - offset - w}px`;
    el.style.top = `${fitV(height, anchor.top + anchor.height / 2 - height / 2)}px`;
    el.dataset.side = side; return;
  }
  const below = vh - anchor.bottom - offset - pad, above = anchor.top - top0 - offset - pad;
  // The asked-for side when the whole list fits there; otherwise the side with more room (so a long list near the
  // bottom of the window opens upward instead of running off it). `minRoom` keeps short popovers (tips, hints) on their
  // side while at least that much room is left there.
  const wantTop = placement.startsWith("top");
  const mine = wantTop ? above : below, other = wantTop ? below : above;
  const keep = mine >= h || mine >= other || (minRoom !== undefined && mine >= Math.min(h, minRoom));
  const side = keep === wantTop ? "top" : "bottom";
  // Never taller than the window: with almost no room on either side the list still fits, over the anchor if it must.
  const room = Math.max(Math.min(96, vh - top0 - pad * 2), side === "bottom" ? below : above), height = Math.min(h, room);
  el.style.maxHeight = h > room ? `${Math.floor(room)}px` : "";
  const align = placement.endsWith("-end") ? "end" : placement === "top" || placement === "bottom" ? "center" : "start";
  const x = align === "end" ? anchor.right - w : align === "center" ? anchor.left + anchor.width / 2 - w / 2 : anchor.left;
  el.style.left = `${Math.round(Math.min(Math.max(pad, x), vw - pad - Math.min(w, vw - pad * 2)))}px`;
  el.style.top = `${fitV(height, side === "bottom" ? anchor.bottom + offset : anchor.top - offset - height)}px`;
  el.dataset.side = side;
}

/** The element inside `root` (or `root` itself) that scrolls vertically and holds `from`. */
function scrollerIn(root: HTMLElement, from: EventTarget | null) {
  for (let n = from instanceof Element ? from : null; n && root.contains(n); n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return n as HTMLElement;
    if (n === root) break;
  }
  return null;
}

/** Brings `item` into view inside the floating element's own scroller only: never the page behind it (scrollIntoView
 *  also scrolls every scrolling ancestor of the in-place layer), and never under a sticky search field at its top. */
export function revealInLayer(item: HTMLElement | null) {
  const root = item?.closest<HTMLElement>("[data-layer]"); if (!item || !root) return;
  reveal(root, item);
  // Once more when the opening animation ends (the list may still be settling its size and scale).
  for (const a of root.getAnimations?.() ?? []) a.finished.then(() => { if (item.isConnected) reveal(root, item); }).catch(() => undefined);
}
function reveal(root: HTMLElement, item: HTMLElement) {
  const box = scrollerIn(root, item); if (!box) return;
  let sticky = 0;
  for (const c of box.children) { const s = getComputedStyle(c); if (s.position === "sticky" && c !== item && !c.contains(item)) sticky += (c as HTMLElement).offsetHeight; }
  // While the layer animates in it is scaled (layerIn): rects are divided back to layout pixels, or a far option lands
  // a few per cent short of the view.
  const b = box.getBoundingClientRect(), r = item.getBoundingClientRect(), m = 4, k = box.offsetHeight ? b.height / box.offsetHeight || 1 : 1;
  const top = (r.top - b.top) / k - box.clientTop, bottom = (r.bottom - b.top) / k - box.clientTop;
  if (top < sticky + m) box.scrollTop += top - sticky - m;
  else if (bottom > box.clientHeight - m) box.scrollTop += bottom - box.clientHeight + m;
}

/** A wheel or a finger over the floating element scrolls it and only it: at its ends, or when it does not scroll at
 *  all, the page behind it stays where it is (the layer renders in place, so the page's scroller is its ancestor and
 *  would otherwise take the scroll). */
function useContainScroll(open: boolean, float: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = float.current; if (!open || !el) return;
    const blocked = (target: EventTarget | null, dy: number) => {
      if (!dy) return false;
      const box = scrollerIn(el, target); if (!box) return true;
      return dy < 0 ? box.scrollTop <= 0 : box.scrollTop + box.clientHeight >= box.scrollHeight - 1;
    };
    const wheel = (e: WheelEvent) => { if (e.ctrlKey) return; const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; if (Math.abs(dy) >= Math.abs(e.deltaX) && blocked(e.target, dy)) e.preventDefault(); };
    let y = 0;
    const start = (e: TouchEvent) => { y = e.touches[0]?.clientY ?? 0; };
    const move = (e: TouchEvent) => { const now = e.touches[0]?.clientY ?? y, dy = y - now; y = now; if (e.cancelable && blocked(e.target, dy)) e.preventDefault(); };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("touchstart", start, { passive: true }); el.addEventListener("touchmove", move, { passive: false });
    return () => { el.removeEventListener("wheel", wheel); el.removeEventListener("touchstart", start); el.removeEventListener("touchmove", move); };
  }, [open, float]);
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
    // The page (or a scroller holding the anchor) moving re-places it; the floating element's own scrolling does not.
    const scrolled = (e: Event) => { if (!(e.target instanceof Node && el.contains(e.target))) later(); };
    place();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(later) : null;
    ro?.observe(el); const a = anchorEl(); if (a) ro?.observe(a);
    addEventListener("scroll", scrolled, { capture: true, passive: true }); addEventListener("resize", later);
    visualViewport?.addEventListener("resize", later);
    return () => { cancelAnimationFrame(frame); ro?.disconnect(); removeEventListener("scroll", scrolled, { capture: true }); removeEventListener("resize", later); visualViewport?.removeEventListener("resize", later); };
  }, [open, anchorEl, float, placement, offset, matchWidth, minRoom, sheet]);
  useContainScroll(open, float);
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
  return <div ref={set} popover="manual" data-layer="" className={`${css.layer} ${tone === "panel" ? css.panel : tone === "tip" ? css.tip : ""}${className ? ` ${className}` : ""}`} data-closing={closing ? "" : undefined} {...rest}>{children}</div>;
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
