"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import css from "./fit.module.css";
import ui from "./ui.module.css";

const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const layered = () => !!document.querySelector('[aria-modal="true"]');

/**
 * UX-POLISH-2 (owner, 6 Nov 2026: "while scrolling the page only one line is used"): a list region shows every row and
 * scrolls. It used to show only what fitted one window and page through the rest ("1–9 of 32", "1 / 7" in a card),
 * which left most of a big screen empty and hid nearly everything behind arrows. Now:
 *   - on a computer, inside a page that fits the window, the region takes the height it is given and scrolls on its
 *     own, so the page's header, tabs and filters stay in view above it;
 *   - anywhere else (a page that scrolls, a phone) it is as tall as its rows and the page scrolls.
 * The props stay so every caller keeps working; the paging ones (mobile, min, stretch, compact) no longer page.
 */
export function Pager({ children, className, style, unit, label, primary }: {
  children: ReactNode; className?: string; style?: CSSProperties; unit?: string; mobile?: number; min?: number;
  /** The page's main list. */ primary?: boolean;
  stretch?: boolean; compact?: boolean; label?: string;
}) {
  const view = useRef<HTMLDivElement>(null);
  const [total, setTotal] = useState(0);
  // How many rows the region holds (tests and the scroll hint read it); counted once the rows are in.
  useEffect(() => {
    const v = view.current; if (!v) return;
    const countRows = () => { const boxes = v.querySelectorAll(":scope [data-items], :scope ul, :scope ol, :scope tbody"); setTotal(boxes[0]?.children.length ?? 0); };
    countRows();
    const changes = new MutationObserver(countRows); changes.observe(v, { childList: true, subtree: true });
    return () => changes.disconnect();
  }, []);
  return (
    <div data-pager="" data-scroll="" className={`${css.pager}${className ? ` ${className}` : ""}`} style={style} data-total={total} data-primary={primary ? "" : undefined}>
      <div ref={view} data-pager-view="" data-ready="" className={css.view} tabIndex={-1} aria-label={label ?? unit}>{children}</div>
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
