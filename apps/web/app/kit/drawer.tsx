"use client";
// UX-5A kit: the one Drawer. Every right-side panel in the app (edit and add forms, accepting work, choosing a person,
// requests, quick views, people panels) is this: a panel on the right on a computer and a sheet from the bottom on a
// phone, with
//   - a compact header: what this is (title, an optional "?" for the explanation) and its context in one line of chips
//     (a person's face, the task);
//   - a body of grouped sections (DrawerSection: a short label, an optional "?"), scrolling on its own;
//   - a sticky footer (DrawerFooter) with the one primary action, a quiet secondary, and a reserved line for errors so
//     nothing moves when one appears.
// Focus goes in (the first field, or [data-autofocus]) and stays in; Escape, the close button or a press outside close
// it and focus goes back to what opened it. It slides in (rises on a phone), and slides out even when its owner
// unmounts it; no motion under prefers-reduced-motion. On a phone the grip drags it down to close.
// BILLING-KIT (18 Oct 2026): optional section tabs (`panes`, swiped sideways on a phone) and, on a phone, snap heights
// (`snap`: peek shows only the header and footer, half about 55%, full about 92%; the grip drags or taps between them).
// A `persistent` sheet never closes: it rests at peek, where the page behind stays usable (a live preview under a form).
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import Link from "next/link";
import { HelpHint, Tooltip } from "./popover";
import css from "./drawer.module.css";

export type DrawerSize = "sm" | "md" | "lg" | "xl";
const WIDTH: Record<DrawerSize, number> = { sm: 400, md: 480, lg: 640, xl: 720 };
export type DrawerSnap = "peek" | "half" | "full";
export type DrawerPane = { key: string; label: ReactNode; content: ReactNode; count?: number };
const SNAPS: DrawerSnap[] = ["peek", "half", "full"];
const PHONE = "(max-width: 599.98px)";
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export type DrawerProps = {
  /** What this is: "Review Kedab’s work", "Who does it?". */ title: string;
  /** One line of context under the title: a person chip, the task, a date. */ context?: ReactNode;
  /** The explanation, behind a "?" next to the title instead of a paragraph. */ help?: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  /** The sticky footer: usually a DrawerFooter. */ footer?: ReactNode;
  size?: DrawerSize;
  /** The dialog's accessible name when it differs from the title. */ label?: string;
  /** The element containing the dialog's accessible description. */ describedBy?: string;
  className?: string;
  /** Nothing in the body takes focus on open (the close button does). */ noAutofocus?: boolean;
  /** Section tabs under the header; the body shows the chosen one (after `children`). Swipe sideways on a phone. */ panes?: DrawerPane[];
  /** The chosen tab, when the owner keeps it (else the first one). */ pane?: string;
  onPane?: (key: string) => void;
  /** Phone only: open as a bottom sheet at this height; the grip moves it between peek, half and full. */ snap?: DrawerSnap;
  onSnap?: (snap: DrawerSnap) => void;
  /** Phone only, with `snap`: the sheet never closes; it rests at peek, where the page behind stays usable. */ persistent?: boolean;
  /** No padding around the body (a preview that fills the panel). */ bare?: boolean;
};

const mediaSubscribe = (query: string) => (cb: () => void) => {
  if (typeof matchMedia !== "function") return () => {};
  const m = matchMedia(query); m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
/** Whether a media query matches, kept current; false while the server renders and the page hydrates. */
export function useMedia(query: string) {
  return useSyncExternalStore(mediaSubscribe(query), () => typeof matchMedia === "function" && matchMedia(query).matches, () => false);
}
/** A phone-sized window (below 600 px), where drawers are bottom sheets. */
export const useIsPhone = () => useMedia(PHONE);

/** A side panel (a bottom sheet on phones) rendered on the body, so no card or scrolling region can clip it. */
const subscribeNothing = () => () => {};
/** The panel lives only in the browser (a portal on document.body). While the server renders and while the page hydrates it
 *  renders nothing, then mounts with every effect running on the real element. RELEASE-6: a page that opens a drawer from its
 *  address (People & pay's `?do=change`) hydrated a portal the server never rendered (React #418). Drawers opened by a
 *  click mount at once, as before. */
export function Drawer(props: DrawerProps) {
  const browser = useSyncExternalStore(subscribeNothing, () => true, () => false);
  return browser ? <DrawerPanel {...props} /> : null;
}

function DrawerPanel({ title, context, help, icon, onClose, children, footer, size = "md", label, describedBy, className, noAutofocus, panes, pane, onPane, snap, onSnap, persistent, bare }: DrawerProps) {
  const box = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null);
  const phone = useIsPhone();
  const [drag, setDrag] = useState(0), [dragFrom, setDragFrom] = useState(0);
  const start = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  // The snap height: the owner's `snap` whenever it changes, else wherever the grip left it.
  const [snapNow, setSnapNow] = useState<DrawerSnap | undefined>(snap), [snapGiven, setSnapGiven] = useState(snap);
  if (snap !== snapGiven) { setSnapGiven(snap); setSnapNow(snap); }
  const sheet = phone && snapNow ? snapNow : undefined;
  const modal = !(persistent && sheet === "peek");
  const moveSnap = (s: DrawerSnap) => { setSnapNow(s); onSnap?.(s); };
  const [paneOwn, setPaneOwn] = useState(panes?.[0]?.key);
  const paneNow = panes?.find((p) => p.key === (pane ?? paneOwn)) ?? panes?.[0];
  const choosePane = (key: string) => { setPaneOwn(key); onPane?.(key); body.current?.scrollTo({ top: 0 }); if (sheet === "peek") moveSnap("half"); };
  const close = useRef(onClose), modalNow = useRef(modal), collapse = useRef<(() => void) | null>(null);
  useEffect(() => { close.current = onClose; modalNow.current = modal; collapse.current = persistent ? () => { setSnapNow("peek"); onSnap?.("peek"); } : null; });
  const dismiss = () => (collapse.current ? collapse.current() : close.current());
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (!modalNow.current) return;
      // A kit popover inside handles its own Escape first (it stops the event); anything else closes the drawer (a
      // persistent sheet goes back to peek).
      if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); if (collapse.current) collapse.current(); else close.current(); }
      if (event.key === "Tab" && box.current) {
        const all = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length && !el.closest("[inert]"));
        const first = all[0], last = all.at(-1);
        if (!box.current.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    // A persistent sheet opens with the page: it takes no focus.
    const target = persistent ? null : box.current?.querySelector<HTMLElement>("[data-autofocus]")
      // E2E-4P: on a touch screen a field is not focused on open: the keyboard rose over the sheet and its buttons.
      ?? (noAutofocus || window.matchMedia("(pointer: coarse)").matches ? null : body.current?.querySelector<HTMLElement>('input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not(:disabled), textarea:not(:disabled), select:not(:disabled), [role="combobox"]'))
      ?? box.current?.querySelector<HTMLElement>("[data-drawer-close]");
    target?.focus({ preventScroll: true });
    return () => { document.removeEventListener("keydown", onKey); if (!persistent && before?.isConnected) before.focus?.({ preventScroll: true }); };
    // Focus moves once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Slides out even when the owner unmounts it at once: a still copy animates away on the body.
  useLayoutEffect(() => {
    const el = box.current, backdrop = el?.parentElement, born = performance.now();
    return () => {
      // React's strict mode unmounts and remounts at once in development: no copy for that.
      if (!el || !backdrop || reduced() || typeof document === "undefined" || performance.now() - born < 120) return;
      const ghost = backdrop.cloneNode(true) as HTMLElement;
      ghost.setAttribute("aria-hidden", "true"); ghost.setAttribute("inert", ""); ghost.dataset.leaving = "";
      ghost.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
      // The copy is a picture: no dialog for shortcuts or tests to find, nothing to focus.
      ghost.querySelectorAll("[role], [aria-modal]").forEach((n) => { n.removeAttribute("role"); n.removeAttribute("aria-modal"); });
      document.body.appendChild(ghost);
      setTimeout(() => ghost.remove(), 200);
    };
  }, []);
  // A phone keeps the page behind still while the sheet covers it (not while a persistent sheet only peeks).
  useEffect(() => {
    if (!modal || !matchMedia(PHONE).matches) return;
    const html = document.documentElement, before = html.style.overflow;
    html.style.overflow = "hidden";
    return () => { html.style.overflow = before; };
  }, [modal]);
  if (typeof document === "undefined") return null;
  // The grip. Without snaps: drag down to close. With snaps: drag to the nearest height (below peek closes, unless the
  // sheet is persistent), or tap to go peek → half → full → peek.
  const heights = (): Record<DrawerSnap, number> => {
    const part = (s: string) => box.current?.querySelector<HTMLElement>(s)?.offsetHeight ?? 0;
    return { peek: part("header") + part("footer"), half: window.innerHeight * 0.55, full: window.innerHeight * 0.92 };
  };
  const grip = {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button, a, input") || !matchMedia(PHONE).matches || (e.pointerType === "mouse" && !sheet)) return;
      start.current = { y: e.clientY, h: box.current?.offsetHeight ?? 0, moved: false }; setDragFrom(start.current.h);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = start.current; if (!s) return;
      const dy = e.clientY - s.y; if (Math.abs(dy) > 6) s.moved = true;
      setDrag(sheet ? dy : Math.max(0, dy));
    },
    onPointerUp: () => {
      const s = start.current; if (!s) return;
      start.current = null; setDrag(0);
      if (!sheet) { if (drag > 90) onClose(); return; }
      if (!s.moved) { moveSnap(sheet === "peek" ? "half" : sheet === "half" ? "full" : "peek"); return; }
      const h = s.h - drag, at = heights();
      if (h < at.peek * 0.6 && !persistent) { onClose(); return; }
      moveSnap(SNAPS.reduce((best, k) => (Math.abs(at[k] - h) < Math.abs(at[best] - h) ? k : best), "peek" as DrawerSnap));
    },
    onPointerCancel: () => { start.current = null; setDrag(0); },
  };
  const live: CSSProperties | null = drag
    ? (sheet ? { height: `${Math.max(48, dragFrom - drag)}px`, transition: "none" } : { transform: `translateY(${drag}px)`, transition: "none" }) : null;
  // Section tabs: arrows on a computer, a sideways swipe on a phone.
  const step = (d: number) => {
    if (!panes?.length || !paneNow) return;
    const next = panes[(panes.indexOf(paneNow) + d + panes.length) % panes.length];
    choosePane(next.key);
    return next.key;
  };
  const tabKey = (e: ReactKeyboardEvent) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const key = step(d);
    if (key) box.current?.querySelector<HTMLElement>(`[data-pane-tab="${CSS.escape(key)}"]`)?.focus();
  };
  const tabId = (key: string) => `drawer-tab-${key.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return createPortal(
    <div className={css.backdrop} data-pulse-drawer-backdrop="" data-peek={modal ? undefined : ""} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
      <div ref={box} className={`${css.drawer}${className ? ` ${className}` : ""}`} role="dialog" aria-modal={modal ? "true" : undefined} aria-label={label ?? title} aria-describedby={describedBy} data-pulse-drawer="" data-float-sheet="" data-size={size}
        data-snap={sheet} data-bare={bare ? "" : undefined} style={{ "--drawer-w": `${WIDTH[size]}px`, ...live } as CSSProperties}>
        <header className={css.head} {...grip}>
          <span className={css.grip} aria-hidden="true" />
          {icon ? <span className={css.icon} aria-hidden="true">{icon}</span> : null}
          <div className={css.headMain}>
            <h2 className={css.title}><span>{title}</span>{help ? <HelpHint label="About this" side="bottom">{help}</HelpHint> : null}</h2>
            {context ? <div className={css.context}>{context}</div> : null}
          </div>
          {persistent && phone ? null : <button type="button" className={css.close} aria-label="Close" data-drawer-close="" onClick={onClose}><X size={16} aria-hidden="true" /></button>}
        </header>
        {panes?.length ? <div className={css.tabs} role="tablist" aria-label={`${label ?? title}: sections`}>
          {panes.map((p) => {
            const on = p.key === paneNow?.key;
            return <button key={p.key} type="button" role="tab" id={tabId(p.key)} data-pane-tab={p.key} className={css.tab} aria-selected={on} tabIndex={on ? 0 : -1}
              onClick={() => choosePane(p.key)} onKeyDown={tabKey}>{p.label}{p.count !== undefined ? <span className={css.tabCount}>{p.count}</span> : null}</button>;
          })}
        </div> : null}
        <div ref={body} className={css.body} data-drawer-body="" role={paneNow ? "tabpanel" : undefined} aria-labelledby={paneNow ? tabId(paneNow.key) : undefined}
          onPointerDown={panes?.length ? (e) => { swipe.current = e.pointerType === "mouse" ? null : { x: e.clientX, y: e.clientY }; } : undefined}
          onPointerUp={panes?.length ? (e) => {
            const s = swipe.current; swipe.current = null;
            if (!s) return;
            const dx = e.clientX - s.x, dy = e.clientY - s.y;
            if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
          } : undefined}>
          {children}{paneNow?.content}
        </div>
        {footer}
      </div>
    </div>, document.body);
}

/** A group in a drawer: a short label (with an optional "?") over its fields. */
export function DrawerSection({ title, help, aside, children, id, className }: { title?: ReactNode; help?: ReactNode; aside?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return <section className={`${css.section}${className ? ` ${className}` : ""}`} id={id} aria-label={typeof title === "string" ? title : undefined}>
    {title || aside ? <div className={css.sectionHead}>{title ? <h3>{title}</h3> : null}{help ? <HelpHint label={`About: ${typeof title === "string" ? title : "this"}`}>{help}</HelpHint> : null}{aside ? <span className={css.sectionAside}>{aside}</span> : null}</div> : null}
    {children}
  </section>;
}

/** The sticky footer: a reserved status line (errors appear here without moving anything), then the quiet actions and
 *  the one primary action on the right. */
export function DrawerFooter({ status, tone = "error", children, primary }: { status?: ReactNode; tone?: "error" | "info"; children?: ReactNode; primary?: ReactNode }) {
  return <footer className={css.foot}>
    <p className={css.status} data-tone={tone} role={tone === "error" ? "alert" : undefined} aria-live="polite">{status}</p>
    <div className={css.actions}>{children}{primary}</div>
  </footer>;
}

/** One quiet chip in a drawer's context line: an icon and a few words, optionally a link; `tip` shows the whole text. */
export function ContextChip({ icon, children, href, tip }: { icon?: ReactNode; children: ReactNode; href?: string; tip?: string }) {
  const body = <>{icon}<span>{children}</span></>;
  const chip = href ? <Link href={href} className={css.chip}>{body}</Link> : <span className={css.chip}>{body}</span>;
  return tip ? <Tooltip content={tip}>{chip}</Tooltip> : chip;
}
