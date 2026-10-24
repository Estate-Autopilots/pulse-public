"use client";
// Pip's island (UX-NOTIFY): one small pill in the top bar instead of the corner toasts and the corner companion.
// Top-centre from 1280 px (the app window's size; the page header makes room for it), beside the header buttons on smaller computers, a
// compact pill on a phone. Something arrives (a message, a request, a nudge, a confirmation): it springs open with the
// avatar, one line and the main action, then settles back with a badge. Arrivals queue; they never stack. It waits
// while the pointer or focus is in the top bar, so it never opens over a control someone is using.
// Click, tap, long-press, Enter or Space: Pip's menu. A mouse resting on Pip: today's summary (never on touch).
// FLOAT (21 Oct 2026): by default Pip floats free as a calm 56 px glass button in the bottom-right corner (above a
// phone's tab bar), draggable and remembered, and steps aside for whatever the page needs there (lib/float-place.mjs).
// Its menu is one named list in a glass card: the day (check in or out), what needs you, Ask Pip, quick create, settings.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { currentNotices, dismissNotice, subscribeNotices, useBackLayer } from "@pulse/ui-shell";
import { deriveView, pipSvg, type CompanionPayload, type Mood } from "@pulse/companion";
import { checkinView, words } from "../lib/checkin-view.mjs";
import { hasPriority, nextArrival, priorityIndex, shouldPreempt } from "../lib/island-queue.mjs";
import { floatRoom, leastFloat, openSide, placeFloat, scanFloat, type Rect } from "../lib/float-place.mjs";
import { useCompanionDay, type Nudge } from "../lib/companion-day";
import { openCreate } from "../create";
import { Avatar } from "../ui";
import { currentNoticeList, openNotices, priorityOf, refreshNotices, useNoticeList, type Notice } from "./store";
import { ago } from "../lib/format";
import { Bell, Clock3, FolderPlus, Moon, PanelTop, PanelRightClose, Plus, Sparkles } from "lucide-react";
import css from "./island.module.css";

type Item = { id: string; mood: Mood; title: string; detail?: string; from?: { id: string; name: string; photoAt?: string | null } | null; tone?: "error" | "success" | "info";
  priority?: "action"; action?: { label: string; run: () => void; href?: string }; open?: () => void; hold?: number; again?: boolean; urgent?: boolean };
type Home = "centre" | "dock" | "phone";
type Arrival = { id: string; title: string; href?: string; kind?: string };

const SHOW = 5200, GAP = 900;
// Hover intent: the summary waits for a mouse to rest on Pip (passing by does nothing) and lingers a moment after it
// leaves. A long-press on a touch screen opens the menu; the click that may follow it is not a second toggle.
const HOVER_IN = 260, HOVER_OUT = 140, LONG_PRESS = 800;
const safeHref = (href?: string | null) => href && href.startsWith("/") && !href.startsWith("//") ? href : "/notifications";
// In chat mode (LAYOUT-SWEEP) the bar's middle is the conversation's header, so the island stays beside the buttons.
const homeFor = (w: number): Home => w < 900 ? "phone" : w >= 1280 && document.documentElement.dataset.mode !== "chat" ? "centre" : "dock";
// "Calm" (Settings → Devices): arrivals only raise the badge; the app's own confirmations and problems still show.
const CALM = "pulse-island-calm";
const onCalm = (l: () => void) => { window.addEventListener("storage", l); window.addEventListener(CALM, l); return () => { window.removeEventListener("storage", l); window.removeEventListener(CALM, l); }; };
const readCalm = () => { try { return localStorage.getItem(CALM) === "1"; } catch { return false; } };
let serial = 0;
/** Owner workbench UI (stability): a custom property is written only when it changes. Pip's slot is re-measured on
 *  every resize of the top bar and its neighbours; rewriting the same values on <html> restyled the whole page each time. */
const setVar = (st: CSSStyleDeclaration, k: string, v: string | null) => { if (v === null) { if (st.getPropertyValue(k)) st.removeProperty(k); } else if (st.getPropertyValue(k) !== v) st.setProperty(k, v); };

/** The action an island arrival offers: decisions and replies happen in the panel, updates open where they point. */
function fromCard(card: Notice | undefined, row: Arrival, router: ReturnType<typeof useRouter>): Item {
  const href = safeHref(card?.open.href ?? row.href);
  const go = () => router.push(href);
  if (!card) return { id: row.id, mood: "new-message", title: row.title, open: go, action: { label: "Open", run: go } };
  const reply = card.actions.find((a) => a.key === "reply");
  const decide = card.group === "action" && card.state === "open";
  // FLOAT: an urgent notice stays until it is answered or dismissed; everything else settles back by itself.
  const urgent = card.priority === "urgent";
  return {
    id: row.id, mood: card.group === "action" || urgent ? "listening" : "new-message", title: card.title, detail: card.body ?? undefined, from: card.from ?? null, open: go,
    priority: reply || decide || urgent ? "action" : undefined, hold: urgent ? Infinity : undefined, urgent,
    action: reply ? { label: "Reply", run: () => openNotices(card.id) } : decide ? { label: "Review", run: () => openNotices(card.id) } : { label: card.open.label, run: go },
  };
}

// FLOAT (21 Oct 2026): a calm glass button, not a 96 px character: the owner found the big Pip and its ring of
// unnamed icons ugly, and the ring's outer buttons left the window ("Put Pip in the top bar" could not be clicked).
const PIP = 56, EDGE = 16;
/** OWNER-PIP: where a floating Pip may rest: inside the window, under the top bar and above a phone's tab bar, so it
 *  never sits on either of them (EST-2093: on a phone it covered the tab bar's More). */
function pipRoom() {
  const bar = document.querySelector("[data-shell-topbar]")?.getBoundingClientRect() ?? null;
  const tabs = document.querySelector('nav[aria-label="Mobile navigation"]')?.getBoundingClientRect() ?? null;
  return floatRoom({ width: window.innerWidth, height: window.innerHeight, bar, tabs, edge: EDGE });
}
/** OWNER-PIP: keep a floating Pip fully inside that room. */
function clampPip(x: number, y: number) {
  const room = pipRoom();
  return { x: Math.max(room.left, Math.min(room.right - PIP, x)), y: Math.max(room.top, Math.min(room.bottom - PIP, y)) };
}
/** Owner workbench UI (stability): where a dragged Pip may go: anywhere in the window (over the sidebar, the top bar or
 *  a panel), 8 px from its edges and clear of the safe areas. Read once when a drag starts, never per frame. */
function windowRoom() {
  const c = getComputedStyle(document.documentElement), safe = (k: string) => Number.parseFloat(c.getPropertyValue(`--pulse-safe-${k}`)) || 0;
  return { left: 8 + safe("left"), top: 8 + safe("top"), right: window.innerWidth - 8 - safe("right"), bottom: window.innerHeight - 8 - safe("bottom") };
}
const clampTo = (r: { left: number; top: number; right: number; bottom: number }, x: number, y: number) => ({ x: Math.round(Math.max(r.left, Math.min(r.right - PIP, x))), y: Math.round(Math.max(r.top, Math.min(r.bottom - PIP, y))) });
/** OWNER-PIP: its first spot, the bottom-right corner (on a phone, above the tab bar). */
const pipHome = () => clampPip(window.innerWidth, window.innerHeight);
/** UI-UPGRADE (R067, owner 24 Oct 2026): Pip rests only in a bottom corner of the page, never mid-page over a title, a
 *  field or a form (a spot dropped by hand used to stay wherever it fell). Right by default; left when dropped on the
 *  left half. The left corner starts where the page starts, so it never sits on the sidebar. */
type Side = "left" | "right";
function pageRoom() {
  const room = pipRoom(), main = document.getElementById("main-content")?.getBoundingClientRect();
  return { ...room, left: Math.max(room.left, Math.round((main?.left ?? 0) + EDGE)) };
}
function pipCorner(side: Side) {
  const room = pageRoom();
  return { x: side === "left" ? room.left : room.right - PIP, y: room.bottom - PIP };
}
/** Where Pip may step aside to when its corner holds a control: the lower 40% of the page, along its side edges. */
function lowRoom() {
  const room = pageRoom();
  return { ...room, top: Math.max(room.top, Math.round(room.bottom - (room.bottom - room.top) * 0.4)) };
}
const sideOf = (x: number | undefined): Side => (x ?? 1) < 0.5 ? "left" : "right";
/** FLOAT: a docked Pip's menu or summary hangs under Pip, inside the window. Placed in the window's coordinates, from
 *  wherever its containing block is: inside the calm home's glass capsule (backdrop-filter holds fixed children) the
 *  phone's menu opened 60 px off the left edge and the computer's past the right one. */
function anchorBelow(el: HTMLElement, a: DOMRect, centre: boolean) {
  Object.assign(el.style, { position: "fixed", right: "auto", bottom: "auto", margin: "0", left: "0px", top: "0px", animation: "none" });
  const o = el.getBoundingClientRect();
  el.style.animation = "";
  const left = Math.max(8, Math.min(window.innerWidth - 8 - o.width, centre ? a.left + a.width / 2 - o.width / 2 : a.right - o.width)), top = a.bottom + 10;
  Object.assign(el.style, { left: `${Math.round(left - o.left)}px`, top: `${Math.round(top - o.top)}px`, maxHeight: `${Math.max(200, window.innerHeight - top - 12)}px` });
}
/** FLOAT: what a floating Pip must never cover: anything marked `data-float-avoid` (the builder's canvas controls, the
 *  task companion, a notice banner), the page header's buttons, the page's primary and submit buttons, and open side
 *  sheets (notifications, insights, drawers). Only what is near Pip is measured. */
const AVOID = "[data-float-avoid], [data-float-sheet], [data-float], main [data-page-header] :is(button, a[href]), main :is(button, a)[class*='rimary'], main button[type=submit]";
function keepOut(near: { x: number; y: number }, island: HTMLElement | null, sel = AVOID, reach = 260) {
  const out: Rect[] = [], wide = window.innerWidth * 0.6;
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    if (island?.contains(el) || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) continue;
    const box = el.getBoundingClientRect();
    // READY: the chat composer keeps a margin, so Pip never sits right against its mic or Send.
    const m = el.hasAttribute("data-chat-composer") ? 16 : 0;
    const r = { left: box.left - m, top: box.top - m, right: box.right + m, bottom: box.bottom + m, width: box.width + 2 * m, height: box.height + 2 * m };
    if (sel !== AVOID && r.width > wide && el.matches("a[href], [role=link]")) continue; // a whole-row link
    if (r.width < 2 || r.height < 2 || r.right < near.x - reach || r.left > near.x + PIP + reach || r.bottom < near.y - reach || r.top > near.y + PIP + reach) continue;
    out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return out;
}

/** FLOAT-2 (device audit): every control of the page, not only the marked ones (on a phone the "Blocked 10" filter and
 *  "Select tasks" sat under Pip). A whole-row link is not one: Pip may rest on a row's end, never on its buttons. */
const CONTROLS = "main :is(button, a[href], input, select, textarea, summary, [role=button], [role=tab], [role=checkbox], [role=switch], [role=link])";
export function PipIsland({ personId, canAsk = true }: { personId?: string; canAsk?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const notices = useNoticeList();
  const day = useCompanionDay();
  const [home, setHome] = useState<Home>("dock");
  const [current, setCurrent] = useState<Item | null>(null);
  const [badge, setBadge] = useState(0);
  const [menu, setMenu] = useState(false);
  // FLOAT-2: Android back closes Pip's menu (in the phone app it used to leave Pulse; in Chrome, the page).
  useBackLayer(menu, () => setMenu(false));
  const [hover, setHover] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [comms, setComms] = useState<{ total: number; dnd: boolean; quiet: string | null }>({ total: 0, dnd: false, quiet: null });
  const [error, setError] = useState<Item | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const queue = useRef<Item[]>([]);
  const shown = useRef<number[]>([]);
  const busy = useRef(false);
  const showing = useRef<Item | null>(null);
  // OWNER-PIP: Pip floats free on the page (drag it anywhere; it remembers the spot), watches the pointer, wakes or
  // leans in when you come near, and can be tucked to the screen edge or put back in the top bar.
  const [free, setFree] = useState(false);
  const [tucked, setTucked] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const positioned = pos !== null;
  const [near, setNear] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean; room: { left: number; top: number; right: number; bottom: number }; frame: number; at: { x: number; y: number } | null } | null>(null);
  const dragged = useRef(false);
  // Moved by hand (a saved spot): a resize keeps it in the room. Never moved: it goes back to its first spot.
  const placedByHand = useRef(false);
  const [, setByHand] = useState(false);
  const seen = useRef(new Set<string>());
  const eyes = useRef("");
  const pump = useRef<() => void>(() => {});
  // Is someone using the top bar? A mouse over it, or a touch in the last moments (phones keep :hover after a tap).
  // `pip`: a mouse resting on a floating Pip.
  const pointer = useRef({ over: false, touched: 0, pip: false });
  const hoverTimer = useRef(0);
  // The last press on Pip: its pointer type, and when a long-press opened the menu.
  const press = useRef({ type: "mouse", long: 0 });
  // Keyboard focus that was on Pip when an arrival opened (Pip's button goes inert under it): it moves onto the
  // arrival, and back to Pip when the arrival settles, instead of falling to the page.
  const refocus = useRef(false);
  const calm = useSyncExternalStore(onCalm, readCalm, () => false);
  // Today's summary shows only at rest: not over the menu, not over an arrival.
  const summary = hover && !menu && !current;

  // Where the island lives, and how far it may open without leaving the top bar or reaching its buttons.
  // EST-2093: measured from Pip's slot, which stays in the bar when Pip floats free (the island itself then lives on the
  // page), and again whenever Pip moves between the two, so a Pip put back in the bar is placed and shown at once.
  useLayoutEffect(() => {
    const s0 = slot.current, group = s0?.parentElement, bar = s0?.closest("header");
    if (!s0 || !group || !bar) return;
    const doc = document.documentElement;
    const place = () => {
      const el = root.current; if (!el) return;
      const h = homeFor(window.innerWidth);
      setHome(h);
      const b = bar.getBoundingClientRect();
      const utils = group.getBoundingClientRect();
      const s = s0.getBoundingClientRect();
      // Floating free, Pip leaves the bar: the page header no longer splits around its middle.
      if (free) { setVar(doc.style, "--pulse-island-room-left", null); setVar(doc.style, "--pulse-island-room-right", null); }
      else if (h === "centre") {
        const centre = b.left + b.width / 2;
        setVar(el.style, "--island-max", `${Math.min(480, 2 * (utils.left - 8 - centre))}px`);
        setVar(el.style, "--island-right", null);
        // The page header splits around the island's slot (ui.module.css reads these).
        setVar(doc.style, "--pulse-island-room-left", `${Math.max(160, Math.round(centre - 21 - 12 - (b.left + 24)))}px`);
        setVar(doc.style, "--pulse-island-room-right", `${Math.max(120, Math.round(utils.left - 8 - (centre + 21 + 12)))}px`);
      } else {
        setVar(el.style, "--island-right", `${Math.round(b.right - s.right)}px`);
        // A phone's pill opens across the whole bar; a computer's grows left from its place beside the buttons.
        setVar(el.style, "--island-max", `${h === "phone" ? Math.round(b.width - 16) : Math.min(480, Math.round(s.right - b.left - 24))}px`);
        setVar(doc.style, "--pulse-island-room-left", null); setVar(doc.style, "--pulse-island-room-right", null);
      }
      if (h !== "phone") setVar(doc.style, "--pulse-bar-right", `${Math.round(b.right - utils.left + 8)}px`);
      else setVar(doc.style, "--pulse-bar-right", null);
      // LAYOUT-SWEEP: shown (and animated when it moves) only once it sits in its own place; before that it lay over
      // the account button for a moment after every page load.
      if (!el.hasAttribute("data-placed")) requestAnimationFrame(() => el.setAttribute("data-placed", ""));
    };
    const move = (e: PointerEvent) => { if (e.pointerType === "mouse") pointer.current.over = true; else pointer.current.touched = Date.now(); };
    const leave = (e: PointerEvent) => { if (e.pointerType === "mouse") pointer.current.over = false; };
    bar.addEventListener("pointermove", move); bar.addEventListener("pointerdown", move); bar.addEventListener("pointerleave", leave);
    // Owner workbench UI (stability): measured once per frame, after the browser's own layout, never in the middle of a
    // DOM change (each synchronous measure forced a layout of the whole page while a big page was still streaming in).
    let frame = 0;
    const soon = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    const watch = new ResizeObserver(soon);
    watch.observe(bar); watch.observe(group);
    // POLISH-2 (QA-E2E P1-4): the slot moves whenever a neighbour in the bar appears or changes width (the check-in
    // chip once the day loads, "Check in" becoming "4:07", the reviews chip), even when neither the bar nor this group
    // changes size; the island then sat over the check-in chip. Every neighbour is watched, and new ones as they come.
    const watchAll = () => { for (const child of group.children) watch.observe(child); };
    const neighbours = new MutationObserver(() => { watchAll(); soon(); });
    neighbours.observe(group, { childList: true }); watchAll();
    const modes = new MutationObserver(soon); modes.observe(doc, { attributes: true, attributeFilter: ["data-mode", "data-checkin"] });
    window.addEventListener("resize", soon); place();
    return () => { cancelAnimationFrame(frame); bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerdown", move); bar.removeEventListener("pointerleave", leave);
      watch.disconnect(); neighbours.disconnect(); modes.disconnect(); window.removeEventListener("resize", soon); for (const v of ["--pulse-island-room-left", "--pulse-island-room-right", "--pulse-bar-right"]) doc.style.removeProperty(v); };
  }, [free]);

  // The pill opens exactly as wide as what it shows (never wider than the room measured above).
  // At the top-centre it keeps to the free space between the page's title and its buttons when there is enough.
  useLayoutEffect(() => {
    const el = root.current, box = content.current; if (!el || !box) return;
    if (!current) { el.style.removeProperty("--island-w"); return; }
    let max = Number.parseFloat(el.style.getPropertyValue("--island-max")) || 440;
    const header = document.querySelector<HTMLElement>("main [data-page-header]");
    if (home === "centre" && header) {
      const r = el.getBoundingClientRect(), centre = r.left + r.width / 2;
      const text = [...header.querySelectorAll<HTMLElement>("[data-page-header] > div:first-of-type > *")].reduce((x, c) => Math.max(x, c.getBoundingClientRect().right), 0);
      const acts = header.querySelector<HTMLElement>("[data-hscroll]")?.getBoundingClientRect().left ?? Infinity;
      const free = 2 * Math.min(centre - text - 14, acts - centre - 14);
      if (free >= 300) max = Math.min(max, free);
    }
    el.style.setProperty("--island-w", `${Math.ceil(Math.min(max, box.scrollWidth))}px`);
  }, [current, home]);

  // One item at a time; the rest wait. Never while the pointer or focus is in the top bar, or Pip's menu is open.
  const finish = useCallback(() => {
    refocus.current ||= !!content.current?.contains(document.activeElement);
    setCurrent(null); busy.current = false; showing.current = null;
    window.setTimeout(() => pump.current(), GAP);
  }, []);
  useEffect(() => {
    pump.current = () => {
      if (busy.current || !queue.current.length) return;
      // Someone typing in the bar or using one of its menus is not interrupted (resting focus on the bell is fine).
      const bar = root.current?.closest("header");
      const active = document.activeElement;
      // A mouse counts only while the bar really is hovered: a lost pointerleave once held every arrival back for good.
      const busyBar = !!bar && ((pointer.current.over && bar.matches(":hover")) || Date.now() - pointer.current.touched < 2500 || !!bar.querySelector('[aria-expanded="true"]:not([data-pip])')
        || (!!active && bar.contains(active) && active.matches("input, textarea, select, [contenteditable='true']")));
      // EST-2093: floating free there is no bar; a pointer resting on Pip is someone using it, so an arrival waits (it
      // stayed open under the pointer, with Pip's button out of reach, for as long as the pointer rested there).
      // A mouse only: phones keep :hover after a tap.
      const busyPip = !bar && pointer.current.pip && !!root.current?.matches(":hover");
      if (menu || busyBar || busyPip) { window.setTimeout(() => pump.current(), 700); return; }
      // Calm: a burst becomes one line ("4 new updates") instead of a parade (lib/island-queue.mjs).
      const step = nextArrival(queue.current, shown.current, Date.now(), (rest): Item => ({ id: `summary:${++serial}`, mood: "new-message", title: `${rest.length} new updates`,
        detail: rest[rest.length - 1].title, action: { label: "Open", run: () => openNotices() }, open: () => openNotices() }));
      queue.current = step.queue; shown.current = step.shown;
      const next = step.item;
      if (!next) return;
      busy.current = true; showing.current = next;
      refocus.current ||= !!active && !!root.current?.contains(active) && active.matches(":focus-visible");
      setCurrent(next);
      if (next.tone !== "error" && next.tone !== "success" && !next.again) setBadge((b) => Math.min(99, b + 1));
    };
  });
  // Open, it gets out of the way the moment the pointer reaches for anything else in the top bar.
  useEffect(() => {
    if (!current) return;
    const bar = root.current?.closest("header");
    const reach = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) finish(); };
    bar?.addEventListener("pointerover", reach); bar?.addEventListener("pointerdown", reach);
    return () => { bar?.removeEventListener("pointerover", reach); bar?.removeEventListener("pointerdown", reach); };
  }, [current, finish]);
  const enqueue = useCallback((item: Item) => {
    if (seen.current.has(item.id)) return;
    seen.current.add(item.id); if (seen.current.size > 500) seen.current.delete(seen.current.values().next().value!);
    if (calm && !item.tone) { setBadge((b) => Math.min(99, b + 1)); return; }
    if (hasPriority(item)) {
      // Confirmations, problems and requests that need a decision move ahead of informational arrivals such as "Your
      // role brief is ready". Leaving an info notice first made quick actions look as if they had done nothing.
      const first = priorityIndex(queue.current, item);
      queue.current.splice(first, 0, item);
      const was = showing.current;
      if (was && shouldPreempt(was, item)) {
        queue.current.splice(first + 1, 0, { ...was, again: true });
        refocus.current ||= !!content.current?.contains(document.activeElement);
        showing.current = null; busy.current = false; setCurrent(null);
      }
    } else queue.current.push(item);
    pump.current();
  }, [calm]);
  // The open item settles back by itself (hovering it or focusing inside keeps it open); errors stay a little longer.
  useEffect(() => {
    if (!current) return;
    let left = current.hold ?? (current.tone === "error" ? 9000 : current.tone === "success" ? 3200 : SHOW);
    let last = Date.now();
    const timer = window.setInterval(() => {
      const t = Date.now(); if (!root.current?.matches(":hover") && !content.current?.contains(document.activeElement)) left -= t - last; last = t;
      if (left <= 0) finish();
    }, 200);
    return () => window.clearInterval(timer);
  }, [current, finish]);

  useEffect(() => {
    if (!refocus.current) return;
    if (current) { content.current?.querySelector<HTMLElement>("button")?.focus(); return; }
    refocus.current = false;
    // Unless something else took focus meanwhile (the panel a "Reply" opened, a page it led to).
    if (!document.activeElement || document.activeElement === document.body || content.current?.contains(document.activeElement)) root.current?.querySelector<HTMLElement>("[data-pip]")?.focus();
  }, [current]);
  // Sources: the notification poll (BrowserPings), Pip nudges from check-in, and the app's own confirmations.
  useEffect(() => {
    const arrival = (e: Event) => {
      const row = (e as CustomEvent<Arrival>).detail;
      void refreshNotices(true).then(() => enqueue(fromCard(currentNoticeList()?.rows.find((n) => n.ids.includes(row.id)), row, router)));
    };
    const nudge = (e: Event) => {
      const n = (e as CustomEvent<Nudge>).detail;
      const primary = n.actions.find((a) => a.id !== "dismiss");
      enqueue({ id: `nudge:${n.id}`, mood: n.kind === "first-check-in" || n.kind === "streak" ? "celebrate" : "listening", title: n.title, detail: n.body,
        action: primary ? { label: primary.label, run: () => primary.href ? router.push(primary.href) : window.dispatchEvent(new CustomEvent("pulse:checkin-act", { detail: { id: primary.id } })) } : undefined });
    };
    const communications = (e: Event) => {
      const d = (e as CustomEvent<{ counts?: { total?: number }; settings?: { dnd?: boolean }; suppression?: string | null }>).detail;
      // Asked every 2.5 s: Pip re-renders only when something it shows changed.
      const next = { total: d.counts?.total ?? 0, dnd: !!d.settings?.dnd, quiet: d.suppression ?? null };
      setComms((c) => (c.total === next.total && c.dnd === next.dnd && c.quiet === next.quiet ? c : next));
    };
    window.addEventListener("pulse:arrival", arrival); window.addEventListener("pulse:nudge", nudge); window.addEventListener("pulse:communications", communications);
    return () => { window.removeEventListener("pulse:arrival", arrival); window.removeEventListener("pulse:nudge", nudge); window.removeEventListener("pulse:communications", communications); };
  }, [enqueue, router]);
  // The app's confirmations and problems (notify() from @pulse/ui-shell) come here instead of a corner.
  useEffect(() => {
    const take = () => {
      for (const n of currentNotices()) {
        dismissNotice(n.id);
        const item: Item = { id: `notice:${n.id}:${++serial}`, tone: n.tone, mood: n.tone === "error" ? "concerned" : n.tone === "success" ? "happy" : "idle", title: n.title, detail: n.message,
          action: n.action ? { label: n.action.label, run: n.action.run, href: n.href ? safeHref(n.href) : undefined } : undefined, hold: n.timeout };
        if (n.tone === "error") setError(item);
        enqueue(item);
      }
    };
    const first = window.setTimeout(take, 0);
    const stop = subscribeNotices(take);
    return () => { window.clearTimeout(first); stop(); };
  }, [enqueue]);
  // OWNER-PIP: free by default; the spot is kept as a share of the window so it survives resizes.
  useEffect(() => {
    let saved: { x: number; y: number } | null = null;
    try {
      // Read once after hydration: the server cannot see this browser's choice.
      const dock = localStorage.getItem("pulse.pip.dock");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFree(dock === null ? !document.documentElement.hasAttribute("data-pip-docked") : dock !== "1");
      setTucked(localStorage.getItem("pulse.pip.tucked") === "1");
      const raw = localStorage.getItem("pulse.pip.pos"); if (raw) saved = JSON.parse(raw) as { x: number; y: number };
    } catch { setFree(true); }
    placedByHand.current = !!saved;
    setByHand(!!saved);
    // A spot the person chose stays where they put it (kept inside the window), never snapped to an edge.
    // UI-UPGRADE: an older spot anywhere on the page becomes the corner on its side.
    setPos(saved ? pipCorner(sideOf(saved.x)) : pipHome());
    // E2E-4P: after a rotation a hand-placed Pip kept its pixel spot, which then sat mid-screen over buttons (Start).
    // It keeps its share of the window instead, against the nearer side edge, inside the window.
    const resize = () => setPos((p) => {
      if (!p || !placedByHand.current) return pipHome();
      let share: { x: number; y: number } | null = null;
      try { const raw = localStorage.getItem("pulse.pip.pos"); if (raw) share = JSON.parse(raw) as { x: number; y: number }; } catch { /* private mode */ }
      return pipCorner(sideOf(share?.x));
    });
    window.addEventListener("resize", resize); screen.orientation?.addEventListener?.("change", resize);
    return () => { window.removeEventListener("resize", resize); screen.orientation?.removeEventListener?.("change", resize); };
  }, []);
  // Keep the next server paint aligned with this browser's choice; free Pip's side room exists before hydration.
  useEffect(() => {
    if (!positioned) return;
    document.documentElement.toggleAttribute("data-pip-docked", !free);
    document.cookie = `pulse.pip.dock=${free ? "0" : "1"}; path=/; max-age=31536000; samesite=lax`;
  }, [free, positioned]);
  // EST-2093: while Pip floats in the lower half of the window (or peeks tucked, 120 px up the right edge), every page
  // keeps room at its end (ui.module.css and the home read --pulse-pip-gutter), so its last line scrolls clear of Pip.
  // A phone's page already ends above the tab bar: that room counts.
  // FLOAT: the spot Pip is shown at. The one the person chose, unless something the page needs is there (a primary
  // button, the builder's minimap, the task companion, an open side sheet): then the nearest free spot, and back again
  // once the way is clear. Re-checked as the page changes; never while Pip is dragged, open, or under the pointer, so it
  // never moves away from a hand reaching for it.
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  // Owner workbench UI (stability, 23 Oct 2026): Pip is placed when a page opens (and once more as it settles), when the
  // window changes size and when a floating thing appears or leaves; never on a timer and never while the page scrolls.
  // The 0.8 s re-check walked every element and line of text on the page and moved Pip as the content scrolled under
  // it (with a layout animation and a page-length change each time): pages stuttered and Pip jumped about.
  useEffect(() => {
    // E2E-4P: a Pip placed by hand stays there too unless it would cover a control of the page (after a rotation it sat
    // on Start): then it steps to the nearest free spot, and goes back once the way is clear.
    if (!free || !pos || tucked || dragging) return;
    let frame = 0, later = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (document.hidden || menu || current || root.current?.matches(":hover")) return;
        const want = clampPip(pos.x, pos.y), room = lowRoom(), marked = keepOut(want, root.current);
        // The whole window along both side edges: first a spot clear of the page's controls; else the spot clear of what
        // is marked (header buttons, primary buttons, sheets, the companion) that covers the least of its controls.
        const all = Math.max(window.innerWidth, window.innerHeight);
        const controls = [...keepOut(want, root.current, AVOID, all), ...keepOut(want, root.current, CONTROLS, all)];
        const p = scanFloat(want, PIP, PIP, room, controls) ?? leastFloat(want, PIP, PIP, room, marked, controls) ?? placeFloat(want, PIP, PIP, room, marked);
        setSpot((s) => (s && Math.abs(s.x - p.x) < 1 && Math.abs(s.y - p.y) < 1 ? s : { x: p.x, y: p.y }));
      });
    };
    const soon = () => { window.clearTimeout(later); later = window.setTimeout(check, 250); };
    const settle = [0, 700, 2200].map((ms) => window.setTimeout(check, ms));
    window.addEventListener("resize", soon); window.addEventListener("pulse:float-changed", soon);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(later); settle.forEach((t) => window.clearTimeout(t)); window.removeEventListener("resize", soon); window.removeEventListener("pulse:float-changed", soon); };
  }, [free, pos, tucked, dragging, menu, current, pathname]);
  // While dragged, Pip is moved by direct style writes (dragMove) and the render leaves its position alone.
  const at = free && pos && !tucked ? spot ?? pos : pos;
  useLayoutEffect(() => {
    if (free || (!menu && !summary)) return;
    const place = () => {
      const button = root.current?.querySelector<HTMLElement>("[data-pip]")?.getBoundingClientRect();
      if (!button) return;
      for (const el of root.current?.querySelectorAll<HTMLElement>("[role=menu], [role=tooltip]") ?? []) anchorBelow(el, button, home === "centre");
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [free, menu, summary, home]);
  // FLOAT: a floating Pip's message opens above Pip, or beside it when above would cover something the page needs
  // (a phone's Next up button, a Save): whichever covers nothing. Set on the element, so nothing re-renders.
  useLayoutEffect(() => {
    const el = root.current, box = content.current;
    if (!el || !box || !current || el.dataset.home !== "free") { delete el?.dataset.msg; return; }
    const covers = () => { const r = box.getBoundingClientRect(); return keepOut({ x: r.left + r.width / 2 - PIP / 2, y: r.top + r.height / 2 - PIP / 2 }, el).some((o) => r.left < o.right - 1 && o.left < r.right - 1 && r.top < o.bottom - 1 && o.top < r.bottom - 1)
      || r.left < 0 || r.right > window.innerWidth || r.top < 0; };
    for (const where of ["above", "beside"]) { el.dataset.msg = where; if (!covers()) return; }
    el.dataset.msg = "above";
  }, [current, at]);
  useEffect(() => {
    const doc = document.documentElement;
    const main = document.getElementById("main-content");
    const top = tucked ? window.innerHeight - 120 - PIP : pos?.y;
    if (!free || top === undefined || !main || top + PIP / 2 < window.innerHeight / 2) { delete doc.dataset.pipGutter; doc.style.removeProperty("--pulse-pip-gutter"); doc.style.removeProperty("--pulse-pip-inline-gutter"); return; }
    const c = getComputedStyle(main);
    const reserve = c.overflowY === "visible" ? Number.parseFloat(c.paddingBottom) || 0 : 0;
    doc.dataset.pipGutter = "";
    doc.style.setProperty("--pulse-pip-inline-gutter", `${PIP + EDGE + 12}px`);
    doc.style.setProperty("--pulse-pip-gutter", `${Math.max(0, Math.round(window.innerHeight - top + 8 - reserve))}px`);
  }, [free, tucked, pos]);
  // UI-UPGRADE (R067): while the page scrolls, a floating Pip fades back so the text passing under it stays readable;
  // it comes back as soon as the page rests. Written on the element: scrolling never re-renders Pip.
  useEffect(() => {
    const el = root.current;
    if (!free || !el) return;
    let t = 0;
    const on = () => { if (!el.hasAttribute("data-scrolling")) el.setAttribute("data-scrolling", ""); window.clearTimeout(t); t = window.setTimeout(() => el.removeAttribute("data-scrolling"), 650); };
    document.addEventListener("scroll", on, { passive: true, capture: true });
    return () => { document.removeEventListener("scroll", on, { capture: true }); window.clearTimeout(t); el.removeAttribute("data-scrolling"); };
  }, [free]);
  useEffect(() => () => { delete document.documentElement.dataset.pipGutter; document.documentElement.style.removeProperty("--pulse-pip-gutter"); document.documentElement.style.removeProperty("--pulse-pip-inline-gutter"); }, []);
  useEffect(() => {
    // The eyes rest while Pip is dragged; one update per frame at most, none while the tab is hidden.
    if (!free || tucked || dragging) return;
    let frame = 0;
    const move = (e: PointerEvent) => {
      if (frame || document.hidden) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const el = root.current?.querySelector<HTMLElement>("[data-pip]"); if (!el || !root.current) return;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 220);
        // Far away, the eyes already look that way: nothing to restyle (every pointer move restyled Pip before).
        const look = `${Math.sign(dx)}${Math.sign(dy)}`;
        if (d > 360 && eyes.current === look) return;
        eyes.current = d > 360 ? look : "";
        root.current.style.setProperty("--pip-look-x", `${((dx / d) * 3.4 * k).toFixed(2)}px`);
        root.current.style.setProperty("--pip-look-y", `${((dy / d) * 2.6 * k).toFixed(2)}px`);
        const isNear = d < 170;
        setNear((n) => (n === isNear ? n : isNear));
      });
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => { window.removeEventListener("pointermove", move); cancelAnimationFrame(frame); };
  }, [free, tucked, dragging]);
  // What needs you is in Pip's menu from its first opening (the list is read once the page has settled).
  useEffect(() => { if (!personId) return; const t = window.setTimeout(() => void refreshNotices(), 2500); return () => window.clearTimeout(t); }, [personId]);
  // Opening the panel or Pip's menu means the new things were seen.
  useEffect(() => { const seenAll = () => setBadge(0); window.addEventListener("pulse:open-notices", seenAll); return () => window.removeEventListener("pulse:open-notices", seenAll); }, []);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), summary || menu ? 1000 : 30000); return () => window.clearInterval(t); }, [summary, menu]);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  // The summary follows the pointer itself, not only enter/leave events: those go missing when the node under the
  // pointer is replaced, and the summary then stayed open after the pointer had left.
  useEffect(() => {
    if (!summary) return;
    const t = window.setInterval(() => { if (!root.current?.matches(":hover")) setHover(false); }, 200);
    return () => window.clearInterval(t);
  }, [summary]);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(false); root.current?.querySelector<HTMLButtonElement>("[data-pip]")?.focus(); } };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key);
    window.setTimeout(() => root.current?.querySelector<HTMLElement>("[role=menuitem], [role=menuitemcheckbox]")?.focus(), 20);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [menu]);

  const payload = day.payload && (!personId || day.payload.person.id === personId) ? day.payload : null;
  const view = checkinView(payload, now + day.offset);
  // At rest Pip mirrors the day the other surfaces show (working, on a break, asleep after hours), or a problem.
  const dayMood = payload ? deriveView(payload as CompanionPayload, now + day.offset).mood : "idle";
  const resting: Mood = error ? "concerned" : comms.quiet || dayMood === "sleepy" ? "sleeping" : dayMood === "celebrate" ? "happy" : dayMood;
  const mood: Mood = current?.mood ?? (menu || summary ? "listening" : resting);
  const open = !!current;
  const count = badge;
  const label = `Pip${count ? `, ${count} new` : ""}. Open Pip’s menu`;
  const showMenu = (next: (m: boolean) => boolean) => { window.clearTimeout(hoverTimer.current); setHover(false); setMenu(next); setBadge(0); setError(null); void refreshNotices(); };
  const hoverSoon = (on: boolean) => { window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => setHover(on && !!root.current?.matches(":hover")), on ? HOVER_IN : HOVER_OUT); };
  const dnd = notices?.dnd ?? comms.dnd;
  async function setDnd(on: boolean) {
    try {
      const r = await fetch("/api/v0/companion/notification-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dnd: on }) });
      if (!r.ok) throw new Error();
      setComms((c) => ({ ...c, dnd: on })); void refreshNotices(true); window.dispatchEvent(new Event("pulse:poll-now"));
    } catch { enqueue({ id: `dnd:${++serial}`, mood: "concerned", tone: "error", title: "Do not disturb did not change", detail: "Try again in a moment." }); }
  }
  const menuMove = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem], [role=menuitemcheckbox]")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === "Tab") setMenu(false);
  };
  const unread = Math.max(comms.total, notices?.counts.unread ?? 0);
  const firstName = (payload?.person.name ?? "").split(" ")[0];

  // OWNER-PIP: free mode, position, dragging and the pointer-watching eyes.
  function remember(key: string, value: string | null) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode */ } }
  // Owner workbench UI (stability): a drag never re-renders Pip. The pointer is captured on press; each move only notes
  // where it is, and one write per frame moves Pip by transform (the room is read once, at the press). The spot is
  // committed (and remembered) on release, where it was dropped. Mouse, touch and pen alike.
  function dragStart(e: ReactPointerEvent<HTMLButtonElement>) {
    if (!free || tucked || !pos || e.button > 0) return;
    const from = at ?? pos;
    drag.current = { x: e.clientX, y: e.clientY, px: from.x, py: from.y, moved: false, room: windowRoom(), frame: 0, at: null };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function dragMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved) { d.moved = true; setDragging(true); setMenu(false); }
    d.at = clampTo(d.room, d.px + dx, d.py + dy);
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0; const el = root.current; if (!el || !d.at) return;
      el.style.setProperty("--pip-x", `${d.at.x}px`); el.style.setProperty("--pip-y", `${d.at.y}px`);
    });
  }
  function dragEnd() {
    const d = drag.current; drag.current = null;
    if (d?.frame) cancelAnimationFrame(d.frame);
    if (!d?.moved || !d.at) return;
    // UI-UPGRADE (R067): dropped anywhere, Pip settles into the nearer bottom corner of the page.
    const side: Side = d.at.x + PIP / 2 < window.innerWidth / 2 ? "left" : "right", s = pipCorner(side);
    dragged.current = true; placedByHand.current = true;
    remember("pulse.pip.pos", JSON.stringify({ x: side === "left" ? 0 : 1, y: 1 }));
    setByHand(true); setSpot(null); setPos(s); setDragging(false);
  }
  // FLOAT: the menu and messages open towards the larger free side and never past the window (or the tab bar).
  // Measured only while something opens beside Pip (every render measured the top bar and the tab bar before).
  const opens = free && at && (menu || summary || !!current) && typeof window !== "undefined" ? openSide(at, PIP, pipRoom()) : null;
  const side = opens?.side ?? "right";
  const vside = opens?.v ?? "bottom";
  const freeStyle = free && at ? ({ ...(dragging ? {} : { "--pip-x": `${at.x}px`, "--pip-y": `${at.y}px` }), "--pip-room": `${Math.round(Math.max(opens?.above ?? 0, opens?.below ?? 0) - 10)}px` } as CSSProperties) : undefined;
  // What needs the person, most urgent first (ATT's priorities): the menu lists the first three, each one tap away.
  const needs = (notices?.rows ?? []).filter((n) => priorityOf(n) !== "fyi" && (!n.readAt || (n.state === "open" && n.actions.length > 0)));
  const needCount = notices?.counts.important ?? needs.length;
  // Check in, break, check out: through the check-in control or My desk's card (they save the tap); with neither on
  // this page, My desk opens where the person can do it.
  const act = (id: string) => { setMenu(false); const detail = { id, handled: false }; window.dispatchEvent(new CustomEvent("pulse:checkin-act", { detail })); if (!detail.handled) router.push("/me?tab=attendance"); };
  const chipShown = menu && typeof document !== "undefined" && [...document.querySelectorAll<HTMLElement>("[data-shell-actions] [data-checkin-chip]")].some((el) => el.getBoundingClientRect().width > 0);
  const dayLine = !view.show ? null : view.state === "in" ? `Checked in · ${words(view.worked)} worked` : view.state === "break" ? `On a break · ${words(view.worked)} worked`
    : view.state === "done" ? `Done for today · ${words(view.worked)}` : view.state === "out" ? "Not checked in yet" : view.label;
  // Coming near wakes a sleeping Pip and makes an idle one lean in; it never overrides a message or the menu.
  const shownMood: Mood = !free || current || menu ? mood : dragging ? "happy" : near ? (mood === "sleeping" ? "waking" : mood === "idle" || mood === "in" ? "listening" : mood) : mood;
  const islandEl = (
      <div ref={root} className={css.island} data-island="" data-home={free ? "free" : home} data-tucked={free && tucked ? "" : undefined} data-drag={dragging ? "" : undefined} data-near={near ? "" : undefined} data-side={side} data-v={vside} style={freeStyle} data-open={open ? "" : undefined} data-tone={current?.tone} data-urgent={current?.urgent ? "" : undefined} data-moved={free && spot && pos && !dragging && (Math.abs(spot.x - pos.x) > 1 || Math.abs(spot.y - pos.y) > 1) ? "" : undefined}
        onPointerEnter={(e) => { pointer.current.pip = e.pointerType === "mouse"; void refreshNotices(); if (e.pointerType === "mouse") hoverSoon(true); }}
        onPointerLeave={() => { pointer.current.pip = false; hoverSoon(false); if (!open) pump.current(); }}
        onPointerDown={() => { window.clearTimeout(hoverTimer.current); setHover(false); }}>
        <div className={css.pill} data-island-pill="">
          <button type="button" data-pip="" className={css.pip} aria-label={label} aria-haspopup="menu" aria-expanded={menu} inert={open} tabIndex={open ? -1 : 0}
            onPointerDown={(e) => { press.current.type = e.pointerType; dragStart(e); }} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd}
            onContextMenu={(e) => { if (press.current.type === "mouse") return; e.preventDefault(); press.current.long = Date.now(); showMenu(() => true); }}
            onClick={() => { if (dragged.current) { dragged.current = false; return; } if (free && tucked) { setTucked(false); remember("pulse.pip.tucked", null); return; } if (Date.now() - press.current.long > LONG_PRESS) showMenu((m) => !m); }}>
            <span className={css.face} dangerouslySetInnerHTML={{ __html: pipSvg({ mood: shownMood, size: free ? 72 : 28, uid: "island" }) }} />
            {count && !open ? <span className={css.badge} aria-hidden="true">{count > 9 ? "9+" : count}</span> : null}
          </button>
          <div ref={content} data-island-content="" className={css.content} inert={!open}>
            {current ? <>
              <button type="button" className={css.line} onClick={() => { const go = current.open; finish(); go?.(); }} aria-label={`${current.title}${current.detail ? `. ${current.detail}` : ""}`}>
                <span className={css.lead}>{current.from ? <Avatar name={current.from.name} id={current.from.id} photoAt={current.from.photoAt} size={28} /> : <span className={css.leadPip} dangerouslySetInnerHTML={{ __html: pipSvg({ mood: current.mood, size: 28, uid: "island-lead" }) }} />}</span>
                <span className={css.text}><b>{current.title}</b>{current.detail ? <span>{current.detail}</span> : null}</span>
              </button>
              {current.action ? current.action.href
                ? <Link className={css.act} href={current.action.href} onClick={finish}>{current.action.label}</Link>
                : <button type="button" className={css.act} onClick={() => { const run = current.action!.run; finish(); run(); }}>{current.action.label}</button> : null}
              <button type="button" className={css.dismiss} aria-label="Dismiss" onClick={finish}>×</button>
            </> : null}
          </div>
        </div>
        {/* A live region without a role: pages keep their own status and alert lines to themselves. */}
        <p className={css.live} aria-live={current?.tone === "error" ? "assertive" : "polite"} aria-atomic="true">{current ? `${current.title}${current.detail ? `. ${current.detail}` : ""}` : ""}</p>
        {summary ? (
          <div className={css.card} role="tooltip">
            <p className={css.hello}>{firstName ? `Hi ${firstName}` : "Today"}</p>
            {view.show ? <p>{view.state === "in" ? `Checked in · ${words(view.worked)} worked` : view.state === "break" ? `On a break · ${words(view.worked)} worked` : view.state === "done" ? `Done for today · ${words(view.worked)}` : view.title}</p> : null}
            <p>{unread ? `${unread} unread${notices?.counts.action ? ` · ${notices.counts.action} need${notices.counts.action === 1 ? "s" : ""} you` : ""}` : "Nothing unread"}</p>
            {notices?.today ? <p>{notices.today.due ? `${notices.today.due} task${notices.today.due === 1 ? "" : "s"} due today` : "No tasks due today"}{notices.today.overdue ? ` · ${notices.today.overdue} overdue` : ""}</p> : null}
            {dnd ? <p className={css.quiet}>Do not disturb is on</p> : comms.quiet ? <p className={css.quiet}>{comms.quiet.replace(/ Turn off.*$/, "")}</p> : null}
          </div>
        ) : null}
        {menu ? (
          // FLOAT: one clear menu, every item named: the day (check in or out, in its real state), what needs you, Ask
          // Pip, quick create, then Pip's own settings. A list in a glass card beside Pip, never a ring of icons.
          <div className={css.menu} role="menu" aria-label="Pip" onKeyDown={menuMove}>
            <div className={css.menuHead} role="presentation">
              <b>{firstName ? `Hi ${firstName}` : "Pip"}</b>
              {dayLine ? <span>{dayLine}</span> : null}
            </div>
            {error ? <p className={css.menuError}>{error.title}{error.detail ? ` ${error.detail}` : ""}</p> : null}
            {/* FLOAT-2 (device audit): one check-in ask, not three: with the top bar's check-in chip on screen, the menu
                says how the day stands and leaves the button to the chip. */}
            {view.show && view.actions.length && !chipShown ? <div className={css.menuDay} role="group" aria-label="Today">
              {view.actions.map((a) => <button key={a.id} type="button" role="menuitem" data-label={a.label} data-primary={a.primary || view.actions.length === 1 ? "" : undefined} onClick={() => act(a.id)}><Clock3 size={16} aria-hidden="true" />{a.label}</button>)}
            </div> : null}
            {personId ? <div className={css.menuGroup} role="group" aria-label="Needs you">
              <p className={css.menuLabel} role="presentation">Needs you{needCount ? <b>{needCount > 99 ? "99+" : needCount}</b> : null}</p>
              {needs.slice(0, 3).map((n) => <button key={n.id} type="button" role="menuitem" className={css.need} data-label={n.title} aria-label={`${n.title}${n.from ? `, from ${n.from.name}` : ""}`} data-urgent={priorityOf(n) === "urgent" ? "" : undefined} onClick={() => { setMenu(false); openNotices(n.id); }}>
                {n.from ? <Avatar name={n.from.name} id={n.from.id} photoAt={n.from.photoAt} size={24} /> : <Bell size={16} aria-hidden="true" />}<span><b>{n.title}</b><small>{[n.from?.name, ago(n.at)].filter(Boolean).join(" · ")}</small></span></button>)}
              {notices && !needs.length ? <p className={css.menuQuiet} role="presentation">Nothing needs you right now.</p> : null}
              <button type="button" role="menuitem" data-label="Notifications" onClick={() => { setMenu(false); openNotices(); }}><Bell size={16} aria-hidden="true" />Notifications{unread ? <span>{unread > 99 ? "99+" : unread} unread</span> : null}</button>
            </div> : null}
            <div className={css.menuGroup} role="group" aria-label="Do">
              {canAsk ? <button type="button" role="menuitem" data-label="Ask Pip" onClick={() => { setMenu(false); window.dispatchEvent(new Event("pulse:ask-pip")); }}><Sparkles size={16} aria-hidden="true" />Ask Pip<span>about this page</span></button> : null}
              {personId ? <>
                <button type="button" role="menuitem" data-label="New task" onClick={() => { setMenu(false); openCreate({ kind: "task" }); }}><Plus size={16} aria-hidden="true" />New task<kbd>C</kbd></button>
                <button type="button" role="menuitem" data-label="New project" onClick={() => { setMenu(false); openCreate({ kind: "project" }); }}><FolderPlus size={16} aria-hidden="true" />New project</button>
              </> : null}
            </div>
            <div className={css.menuFoot} role="group" aria-label="Pip">
              {personId ? <button type="button" role="menuitemcheckbox" aria-checked={dnd} data-label={dnd ? "Do not disturb: on" : "Do not disturb"} onClick={() => { setMenu(false); void setDnd(!dnd); }}><Moon size={16} aria-hidden="true" />Do not disturb<i data-on={dnd ? "" : undefined} aria-hidden="true" /></button> : null}
              {free ? <button type="button" role="menuitem" data-label="Tuck Pip away" onClick={() => { setMenu(false); setTucked(true); remember("pulse.pip.tucked", "1"); }}><PanelRightClose size={16} aria-hidden="true" />Tuck Pip away<span>peeks from the edge</span></button> : null}
              <button type="button" role="menuitem" data-label={free ? "Put Pip in the top bar" : "Let Pip float free"} onClick={() => { setMenu(false); setFree(!free); remember("pulse.pip.dock", free ? "1" : null); }}><PanelTop size={16} aria-hidden="true" />{free ? "Put Pip in the top bar" : "Let Pip float free"}</button>
            </div>
          </div>
        ) : null}
      </div>
  );
  return (
    <>
      <span ref={slot} className={css.slot} aria-hidden="true" data-home={free ? "free" : home} />
      {free && typeof document !== "undefined" ? createPortal(islandEl, document.body) : islandEl}
    </>
  );
}

/** Settings → Devices → Get the apps: let Pip open in the top bar for arrivals, or keep it to a badge. */
export function IslandToggle() {
  const calm = useSyncExternalStore(onCalm, readCalm, () => false);
  const set = (on: boolean) => { try { if (on) localStorage.removeItem(CALM); else localStorage.setItem(CALM, "1"); window.dispatchEvent(new Event(CALM)); } catch { /* private mode */ } };
  return <label className={css.toggle}><input type="checkbox" checked={!calm} onChange={(e) => set(e.target.checked)} /> Pip shows what arrives, one at a time (off: only a count on Pip)</label>;
}
