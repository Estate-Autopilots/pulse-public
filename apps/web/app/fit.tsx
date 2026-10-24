"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import css from "./fit.module.css";
import ui from "./ui.module.css";

/** A desktop window shows one viewport; anything narrower or shorter is a phone or tablet and may scroll. */
const DESKTOP = "(min-width: 1180px) and (min-height: 600px)";
const useLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const layered = () => !!document.querySelector('[aria-modal="true"]');

/** The lists a pager turns: those marked `data-items`, otherwise every list and table body directly inside it. */
function itemBoxes(view: HTMLElement): HTMLElement[] {
  const own = (el: HTMLElement) => el.closest("[data-pager-view]") === view;
  const marked = Array.from(view.querySelectorAll<HTMLElement>("[data-items]")).filter(own);
  if (marked.length) return marked;
  const selector = 'ul, ol, tbody, dl[class*="__facts"]';
  return Array.from(view.querySelectorAll<HTMLElement>(selector)).filter((el) => own(el) && el.children.length > 0 && !el.parentElement?.closest(selector)?.closest("[data-pager-view]")?.isSameNode(view));
}
/** A heading that belongs to a list (a sub-head right above it) comes and goes with the list's rows. */
const headOf = (box: HTMLElement) => { const prev = box.previousElementSibling; return prev instanceof HTMLElement && (prev.hasAttribute("data-pager-head") || /__(subhead|groupHead)/.test(prev.className)) ? prev : null; };

type State = { page: number; starts: number[]; total: number };

/**
 * Shows as many rows or cards as fit the height it is given and pages through the rest: arrows, "1–12 of 274",
 * page dots, ← → and the wheel. Nothing inside ever scrolls. On a phone it pages by a fixed count instead.
 */
export function Pager({ children, className, style, unit, mobile = 10, primary, stretch, compact, label, min = 6 }: {
  children: ReactNode; className?: string; style?: CSSProperties; unit?: string; mobile?: number;
  /** A page of a longer list shows at least this many items; fewer is a layout bug (flagged as `data-cramped`). */ min?: number;
  /** The page's main list: ← → turn it from anywhere on the page. */ primary?: boolean;
  /** Card grids: rows grow to share the height, so a page ends flush with the bar. */ stretch?: boolean;
  compact?: boolean; label?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<State>({ page: 0, starts: [0], total: 0 });
  const at = useRef({ first: 0, dir: 1, wheel: 0, turned: 0 });
  // The <details> someone last opened inside a row ("Decide" on an HR approval): while it stays open, its row stays in
  // view even when it grows past the page, instead of moving to the next, hidden page.
  const opened = useRef<HTMLDetailsElement | null>(null);

  const measure = useCallback(() => {
    const v = view.current, r = root.current; if (!v || !r) return;
    // Owner workbench UI (stability): until the first measure (a big list still hydrating) the view clips instead of
    // showing a scroll bar that disappears once the rows are paged.
    if (!v.hasAttribute("data-ready")) v.setAttribute("data-ready", "");
    const boxes = itemBoxes(v); const box = boxes[0];
    const items = boxes.flatMap((b) => Array.from(b.children).filter((el): el is HTMLElement => el instanceof HTMLElement && !el.hasAttribute("data-pager-skip") && !(b.tagName === "DL" && el.tagName === "DD")));
    for (const el of items) { el.removeAttribute("data-page-hidden"); if (el.tagName === "DT") el.nextElementSibling?.removeAttribute("data-page-hidden"); }
    for (const b of boxes) { b.removeAttribute("data-page-hidden"); headOf(b)?.removeAttribute("data-page-hidden"); }
    if (box && stretch) box.style.gridAutoRows = "";
    let starts = [0];
    if (box && items.length > 1) {
      if (window.matchMedia(DESKTOP).matches) {
        const fit = () => {
          const top = v.getBoundingClientRect().top;
          // A list's first row carries its heading: the two stay on the same page.
          const rects = items.map((el) => { const x = el.getBoundingClientRect(); const head = el === el.parentElement?.firstElementChild ? headOf(el.parentElement as HTMLElement) : null; return { top: head ? Math.min(x.top, head.getBoundingClientRect().top) : x.top, bottom: el.tagName === "DT" ? Math.max(x.bottom, el.nextElementSibling?.getBoundingClientRect().bottom ?? 0) : x.bottom }; });
          const lead = rects[0].top - top;
          const trail = Math.max(0, (end.current?.getBoundingClientRect().top ?? 0) - Math.max(...rects.map((x) => x.bottom)));
          const room = v.clientHeight - lead - trail;
          const out = [0];
          rects.forEach((x, i) => { const s = rects[out[out.length - 1]]; if (x.top > s.top + 1 && x.bottom - s.top > room + 0.5) out.push(i); });
          return { out, room, rects };
        };
        // The bar appears once there is a second page; the view then shrinks and this runs again.
        const got = fit();
        starts = got.out;
        if (stretch && starts.length > 1) {
          const rows = new Set(got.rects.slice(0, starts[1]).map((x) => Math.round(x.top))).size;
          const gap = parseFloat(getComputedStyle(box).rowGap) || 0;
          box.style.gridAutoRows = `${Math.floor((got.room - gap * (rows - 1)) / rows)}px`;
        }
      } else if (items.length > mobile) {
        starts = []; for (let i = 0; i < items.length; i += mobile) starts.push(i);
      }
    }
    let page = 0; for (let i = 0; i < starts.length; i++) if (starts[i] <= at.current.first) page = i;
    const o = opened.current; const keep = o?.open ? items.findIndex((el) => el.contains(o)) : -1;
    if (keep >= 0 && (keep < starts[page] || keep >= (starts[page + 1] ?? items.length))) {
      page = 0; for (let i = 0; i < starts.length; i++) if (starts[i] <= keep) page = i;
      at.current.first = starts[page];
    }
    const from = starts[page], to = starts[page + 1] ?? items.length;
    items.forEach((el, i) => { if (i < from || i >= to) { el.setAttribute("data-page-hidden", ""); if (el.tagName === "DT") el.nextElementSibling?.setAttribute("data-page-hidden", ""); } });
    if (boxes.length > 1) for (const b of boxes) if (!Array.from(b.children).some((el) => !el.hasAttribute("data-page-hidden"))) { b.setAttribute("data-page-hidden", ""); headOf(b)?.setAttribute("data-page-hidden", ""); }
    setState((s) => s.page === page && s.total === items.length && s.starts.length === starts.length && s.starts.every((x, i) => x === starts[i]) ? s : { page, starts, total: items.length });
  }, [mobile, stretch]);

  useLayout(() => {
    const v = view.current; if (!v) return;
    let frame = 0, settle = 0;
    const later = () => { window.clearTimeout(settle); cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    // Owner workbench UI (stability): rows streaming in are measured once they settle, not on every frame (each measure
    // lays out every row; on Clients and Projects that ran for seconds after the page opened).
    const settled = () => { window.clearTimeout(settle); settle = window.setTimeout(later, 120); };
    measure();
    const sizes = new ResizeObserver(later); sizes.observe(v);
    // Rows added or removed, and a <details> opened or closed inside a row, change what fits.
    const changes = new MutationObserver((records) => {
      let toggled = false;
      for (const r of records) if (r.attributeName === "open" && r.target instanceof HTMLDetailsElement) { toggled = true; opened.current = r.target.open ? r.target : opened.current === r.target ? null : opened.current; }
      if (toggled) later(); else settled();
    });
    changes.observe(v, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    const media = window.matchMedia(DESKTOP); media.addEventListener("change", later);
    void document.fonts?.ready.then(later);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(settle); sizes.disconnect(); changes.disconnect(); media.removeEventListener("change", later); };
  }, [measure]);

  const pages = state.starts.length;
  const go = useCallback((next: number) => {
    opened.current = null; // turning the page is the person's choice; it no longer follows an open row
    setState((s) => {
      const page = Math.max(0, Math.min(s.starts.length - 1, next)); if (page === s.page) return s;
      at.current.dir = page > s.page ? 1 : -1; at.current.first = s.starts[page];
      return { ...s, page };
    });
  }, []);
  // Turning a page only hides and shows rows that are already there, then slides the new ones in.
  const shown = useRef(0);
  useLayout(() => {
    if (shown.current === state.page) return; shown.current = state.page;
    measure();
    const turned = view.current ? itemBoxes(view.current) : [];
    const box = turned.length === 1 ? turned[0] : view.current;
    if (box && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      box.animate([{ opacity: 0, transform: `translateX(${at.current.dir * 18}px)` }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    }
  }, [state.page, measure]);

  useEffect(() => {
    if (!primary || pages < 2) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || layered()) return;
      if (event.target instanceof HTMLElement && event.target.closest('[role="tablist"], [data-pager]')) return;
      if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); go(shown.current + 1); }
      if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); go(shown.current - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [primary, pages, go]);
  // The wheel and a two-finger swipe turn pages; there is nothing to scroll.
  useEffect(() => {
    const r = root.current; if (!r || pages < 2) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || !window.matchMedia(DESKTOP).matches) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const now = Date.now(); const a = at.current;
      if (now - a.turned < 320) { a.wheel = 0; return; }
      a.wheel += delta;
      if (Math.abs(a.wheel) > 48) { a.turned = now; go(shown.current + (a.wheel > 0 ? 1 : -1)); a.wheel = 0; }
    };
    r.addEventListener("wheel", onWheel, { passive: true });
    return () => r.removeEventListener("wheel", onWheel);
  }, [pages, go]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (pages < 2 || typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLElement && event.target.closest("[data-pager]") !== root.current) return;
    if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); event.stopPropagation(); go(state.page + 1); }
    else if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); event.stopPropagation(); go(state.page - 1); }
    else if (event.key === "Home") { event.preventDefault(); go(0); }
    else if (event.key === "End") { event.preventDefault(); go(pages - 1); }
  };
  const from = state.starts[state.page] ?? 0, to = state.starts[state.page + 1] ?? state.total;
  const name = label ?? unit ?? "items";
  const firstPage = pages > 1 ? (state.starts[1] ?? state.total) : state.total;
  return (
    <div ref={root} data-pager="" className={`${css.pager}${className ? ` ${className}` : ""}`} style={style} data-compact={compact ? "" : undefined} data-total={state.total} data-shown={firstPage} data-cramped={pages > 1 && firstPage < Math.min(min, state.total) ? "" : undefined} onKeyDown={onKeyDown} onInvalidCapture={(event) => {
      const v = view.current; if (!v || !(event.target instanceof HTMLElement)) return;
      const items = itemBoxes(v).flatMap((box) => Array.from(box.children));
      const i = items.findIndex((el) => el.contains(event.target as HTMLElement));
      if (i < 0) return;
      const page = state.starts.findLastIndex((start) => start <= i);
      at.current.first = state.starts[page];
      go(page); measure();
      requestAnimationFrame(() => (event.target as HTMLElement).focus());
    }}>
      <div ref={view} data-pager-view="" className={css.view}>{children}<span ref={end} className={css.end} aria-hidden="true" /></div>
      {pages > 1 ? (
        <div className={css.bar} role="group" aria-label={`Pages of ${name}`}>
          <button type="button" className={css.arrow} onClick={() => go(state.page - 1)} disabled={state.page === 0} aria-label="Previous page" title="Previous (←)"><ChevronLeft size={15} aria-hidden="true" /></button>
          {pages <= 9 && !compact ? <span className={css.dots}>{state.starts.map((_, i) => <button key={i} type="button" className={css.dot} aria-label={`Page ${i + 1}`} aria-current={i === state.page ? "true" : undefined} onClick={() => go(i)} />)}</span> : null}
          <span className={css.count} aria-live="polite">{compact ? <>{state.page + 1} / {pages}</> : <><b>{from + 1}–{to}</b> of {state.total.toLocaleString("en-IN")}{unit ? ` ${unit}` : ""}</>}</span>
          <button type="button" className={css.arrow} onClick={() => go(state.page + 1)} disabled={state.page === pages - 1} aria-label="Next page" title="Next (→)"><ChevronRight size={15} aria-hidden="true" /></button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * App-wide feel, mounted once: the pressed segment and the current tab are marked by one indicator that glides
 * between them; ← → move along tabs and 1–9 open them; "/" goes to the page's search; a new page or tab eases in.
 */
export function AppFeel() {
  const pathname = usePathname();
  const tab = useSearchParams().toString();
  // Text cut short with an ellipsis carries its full text as a tooltip, wherever it is (names, file titles, notes).
  useEffect(() => {
    const label = (el: HTMLElement) => {
      if (el.title || el.closest("[title]") || el.getAttribute("aria-label") || (el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 2)) return;
      // Owner workbench UI: only text React has already hydrated; a title added to a streamed row before React claims it
      // was a hydration mismatch (Chats' recent chats, every visit). The pass after it, or the hover, labels it then.
      if (!Object.keys(el).some((k) => k.startsWith("__reactFiber"))) return;
      const c = getComputedStyle(el);
      if (c.textOverflow !== "ellipsis" && !(c.webkitLineClamp && c.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 2)) return;
      const text = el.textContent?.trim(); if (text) el.title = text;
    };
    // Owner workbench UI (stability): labelled when the pointer or focus reaches it, which is when a tooltip shows. The
    // page-wide pass after every DOM change measured every element of the page (and still raced hydration on streamed
    // rows: React's "attributes didn't match" on Finance, Projects, Clients and Max).
    const over = (event: Event) => { if (event.target instanceof HTMLElement) label(event.target); };
    document.addEventListener("pointerover", over, { passive: true });
    document.addEventListener("focusin", over);
    return () => { document.removeEventListener("pointerover", over); document.removeEventListener("focusin", over); };
  }, []);
  useEffect(() => {
    // Group roots suppress hydration warnings for these effect-owned decorations: a streamed sibling
    // can still be hydrating when this effect first positions the indicator.
    const groups = '[class*="__segmented"], [class*="__tabs"]';
    // A row of tabs wider than the screen scrolls sideways: the edge where it continues fades out, and the current
    // tab is brought into view, so nothing looks cut off and every tab is reachable.
    // Owner workbench UI (stability): only rows React has already hydrated are decorated; a data-more or data-glide
    // added to a streamed row before React claimed it was a hydration mismatch (Work's "Whose tasks" on a phone).
    const hydrated = (el: HTMLElement) => Object.keys(el).some((k) => k.startsWith("__reactFiber"));
    const edges = (el: HTMLElement) => {
      if (!hydrated(el)) return;
      const more = el.scrollWidth - el.clientWidth > 2;
      const start = more && el.scrollLeft > 2, end = more && el.scrollLeft < el.scrollWidth - el.clientWidth - 2;
      const value = start && end ? "both" : start ? "start" : end ? "end" : null;
      if (value) el.setAttribute("data-more", value); else el.removeAttribute("data-more");
    };
    const scrollers = `${groups}, [class*="__filters"], [class*="__chips"], [data-hscroll]`;
    const scrolled = (event: Event) => { const el = event.target; if (el instanceof HTMLElement && el.matches(scrollers)) edges(el); };
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    const place = () => {
      document.querySelectorAll<HTMLElement>(scrollers).forEach((el) => { if (!el.matches(groups)) edges(el); });
      document.querySelectorAll<HTMLElement>(groups).forEach((el) => {
        if (!hydrated(el)) return;
        const on = el.querySelector<HTMLElement>(':scope > [aria-current], :scope > [aria-pressed="true"], :scope > [aria-selected="true"]');
        if (on && el.scrollWidth > el.clientWidth + 2 && el.dataset.shown !== on.textContent) {
          el.dataset.shown = on.textContent ?? "";
          const left = on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2;
          if (left > 0 || el.scrollLeft > 0) el.scrollTo({ left: Math.max(0, left), behavior: "instant" as ScrollBehavior });
        }
        edges(el);
        if (!on || !on.offsetWidth) { el.removeAttribute("data-glide"); return; }
        // Written only when it moved: every DOM change anywhere re-runs this, and rewriting the same values restyled each row.
        const gx = `${on.offsetLeft}px`, gw = `${on.offsetWidth}px`;
        if (el.style.getPropertyValue("--gx") !== gx) el.style.setProperty("--gx", gx);
        if (el.style.getPropertyValue("--gw") !== gw) { el.style.setProperty("--gw", gw); el.style.setProperty("--gs", String(on.offsetWidth / 100)); }
        if (!el.hasAttribute("data-glide")) { el.setAttribute("data-glide", "new"); requestAnimationFrame(() => el.setAttribute("data-glide", "on")); }
      });
    };
    let frame = 0;
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    place();
    const changes = new MutationObserver(later);
    changes.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current", "aria-pressed", "aria-selected"] });
    window.addEventListener("resize", later);
    void document.fonts?.ready.then(later);
    const settle = [1500, 4000].map((ms) => window.setTimeout(later, ms)); // rows that hydrate after the first pass
    const tabsOf = () => Array.from(document.querySelectorAll<HTMLElement>('main [class*="__tabs"]')).find((el) => el.offsetParent) ?? null;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const group = target?.closest<HTMLElement>(groups);
      if (group && target && target.parentElement === group && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
        const all = Array.from(group.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.matches("a, button:not(:disabled)"));
        const next = all[(all.indexOf(target) + (event.key === "ArrowRight" ? 1 : -1) + all.length) % all.length];
        if (next) { event.preventDefault(); next.focus(); if (group.matches('[class*="__tabs"]')) next.click(); }
        return;
      }
      if (typing(target) || layered()) return;
      if (/^[1-9]$/.test(event.key)) {
        const item = tabsOf()?.querySelectorAll<HTMLElement>(":scope > a, :scope > button")[Number(event.key) - 1];
        if (item) { event.preventDefault(); item.click(); }
      } else if (event.key === "/") {
        const search = document.querySelector<HTMLInputElement>('main input[type="search"]');
        if (search) { event.preventDefault(); search.focus(); search.select(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { cancelAnimationFrame(frame); settle.forEach((t) => window.clearTimeout(t)); changes.disconnect(); window.removeEventListener("resize", later); window.removeEventListener("keydown", onKey); document.removeEventListener("scroll", scrolled, { capture: true }); };
  }, []);
  // A new page or tab eases in; the header and the tab bar stay still.
  const seen = useRef("");
  useEffect(() => {
    const key = `${pathname}?${tab}`; const first = !seen.current; const before = seen.current.split("?")[0]; seen.current = key;
    if (first || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const samePage = before === pathname;
    document.querySelectorAll<HTMLElement>("main [data-enter]").forEach((el) => {
      el.animate([{ opacity: 0, transform: samePage ? "translateY(6px)" : "translateY(10px) scale(0.995)" }, { opacity: 1, transform: "none" }], { duration: samePage ? 240 : 320, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    });
  }, [pathname, tab]);
  return null;
}

/**
 * Rows of panels that sit together when the window is tall enough and become views of their own when it is not,
 * so nothing is squeezed to fit. `tall` is the height (px) of the whole deck (head, top and every row at its
 * minimum). Decided by a container query, so the first paint is already right. Phones stack every row and scroll.
 * `head` (usually the page tabs) shares its row with the switch; `top` (e.g. key numbers) stays above every view.
 */
export function Deck({ views, tall = 720, param = "part", head, top }: { views: { label: string; content: ReactNode }[]; tall?: 560 | 640 | 720 | 800 | 880 | 960 | 1040; param?: string; head?: ReactNode; top?: ReactNode }) {
  const search = useSearchParams(); const pathname = usePathname();
  const requested = search.get(param); const at = Math.max(0, views.findIndex((x) => x.label === requested));
  const choose = (i: number) => { const q = new URLSearchParams(search.toString()); q.set(param, views[i].label); history.replaceState(null, "", `${pathname}?${q}`); };
  return (
    <div className={css.deck} data-tall={tall} data-grow="">
      <div className={css.deckInner}>
        <div className={css.deckHead}>
          {head}
          <nav className={`${ui.segmented} ${css.deckSwitch}`} aria-label="Parts of this view" suppressHydrationWarning>
            {views.map((v, i) => <button key={v.label} type="button" className={ui.segment} aria-pressed={i === at} onClick={() => choose(i)}>{v.label}</button>)}
          </nav>
        </div>
        {top}
        {views.map((v, i) => <div key={v.label} className={css.deckView} data-on={i === at ? "" : undefined} data-enter="">{v.content}</div>)}
      </div>
    </div>
  );
}
