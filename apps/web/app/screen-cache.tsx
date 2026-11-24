"use client";
// REPLAY-FIXES #1 + #2: a seen screen opens at once from this tab's copy, then the real page replaces it in place; a tap
// on the copy is not lost (lib/screen-cache.mjs says why and holds the rules). One per signed-in page (layout.tsx).
// It acts only when Next really starts a move to another page (instrumentation-client.ts: onRouterTransitionStart), so
// a link whose click opens a panel instead, a save's router.refresh() or a page writing its own query never shows one.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { notify } from "@pulse/ui-shell";
import { SCREEN_ARRIVED_MS, SCREEN_GIVE_UP_MS, SCREEN_MAX_NODES, TAP_KEEP_MS, createScreenCache, linkTarget, matchTap, moveKind, pageReady, screenKey, tapOf } from "./lib/screen-cache.mjs";
import css from "./screen-cache.module.css";

type Copy = { node: HTMLElement; bg: string; clean: boolean };
type Box = { top: number; left: number; width: number; height: number };
type Shown = { target: string; copy: Copy; box: Box };
type Tap = { tap: ReturnType<typeof tapOf>; count: number; at: number; target: string };

// In this tab's memory only: copies never go to storage or the network, and a reload or a change of company (a full
// page load) starts empty. They belong to one person (body[data-viewer]).
const cache = createScreenCache<Copy>();
let owner: string | null = null;

const CONTROLS = 'a[href],button,[role="button"],[role="tab"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="link"],[role="switch"],[role="checkbox"],summary';
// Never in a copy: anything that runs, plays, floats or is only for the moment.
const DROP = 'script,noscript,iframe,object,embed,video,audio,dialog,[role="dialog"],[role="alertdialog"],[popover],[data-no-snapshot],#pulse-page-note';
const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable]';
const STRIP = ["id", "name", "for", "autofocus", "aria-live", "aria-describedby", "aria-labelledby", "aria-controls", "aria-owns", "form"];

const mainEl = () => document.getElementById("main-content");
const hereKey = () => screenKey(window.location.href, window.location.href);
const visibleHeight = (el: Element) => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)); };
/** No loading screen covers main (whatever the address says). */
const settled = (main: Element) => pageReady({ here: "x", target: "x", busy: Array.from(main.querySelectorAll('[aria-busy="true"]'), visibleHeight), visible: visibleHeight(main) });
/** The real page is drawn on the tapped address. */
const drawn = (main: Element, target: string) => hereKey() === target && settled(main);

/** A control's description for matching a tap (lib/screen-cache.mjs tapOf); words come from aria-label or text. */
function describeControl(el: Element) {
  const tag = el.tagName.toLowerCase();
  return { tag, role: el.getAttribute("role") ?? "", testid: el.getAttribute("data-testid") ?? "", nav: el.getAttribute("data-nav-id") ?? "",
    href: tag === "a" ? el.getAttribute("href") ?? "" : "", label: el.getAttribute("aria-label") || el.getAttribute("title") || (el.textContent ?? "") };
}
/** Where a control sits among the controls of `root` that look the same, and how many there are. */
function placeOf(el: Element, root: Element) {
  const me = tapOf(describeControl(el));
  let nth = 0, count = 0;
  for (const c of Array.from(root.querySelectorAll(CONTROLS))) {
    const d = tapOf(describeControl(c));
    if (d.tag === me.tag && d.role === me.role && d.testid === me.testid && d.nav === me.nav && d.href === me.href && d.label === me.label) { if (c === el) nth = count; count++; }
  }
  return { tap: { ...me, nth }, count };
}

/** The screen as drawn now. Cloning is quick and happens during the tap; making it a still picture (scrub) waits. */
function copyOf(main: HTMLElement): Copy | null {
  if (main.getElementsByTagName("*").length > SCREEN_MAX_NODES) return null;
  let bg = "", p: HTMLElement | null = main;
  while (p && !bg) { const c = getComputedStyle(p).backgroundColor; if (c && c !== "transparent" && !/rgba\(.*,\s*0\)$/.test(c)) bg = c; p = p.parentElement; }
  return { node: main.cloneNode(true) as HTMLElement, bg: bg || "var(--lx-surface, #fff)", clean: false };
}
/** Nothing that runs or floats, no ids (they would repeat the real page's), nothing focusable or editable. */
function scrub(copy: Copy) {
  if (copy.clean) return copy;
  const node = copy.node;
  node.querySelectorAll(DROP).forEach((el) => el.remove());
  for (const el of [node, ...Array.from(node.querySelectorAll("*"))]) {
    for (const a of STRIP) if (el.hasAttribute(a)) el.removeAttribute(a);
    if (el.matches(FOCUSABLE)) el.setAttribute("tabindex", "-1");
    if (el.hasAttribute("contenteditable")) el.removeAttribute("contenteditable");
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.readOnly = true;
  }
  copy.clean = true;
  return copy;
}

/** Where the copy goes: over main's visible part, below the top bar and above a phone's tab bar. */
function boxOf(main: HTMLElement): Box {
  const r = main.getBoundingClientRect();
  const bar = document.querySelector("[data-shell-topbar]")?.getBoundingClientRect();
  const tabs = document.querySelector('nav[aria-label="Mobile navigation"]')?.getBoundingClientRect();
  const top = Math.max(0, r.top, bar && bar.height ? bar.bottom : 0);
  const bottom = Math.min(window.innerHeight, tabs && tabs.height && tabs.top > top ? tabs.top : window.innerHeight);
  return { top, left: Math.max(0, r.left), width: Math.min(r.width, window.innerWidth), height: Math.max(0, bottom - top) };
}

export function ScreenCache() {
  const router = useRouter();
  const pathname = usePathname(), search = useSearchParams()?.toString() ?? "";
  const here = screenKey(`${pathname}${search ? `?${search}` : ""}`);
  // The key of the screen React has drawn. During Back the address is already the next one while the DOM still shows
  // this one, so copies are filed under this key, not the address.
  const current = useRef<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [pending, setPending] = useState<{ target: string; from: string | null } | null>(null);   // no copy yet: the thin bar
  const [tapNote, setTapNote] = useState(false);
  const queued = useRef<Tap | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const shownRef = useRef<Shown | null>(null);
  useEffect(() => { shownRef.current = shown; }, [shown]);
  useEffect(() => { current.current = here; }, [here]);

  // Copies belong to one person; a change of company empties them too.
  useEffect(() => {
    // REPLAY-FIXES #2: the app is up: a tap made before it started (lib/early-clicks.mjs) runs now. The telemetry
    // collector says so too when it starts, but it may be switched off or outside its sample; off() runs once.
    (window as { __pulseEarly?: { off?: () => void } }).__pulseEarly?.off?.();
    const viewer = document.body.dataset.viewer ?? null;
    if (owner !== viewer) { cache.clear(); owner = viewer; }
    const moving = () => { cache.clear(); setShown(null); };
    window.addEventListener("pulse:org-moving", moving);
    return () => window.removeEventListener("pulse:org-moving", moving);
  }, []);

  useEffect(() => {
    let timer = 0, scrubTimer = 0;
    const keep = () => {
      const main = mainEl(), key = current.current;
      if (!main || !key || shownRef.current || !settled(main)) return;   // never copy a loading screen or a copy
      const copy = copyOf(main);
      if (!copy) { cache.drop(key); return; }
      cache.put(key, copy);
      window.clearTimeout(scrubTimer); scrubTimer = window.setTimeout(() => scrub(copy), 0);
    };
    const start = (e: Event) => {
      const d = (e as CustomEvent<{ url?: string; type?: string }>).detail;
      const target = d?.url ? screenKey(d.url, window.location.href) : null;
      // Back and Forward: Next shows the page it kept; the screen being left is still copied.
      if (d?.type === "traverse") { keep(); window.clearTimeout(timer); timer = window.setTimeout(() => { setShown(null); setPending(null); }, 0); return; }
      // Only a move to another screen (a page writing its own query while someone types is not one).
      const kind = moveKind({ target, current: current.current, type: d?.type });
      if (!target || !kind) return;
      if (kind === "view") {
        // VITALS-SWEEP: the same page in another view (a tab, a chip): no copy, the thin bar until the address moves.
        const from = current.current;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => { if (!shownRef.current) setPending({ target, from }); }, 50);
        return;
      }
      keep();
      const hit = cache.get(target), from = current.current;
      // Next starts a move inside a React transition; state set here would wait for the whole move. A timer does not.
      // 50 ms: a page Next still holds (seen in the last 30 s) is drawn by then and is not covered by a copy.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const main = mainEl();
        if (!main || drawn(main, target)) { setPending(null); return; }
        if (!hit) { setShown(null); setPending({ target, from }); return; }
        setPending(null); setShown({ target, copy: scrub(hit.value), box: boxOf(main) });
        window.dispatchEvent(new CustomEvent("pulse:screen-copy", { detail: { target } }));
      }, 50);
    };
    window.addEventListener("pulse:nav-start", start);
    // From now on a move keeps a copy of the screen it leaves (body[data-screen-cache]). A tap made while Pulse was still
    // starting (held by lib/early-clicks.mjs, or pressed before this part of the page had started) leaves none: the
    // screen it left is not kept, and a later visit to it opens as a first one, with the thin bar.
    document.body.setAttribute("data-screen-cache", "");
    return () => { window.clearTimeout(timer); window.clearTimeout(scrubTimer); window.removeEventListener("pulse:nav-start", start); document.body.removeAttribute("data-screen-cache"); };
  }, []);

  // The copy in its place, and taps on it: a link opens at once; a button is kept and pressed on the real page.
  useEffect(() => {
    const el = host.current;
    if (!shown || !el) return;
    el.replaceChildren(shown.copy.node.cloneNode(true));
    const tap = (e: Event) => {
      e.preventDefault(); e.stopPropagation();
      if (e.type !== "click") return;
      const hit = (e.target as Element | null)?.closest?.(CONTROLS);
      if (!hit || !el.contains(hit)) return;
      if (hit.tagName === "A") {
        const href = (hit as HTMLAnchorElement).href;
        if (linkTarget({ href, button: 0, mods: false, target: hit.getAttribute("target") ?? "", download: hit.hasAttribute("download") }, window.location)) { queued.current = null; router.push(href); }
        return;
      }
      queued.current = { ...placeOf(hit, el), at: Date.now(), target: shown.target }; setTapNote(true);
    };
    el.addEventListener("click", tap, true); el.addEventListener("submit", tap, true);
    return () => { el.removeEventListener("click", tap, true); el.removeEventListener("submit", tap, true); };
  }, [shown, router]);

  // The real page takes over once it is drawn on the tapped address (or the copy gives up after 15 s).
  useEffect(() => {
    if (!shown) return;
    const main = mainEl();
    let quiet = 0, done = false;
    const press = (t: Tap) => {
      const real = mainEl(); if (!real) return;
      const controls = Array.from(real.querySelectorAll(CONTROLS));
      const i = matchTap(t.tap, controls.map(describeControl), t.count);
      const el = i >= 0 ? controls[i] as HTMLElement : null;
      if (el && el.isConnected && !el.matches(":disabled,[aria-disabled='true']") && el.getClientRects().length) el.click();
      else notify({ id: "screen-tap", tone: "info", title: "The page changed while it opened. Tap again.", timeout: 4000 });
    };
    const finish = (ok: boolean) => {
      if (done) return; done = true;
      setShown(null); setTapNote(false);
      const t = queued.current; queued.current = null;
      if (ok && t && t.target === shown.target && Date.now() - t.at <= TAP_KEEP_MS) window.setTimeout(() => press(t), 0);
    };
    // Once the real page is on the tapped address it takes over when drawn, and at most SCREEN_ARRIVED_MS later even if a
    // large part of it is still loading: what it shows is fresher than the copy.
    let arrived = 0;
    const check = () => {
      if (!main) return;
      if (!arrived && hereKey() === shown.target) arrived = performance.now();
      if (arrived && performance.now() - arrived > SCREEN_ARRIVED_MS) { finish(true); return; }
      if (drawn(main, shown.target)) { window.clearTimeout(quiet); quiet = window.setTimeout(() => { if (drawn(main, shown.target)) finish(true); }, 80); }
    };
    const mo = main ? new MutationObserver(check) : null;
    mo?.observe(main as Element, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy"] });
    const poll = window.setInterval(check, 150);
    const giveUp = window.setTimeout(() => finish(false), SCREEN_GIVE_UP_MS);
    return () => { mo?.disconnect(); window.clearInterval(poll); window.clearTimeout(giveUp); window.clearTimeout(quiet); };
  }, [shown]);

  // No copy yet (a first visit): the bar stays until the address moves, at most 15 s.
  useEffect(() => {
    if (!pending) return;
    const t = window.setTimeout(() => setPending(null), SCREEN_GIVE_UP_MS);
    return () => window.clearTimeout(t);
  }, [pending]);

  if (typeof document === "undefined") return null;
  return createPortal(<>
    {shown ? <div ref={host} className={css.copy} aria-hidden="true" data-screen-copy={shown.target}
      style={{ top: shown.box.top, left: shown.box.left, width: shown.box.width, height: shown.box.height, background: shown.copy.bg }} /> : null}
    {shown ? <div className={css.note} role="status" style={{ top: shown.box.top + 8 }}>{tapNote ? "Opening… your tap will run when it is ready" : "Updating…"}</div> : null}
    {pending && pending.from === here ? <div className={css.bar} role="progressbar" aria-label="Opening the page" /> : null}
  </>, document.body);
}
