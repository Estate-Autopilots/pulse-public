"use client";
// NEW-DOTS-2 (owner, 10 Nov 2026: "It should highlight the specific place, or take me straight to where I should click.
// If the New task button in Work is updated, that button should be highlighted too … Add micro-interactions and
// animations that take you to the exact location."). On a page with new things (a release note's line with an `anchor`,
// lib/new-anchors.json), this draws:
//   - a red dot on each thing, and on each menu or tab on the way to one (with how many wait inside) while it is closed;
//   - "Show me": the page dims, the light closes in on the thing (opening the menu or tab on the way, scrolling to it), a
//     soft glow rings it, and a small card says what is new, with "1 of 3", Got it and Next;
//   - a tiny sparkle as it clears. Reaching the thing (Got it, Next, or using it) clears it on the server.
// The pattern (a dimmed page with a cut-out, a card beside it) is the one tour libraries use (Driver.js, MIT; Shepherd.js
// is AGPL, so it was only looked at); this is our own small version, no code copied.
// prefers-reduced-motion, the app's reduced motion or Fun effects off: no gliding, no pulsing, no sparkle; a still ring.
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import registryJson from "./lib/new-anchors.json";
import type { NewDotsItem } from "./lib/new-dots.mjs";
import { pageDots, stepOf, stepsOn, type AnchorRegistry, type Step } from "./lib/new-trail.mjs";
import css from "./new-trail.module.css";

const registry = registryJson as AnchorRegistry;
/** window event: start the tour on this page (detail { anchor? }: that thing first). The "New: …" line's Show me sends it. */
export const NEW_DOTS_SHOW = "pulse:new-dots-show";

type Box = { top: number; left: number; width: number; height: number; radius: string };
type Tour = { steps: Step[]; i: number; path: string; n: number };

const sel = (id: string) => `[data-new-anchor="${CSS.escape(id)}"]`;
/** The first element with this id that is on screen (a phone and a computer may each show their own copy). */
function shown(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(sel(id))) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden") return el;
  }
  return null;
}
/** Whether it is on screen and nothing covers it (a dialog, a drawer, another menu): its middle is itself. */
function inSight(el: HTMLElement, r: DOMRect) {
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
  const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
  const top = document.elementFromPoint(x, y);
  return !!top && (el === top || el.contains(top) || top.contains(el));
}
const isOpen = (el: HTMLElement | null) => !!el && (el.getAttribute("aria-expanded") === "true" || el.getAttribute("aria-selected") === "true"
  || el.getAttribute("aria-current") === "page" || (el instanceof HTMLDetailsElement && el.open));
/** No motion: the person asked for less (their system, the app's setting, or Fun effects off). */
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.fun === "off"
  || document.documentElement.dataset.motion === "reduced" || document.documentElement.dataset.reducedMotion === "true";
const pause = (ms: number) => new Promise<void>((done) => window.setTimeout(done, ms));
async function appears(id: string, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(80)) { const el = shown(id); if (el) return el; }
  return null;
}
/** Waits for a smooth scroll to end (the box holds still for a few frames). */
async function settles(el: HTMLElement) {
  let last = "", same = 0;
  for (const end = Date.now() + 900; Date.now() < end && same < 3; await new Promise((r) => requestAnimationFrame(r))) {
    const r = el.getBoundingClientRect(), now = `${Math.round(r.top)} ${Math.round(r.left)}`;
    same = now === last ? same + 1 : 0; last = now;
  }
}
/** The menu (the app's layer, else the list) a thing sits in, if any. */
const menuOf = (el: HTMLElement | null | undefined) => el?.closest<HTMLElement>("[data-layer]") ?? el?.closest<HTMLElement>('[role="menu"], [role="listbox"]') ?? null;
const radiusOf = (el: Element) => parseFloat(getComputedStyle(el).borderTopLeftRadius) || 8;
/** The box of what an element shows (its words and icon), not its padding: a count on a menu button sits on "More ⌄". */
function contentOf(el: HTMLElement): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(el);
  const r = range.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : el.getBoundingClientRect();
}

/** Where the light goes: around the thing, or around the whole menu it is in (the menu reads as one card; the thing
 *  inside gets its own ring). */
const boxOf = (el: HTMLElement): Box => {
  const host = menuOf(el) ?? el, pad = host === el ? 6 : 3;
  const r = host.getBoundingClientRect();
  return { top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2, radius: `${Math.min(radiusOf(host) + pad, 999)}px` };
};
const noSubscribe = () => () => {};

/** A layer in the browser's top layer (popover="manual"), like the app's menus (kit/layer.tsx): a menu opened on the way
 *  is in the top layer too, so the light and the dots must be shown after it to sit above it. `key` changes → shown
 *  again (on top). Browsers without popovers ignore the attribute and use the z-index. */
function useTopLayer(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.showPopover !== "function") return;
    // Hiding a layer drops the focus inside it; it goes back where it was.
    const had = document.activeElement;
    try { if (el.matches(":popover-open")) el.hidePopover(); el.showPopover(); } catch { /* detached, or not supported */ }
    if (had instanceof HTMLElement && had !== document.activeElement && document.contains(had)) had.focus({ preventScroll: true });
  }, [key]);
  return ref;
}

export function NewTrail({ items, path, on, autoStart, onReach }: { items: NewDotsItem[]; path: string; on: boolean;
  /** Arrived through a dot or What's new ("take me there"): start the tour (with this thing first, when named). */ autoStart: { anchor: string; n: number } | null;
  /** The thing was reached: clear it on the server. */ onReach: (step: Step) => void }) {
  const router = useRouter();
  const client = useSyncExternalStore(noSubscribe, () => true, () => false);
  const steps = useMemo(() => (on ? stepsOn(items, path, registry) : []), [items, path, on]);
  const [, redraw] = useState(0);
  const [tour, setTour] = useState<Tour | null>(null);
  // The light: where it is (`box`), on what (`el`, the thing of step `key`); `intro`: the whole window, before it closes in.
  const [spot, setSpot] = useState<{ el: HTMLElement | null; box: Box; key: string } | null>(null);
  const [sparks, setSparks] = useState<{ id: number; x: number; y: number }[]>([]);
  const card = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const clicking = useRef(false);
  const handled = useRef(0);
  const titleId = useId();
  // A tour belongs to its page (leaving it ends the tour, adjusted while rendering) and to dots being on.
  const [tourPage, setTourPage] = useState(path);
  if (tourPage !== path) { setTourPage(path); setTour(null); setSpot(null); }
  const live = tour && tour.path === path && on ? tour : null;
  const step = live?.steps[live.i] ?? null;
  const ready = !!(step && spot?.el && spot.key === step.anchor);

  // Redraw the page's dots, and move the light, when the page moves (scroll, resize, a menu opening): once a frame at most.
  useEffect(() => {
    if (!steps.length && !live) return;
    let frame = 0;
    const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; redraw((t) => t + 1); setSpot((s) => (s?.el ? { ...s, box: boxOf(s.el) } : s)); }); };
    addEventListener("scroll", later, { capture: true, passive: true });
    addEventListener("resize", later, { passive: true });
    const every = window.setInterval(later, 400);
    return () => { removeEventListener("scroll", later, { capture: true }); removeEventListener("resize", later); window.clearInterval(every); cancelAnimationFrame(frame); };
  }, [steps.length, live]);

  const sparkle = useCallback((el: HTMLElement | null | undefined) => {
    if (!el || calm()) return;
    const r = el.getBoundingClientRect(), id = Date.now() + Math.random();
    setSparks((s) => [...s, { id, x: r.left + r.width / 2, y: r.top + r.height / 2 }]);
    window.setTimeout(() => setSparks((s) => s.filter((p) => p.id !== id)), 900);
  }, []);
  const reach = useCallback((s: Step, el: HTMLElement | null | undefined) => { sparkle(el); onReach(s); }, [onReach, sparkle]);
  const close = useCallback(() => { setTour(null); setSpot(null); }, []);

  // Using a new thing (clicking it) is reaching it, with or without the tour; the tour's own clicks on the way are not.
  useEffect(() => {
    if (!steps.length) return;
    const used = (e: Event) => {
      if (clicking.current) return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-new-anchor]");
      const s = el && steps.find((x) => x.anchor === el.dataset.newAnchor);
      if (s && !card.current?.contains(e.target as Node)) { reach(s, el); close(); }
    };
    document.addEventListener("click", used, true);
    return () => document.removeEventListener("click", used, true);
  }, [steps, reach, close]);

  // Go to the tour's current thing: open the page's tab, then what is on the way, scroll to it, then put the light on it.
  useEffect(() => {
    if (!live) return;
    const s = live.steps[live.i];
    let gone = false;
    void (async () => {
      if (!shown(s.anchor) && s.href !== s.route && `${location.pathname}${location.search}` !== s.href) { router.push(s.href); await pause(250); }
      // A page that is still loading (its skeleton first) gets a while to show the thing or the way to it.
      for (const v of s.via) {
        const way = shown(s.anchor) ? null : await appears(v, 8000);
        if (gone) return;
        if (!way || shown(s.anchor) || isOpen(way)) continue;
        way.scrollIntoView({ block: "nearest", behavior: calm() ? "auto" : "smooth" });
        await pause(calm() ? 0 : 260);
        if (gone) return;
        clicking.current = true;
        try { way.click(); } finally { clicking.current = false; }
      }
      const el = await appears(s.anchor, 10000);
      if (gone) return;
      if (!el) { setTour(live.i + 1 < live.steps.length ? { ...live, i: live.i + 1 } : null); return; }
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: calm() ? "auto" : "smooth" });
      await settles(el);
      if (!gone) setSpot({ el, box: boxOf(el), key: s.anchor });
    })();
    return () => { gone = true; };
  }, [live, router]);

  // A new tour starts with the light on the whole window, then it closes in on the thing (the "this way" moment).
  const start = useCallback((first?: string) => {
    const list = stepsOn(items, location.pathname, registry);
    if (!list.length) return;
    const at = first ? list.findIndex((s) => s.anchor === first) : -1;
    const ordered = at > 0 ? [list[at], ...list.slice(0, at), ...list.slice(at + 1)] : list;
    setSpot(calm() ? null : { el: null, box: { top: 0, left: 0, width: innerWidth, height: innerHeight, radius: "0px" }, key: "" });
    setTour({ steps: ordered, i: 0, path: location.pathname, n: Date.now() });
  }, [items]);

  useEffect(() => {
    const show = (e: Event) => { const d = (e as CustomEvent).detail as { anchor?: string } | undefined; start(d?.anchor); };
    addEventListener(NEW_DOTS_SHOW, show);
    return () => removeEventListener(NEW_DOTS_SHOW, show);
  }, [start]);
  // Once per "take me there", when the page's things are known and the page shows one of them, or a menu on the way to
  // one (a page may first show its loading skeleton; up to 20 s). The visit itself changes the list a moment later (its
  // page is now opened), so the timer calls the newest `start` and reads the newest steps.
  const auto = autoStart?.n ?? 0, first = autoStart?.anchor ?? "", has = steps.length > 0;
  const startNow = useRef(start), stepsNow = useRef(steps);
  useEffect(() => { startNow.current = start; stepsNow.current = steps; }, [start, steps]);
  useEffect(() => {
    if (!auto || !has || handled.current === auto) return;
    const until = Date.now() + 20_000;
    const t = window.setInterval(() => {
      const there = stepsNow.current.some((s) => shown(s.anchor) || s.via.some((v) => shown(v)));
      if (!there && Date.now() < until) return;
      window.clearInterval(t);
      handled.current = auto;
      startNow.current(first);
    }, 250);
    return () => window.clearInterval(t);
  }, [auto, first, has]);

  // Escape closes, and so does a tap anywhere but the card and the thing; the card's main button has the focus.
  useEffect(() => {
    if (!live) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (card.current?.contains(t) || spot?.el?.contains(t)) return;
      close();
    };
    addEventListener("keydown", key, true);
    addEventListener("pointerdown", away, true);
    return () => { removeEventListener("keydown", key, true); removeEventListener("pointerdown", away, true); };
  }, [live, spot, close]);
  const at = live?.i ?? -1;
  // While the light is on, floating helpers (the assistant's bubble) step aside: they would sit in the cut-out.
  const touring = !!live;
  useEffect(() => {
    if (!touring) return;
    document.documentElement.dataset.newTouring = "";
    // ...and so do tooltips left open by the click that started it (a rail tooltip would cover the panel).
    const floats = [...document.querySelectorAll<HTMLElement>('[data-island], [role="tooltip"]')].map((el) => [el, el.style.visibility] as const);
    for (const [el] of floats) el.style.visibility = "hidden";
    return () => { delete document.documentElement.dataset.newTouring; for (const [el, was] of floats) el.style.visibility = was; };
  }, [touring]);
  // A thing inside a menu keeps the focus itself (a menu closes when the focus leaves it; Enter then uses the thing);
  // anywhere else the card's main button takes it. The card is read out either way (the status line below).
  const inMenu = !!spot?.el?.closest('[role="menu"], [role="listbox"]');
  useEffect(() => { if (ready) (inMenu ? spot?.el : primary.current)?.focus({ preventScroll: true }); }, [ready, at, inMenu, spot?.el]);

  const next = () => {
    if (!live || !step) return;
    reach(step, spot?.el);
    setTour(live.i + 1 < live.steps.length ? { ...live, i: live.i + 1 } : null);
    if (live.i + 1 >= live.steps.length) setSpot(null);
  };
  const gotIt = () => { if (step) reach(step, spot?.el); close(); };

  // The dots on the page (none while the light is on: the card says it).
  const marks = client && !live ? pageDots(steps, (id) => isOpen(shown(id))).map((d) => {
    const el = shown(d.anchor), whole = el?.getBoundingClientRect();
    if (!el || !whole || !inSight(el, whole)) return null;
    // A menu or tab on the way: its count sits on what it shows. A thing in an open menu: a tinted row with the dot in it.
    return { ...d, r: d.way ? contentOf(el) : whole, radius: radiusOf(el), inMenu: !d.way && !!menuOf(el) };
  }).filter((m): m is NonNullable<typeof m> => !!m) : [];

  const box = live ? spot?.box ?? null : null;
  const W = client ? innerWidth : 1440, H = client ? innerHeight : 900;
  // The card keeps clear of the window's edges: 24px on a computer, 12px on a phone.
  const edge = W >= 600 ? 24 : 12;
  const cardW = Math.min(340, W - edge * 2);
  // The card never covers the thing, nor the menu it is in: beside the menu when there is room (a computer), else below
  // or above the thing (or its menu). No measuring: the card is pinned by its top edge below, by its bottom edge above.
  const menu = ready ? menuOf(spot?.el) : null;
  const holder = menu?.getBoundingClientRect() ?? null;
  const thing = ready && spot?.el ? spot.el.getBoundingClientRect() : null;
  const aim = thing ?? (box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null);
  const around = holder && box ? { top: Math.min(holder.top, box.top), left: holder.left, width: holder.width, height: Math.max(holder.bottom, box.top + box.height) - Math.min(holder.top, box.top) } : box;
  // A thing in a menu: the card goes under the menu when there is room (it then covers no words of the page beside it),
  // else beside it, else below or above it.
  const roomUnder = holder ? H - holder.bottom - 14 >= 200 : false;
  const side = holder && box && !roomUnder ? (holder.left - 14 - cardW >= edge ? "left" : W - holder.right - 14 - cardW >= edge ? "right" : null) : null;
  const below = around ? H - (around.top + around.height) >= 230 || H - (around.top + around.height) >= around.top : true;
  const cardTop = !aim || !around ? 0 : side ? Math.min(Math.max(aim.top + aim.height / 2 - 40, edge), H - 220) : below ? Math.min(around.top + around.height + 18, H - 140) : around.top - 18;
  const cardLeft = !aim || !around ? 0 : side === "left" ? holder!.left - 14 - cardW : side === "right" ? holder!.right + 14
    : holder && roomUnder ? Math.min(Math.max(holder.right - cardW, edge), W - cardW - edge) : Math.min(Math.max(aim.left + aim.width / 2 - cardW / 2, edge), W - cardW - edge);
  const arrowX = aim ? Math.min(Math.max(aim.left + aim.width / 2 - cardLeft, 20), cardW - 20) : 0;
  const arrowY = aim ? Math.min(Math.max(aim.top + aim.height / 2 - cardTop, 20), 120) : 0;
  // When a menu opens on a new thing (by hand, not on a tour), the focus starts on that thing instead of the first row.
  const menuNew = marks.find((m) => m.inMenu)?.anchor ?? "";
  useEffect(() => {
    if (!menuNew) return;
    const el = shown(menuNew), now = document.activeElement;
    if (el && now instanceof HTMLElement && now !== el && (now.getAttribute("role") ?? "").startsWith("menuitem") && menuOf(now) === menuOf(el)) el.focus({ preventScroll: true });
  }, [menuNew]);
  const marksRef = useTopLayer(`${marks.map((m) => m.anchor).join(" ")}|${sparks.length}`);
  const lightRef = useTopLayer(`${live?.n ?? 0}|${spot?.key ?? ""}|${ready}`);
  const last = live ? live.i + 1 >= live.steps.length : true;

  return <>
    {client && (marks.length || sparks.length) ? <div ref={marksRef} popover="manual" className={css.top} data-new-marks="">
    {marks.map((m) => <span key={m.anchor} className={css.mark} aria-hidden="true" data-new-mark={m.anchor} data-way={m.way ? "" : undefined} data-inmenu={m.inMenu ? "" : undefined}
      style={{ "--l": `${Math.round(m.r.left)}px`, "--t": `${Math.round(m.r.top)}px`, "--w": `${Math.round(m.r.width)}px`, "--h": `${Math.round(m.r.height)}px`, "--r": `${Math.min(m.radius + 4, 999)}px` } as CSSProperties}>
      {m.way ? null : <i className={css.ring} />}
      {m.inMenu ? <i className={css.newTag}>New</i>
        : <i className={css.dot} data-count={m.way ? "" : undefined}>{m.way ? (m.count > 9 ? "9+" : m.count) : null}</i>}
    </span>)}
    {sparks.map((s) => <span key={s.id} className={css.sparkle} style={{ left: s.x, top: s.y }} aria-hidden="true">
      {Array.from({ length: 8 }, (_, k) => <i key={k} style={{ "--a": `${k * 45}deg` } as CSSProperties} />)}</span>)}
    </div> : null}
    {live && box ? <div ref={lightRef} popover="manual" className={`${css.top} ${css.layer}`} data-new-spotlight="" data-ready={ready ? "" : undefined}>
      <div className={css.hole} data-menu={menu ? "" : undefined} style={{ top: box.top, left: box.left, width: box.width, height: box.height, borderRadius: box.radius }} />
      {/* A thing inside a menu: the whole menu is lit at full brightness, the thing in a glowing ring. */}
      {menu && thing && spot?.el ? <div className={css.thingRing} style={{ top: thing.top - 3, left: thing.left - 3, width: thing.width + 6, height: thing.height + 6, borderRadius: radiusOf(spot.el) + 3 }} /> : null}
      {ready && step ? <div ref={card} key={step.anchor} className={css.card} role="dialog" aria-modal="false" aria-labelledby={titleId}
        data-below={!side && below ? "" : undefined} data-side={side ?? undefined}
        style={{ top: cardTop, left: cardLeft, width: cardW, "--arrow-x": `${arrowX}px`, "--arrow-y": `${arrowY}px` } as CSSProperties}>
        <div className={css.cardHead}>
          <span className={css.chip}>New</span>
          <span className={css.where}>{step.label}</span>
          <button type="button" className={css.close} aria-label="Close" onClick={close}><X size={16} aria-hidden="true" /></button>
        </div>
        <h2 id={titleId} className={css.title}>{step.text}</h2>
        <p className={css.said} role="status">{`New: ${step.text}. ${step.label}.${live.steps.length > 1 ? ` ${stepOf(live.i, live.steps.length)}.` : ""}`}</p>
        <div className={css.actions}>
          {live.steps.length > 1 ? <span className={css.count}>{stepOf(live.i, live.steps.length)}</span> : null}
          {last ? <button ref={primary} type="button" className={css.primary} onClick={gotIt}>Got it</button>
            : <><button type="button" className={css.quiet} onClick={gotIt}>Got it</button>
              <button ref={primary} type="button" className={css.primary} onClick={next}>Next<span aria-hidden="true"> →</span></button></>}
        </div>
      </div> : null}
    </div> : null}
  </>;
}
