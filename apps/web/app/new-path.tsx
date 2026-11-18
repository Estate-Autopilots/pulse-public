"use client";
// NAV-CONNECT (owner, 17 Nov 2026: "The new-update pop-up highlights the wrong thing, just one thing at the top, and
// doesn't take you to the specific item arrow by arrow"). What's new's Show me leads the way, one step at a time, each
// with an arrow and a card saying what changed: the rail's group → the page in that group's list → the page → the thing
// (lib/new-path.mjs has the rules). Next, or using the lit thing, goes on; Escape, × or a tap elsewhere ends it. A change
// the release names no thing for ends on the page and says so ("on this page as a whole"); it never lights a guess, and
// never the page's title. A thing the release note itself names is handed to NEW-DOTS-2's tour on its page (new-trail.tsx),
// which also clears it on the server. The look is the tour's (new-trail.module.css): the dimmed page, the lit cut-out.
import { NAV_SHOW_GROUP, type NavSpot } from "@pulse/ui-shell";
import { X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import registryJson from "./lib/new-anchors.json";
import { PATH_KEY, inferAnchor, pathFrom, pathPlan, stepWords, type NavPath, type PathStep } from "./lib/new-path.mjs";
import { anchorEntry, pathOf, TRAVEL_KEY, type AnchorRegistry } from "./lib/new-trail.mjs";
import { NEW_DOTS_SHOW } from "./new-trail";
import css from "./new-trail.module.css";

const registry = registryJson as AnchorRegistry;
/** window event: the stored path changed (started, moved on, ended). */
export const NEW_PATH_EVENT = "pulse:new-path";

const read = () => { try { return pathFrom(JSON.parse(sessionStorage.getItem(PATH_KEY) ?? "null")); } catch { return null; } };
const save = (p: NavPath | null) => {
  try { if (p) sessionStorage.setItem(PATH_KEY, JSON.stringify(p)); else sessionStorage.removeItem(PATH_KEY); } catch { /* private mode: no path, links still open */ }
  window.dispatchEvent(new Event(NEW_PATH_EVENT));
};
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.fun === "off" || document.documentElement.dataset.motion === "reduced";
const pause = (ms: number) => new Promise<void>((done) => window.setTimeout(done, ms));
const visible = (el: Element | null): el is HTMLElement => !!el && el instanceof HTMLElement && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
async function appears(selector: string, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(80)) { const el = [...document.querySelectorAll(selector)].find(visible); if (el) return el; }
  return null;
}
const quoted = (s: string) => JSON.stringify(s);
/** The rail and its lists show: a computer with a mouse, the rail on screen. */
const railShows = () => matchMedia("(hover: hover) and (pointer: fine)").matches && visible(document.querySelector("#pulse-rail"));

/** Starts the path to a change (What's new's Show me). False when there is nothing to lead to (the link then just opens). */
export function startPath(x: { route: string; anchor?: string; href: string; text: string }): boolean {
  if (typeof window === "undefined" || !x.route.startsWith("/")) return false;
  const find = (window as unknown as { __pulseNavFind?: (route: string) => NavSpot | null }).__pulseNavFind;
  const own = x.anchor && anchorEntry(registry, x.anchor) ? x.anchor : "";
  const anchor = own || inferAnchor({ route: x.route, text: x.text }, registry);
  const steps = pathPlan({ route: x.route, anchor, here: location.pathname, spot: find?.(x.route) ?? null, rail: railShows() });
  const at = anchor ? anchorEntry(registry, anchor)?.href : null;
  save({ route: pathOf(x.route), href: at && pathOf(at) === pathOf(x.route) ? at : x.href, text: x.text.slice(0, 400), anchor, inferred: !own && !!anchor, steps, i: 0, at: Date.now() });
  return true;
}

type Spot = { el: HTMLElement; key: string };
const noSubscribe = () => () => {};

export function NewPath() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const client = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [path, setPath] = useState<NavPath | null>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [, redraw] = useState(0);
  const primary = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const sync = () => setPath(read());
    sync();
    addEventListener(NEW_PATH_EVENT, sync);
    return () => removeEventListener(NEW_PATH_EVENT, sync);
  }, []);
  const step: PathStep | null = path?.steps[path.i] ?? null;
  const onRoute = !!path && (path.route === "/" || pathOf(pathname) === path.route);
  const key = path ? `${path.at}:${path.i}:${onRoute}` : "";

  const close = useCallback(() => { save(null); setSpot(null); window.dispatchEvent(new CustomEvent(NAV_SHOW_GROUP, { detail: { group: null } })); }, []);
  const advance = useCallback(() => {
    const p = read();
    if (!p) return;
    if (p.i + 1 >= p.steps.length) { close(); return; }
    setSpot(null);
    save({ ...p, i: p.i + 1, at: Date.now() });
  }, [close]);

  // The last step is on the change's page: the path opens it (after the menu step, or when that was not shown).
  useEffect(() => {
    if (path && step && (step.kind === "thing" || step.kind === "page" || step.kind === "note") && !onRoute) router.push(path.href);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Find this step's element, opening what is on the way.
  useEffect(() => {
    if (!path || !step) return;
    let gone = false, keep = 0;
    void (async () => {
      let el: HTMLElement | null = null;
      if (step.kind === "rail") el = await appears(`#pulse-rail [data-nav-id=${quoted(`rail:${step.group}`)}]`, 3000);
      else if (step.kind === "menu") {
        const show = () => window.dispatchEvent(new CustomEvent(NAV_SHOW_GROUP, { detail: { group: step.group } }));
        show();
        el = await appears(`#pulse-flyout-${step.group} [data-nav-id=${quoted(`fly:${step.href}`)}]`, 2500);
        // The list stays shown while this step does (a pointer passing over the rail would fold it).
        keep = window.setInterval(() => { if (!document.querySelector(`#pulse-flyout-${step.group}`)) show(); }, 400);
      } else if (!onRoute) return;
      else if (step.kind === "thing" && !path.inferred) {
        // The release note names this thing: NEW-DOTS-2's tour on the page lights it and clears it on the server.
        try { sessionStorage.setItem(TRAVEL_KEY, JSON.stringify({ route: path.route, anchor: path.anchor, at: Date.now() })); } catch { /* the dots still lead */ }
        window.dispatchEvent(new CustomEvent(NEW_DOTS_SHOW, { detail: { anchor: path.anchor } }));
        save(null);
        return;
      } else if (step.kind === "thing") {
        for (const v of anchorEntry(registry, path.anchor)?.via ?? []) {
          const way = await appears(`[data-new-anchor=${quoted(v)}]`, 8000);
          if (gone) return;
          if (way && way.getAttribute("aria-expanded") !== "true") way.click();
        }
        el = await appears(`[data-new-anchor=${quoted(path.anchor)}]`, 10000);
        if (el && !gone) { el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: calm() ? "auto" : "smooth" }); await pause(calm() ? 0 : 380); }
      } else {
        // The page as a whole, or the note on it: the page's content once it has loaded.
        el = await appears("#main-content", 8000);
        // The page as a whole is shown once it has loaded (not its skeleton): up to 10 s more.
        for (const end = Date.now() + 10_000; el && Date.now() < end && el.querySelector('[aria-busy="true"], [data-skeleton], [class*="skeleton" i]'); await pause(150)) if (gone) return;
      }
      if (gone) return;
      // A step whose element is not there (a page hidden from the person's menu, a page still loading for too long):
      // the path goes on without it; at the end it says the page.
      if (!el) { if (step.kind === "rail" || step.kind === "menu") advance(); else if (step.kind === "thing") save({ ...path, steps: [...path.steps.slice(0, path.i), { kind: "page", label: "This page" }], at: Date.now() }); else close(); return; }
      setSpot({ el, key });
    })();
    return () => { gone = true; window.clearInterval(keep); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = !!(spot && spot.key === key && step && path);
  // Follow the page as it moves (scroll, resize, a list folding open), once a frame at most.
  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; redraw((n) => n + 1); }); };
    addEventListener("scroll", later, { capture: true, passive: true });
    addEventListener("resize", later, { passive: true });
    const every = window.setInterval(later, 300);
    return () => { removeEventListener("scroll", later, { capture: true }); removeEventListener("resize", later); window.clearInterval(every); cancelAnimationFrame(frame); };
  }, [ready]);
  // Using the lit thing goes on: the rail's icon shows its list (not its first page), the page's link opens it.
  useEffect(() => {
    if (!ready || !spot || !step) return;
    const used = (e: MouseEvent) => {
      if (!spot.el.contains(e.target as Node)) return;
      if (step.kind === "rail") { e.preventDefault(); e.stopPropagation(); advance(); }
      else if (step.kind === "menu") advance();
      else close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!card.current?.contains(t) && !spot.el.contains(t) && !document.querySelector("[id^='pulse-flyout-']")?.contains(t)) close(); };
    document.addEventListener("click", used, true);
    addEventListener("keydown", onKey, true);
    addEventListener("pointerdown", away, true);
    return () => { document.removeEventListener("click", used, true); removeEventListener("keydown", onKey, true); removeEventListener("pointerdown", away, true); };
  }, [ready, spot, step, advance, close]);
  useEffect(() => { if (ready) primary.current?.focus({ preventScroll: true }); }, [ready, key]);
  // While the path shows, floating helpers (the assistant's bubble) step aside, as on NEW-DOTS-2's tour.
  useEffect(() => {
    if (!ready) return;
    document.documentElement.dataset.newTouring = "";
    // The rail and list steps soften the page behind (new-trail.module.css), so cut-off words never compete with the card.
    if (step) document.documentElement.dataset.newPathStep = step.kind;
    const floats = [...document.querySelectorAll<HTMLElement>('[data-island], [role="tooltip"]')].map((el) => [el, el.style.visibility] as const);
    for (const [el] of floats) el.style.visibility = "hidden";
    return () => { delete document.documentElement.dataset.newTouring; delete document.documentElement.dataset.newPathStep; for (const [el, was] of floats) el.style.visibility = was; };
  }, [ready, step]);
  // The rail step lights its icon as a hover would (solid violet), not only ringed.
  useEffect(() => {
    if (!ready || !step || (step.kind !== "rail" && step.kind !== "menu") || !spot) return;
    const icon = step.kind === "rail" ? spot.el : document.querySelector<HTMLElement>(`#pulse-rail [data-nav-id="rail:${step.group}"]`);
    icon?.setAttribute("data-path-lit", "");
    return () => icon?.removeAttribute("data-path-lit");
  }, [ready, step, spot]);

  if (!client || !ready || !spot || !step || !path) return null;
  if (step.kind === "note") {
    // In the page's own flow (the shell's #pulse-page-note slot at the top of the main area), so it covers nothing.
    const slot = document.getElementById("pulse-page-note");
    const banner = <div ref={card} key={key} className={css.noteBar} role="status" aria-labelledby={titleId} data-new-path="note">
      <span className={css.chip}>New</span>
      <p id={titleId}><b>{path.text}</b><small>{step.label}{path.steps.length > 1 ? ` · ${stepWords(path.i, path.steps.length)}` : ""}</small></p>
      <button ref={primary} type="button" className={css.primary} onClick={close}>Got it</button>
      <button type="button" className={css.close} aria-label="Close" onClick={close}><X size={16} aria-hidden="true" /></button>
    </div>;
    return slot ? createPortal(banner, slot) : createPortal(<div className={css.top}>{banner}</div>, document.body);
  }
  const W = innerWidth, H = innerHeight, edge = W >= 600 ? 24 : 12, cardW = Math.min(340, W - edge * 2);
  const r = spot.el.getBoundingClientRect();
  const whole = step.kind === "page";
  // The group's list is lit as one card, the page's row in it ringed (as NEW-DOTS-2 lights a thing inside a menu).
  const flyout = step.kind === "menu" ? spot.el.closest<HTMLElement>("[id^='pulse-flyout-']")?.getBoundingClientRect() ?? null : null;
  // The page as a whole: the light goes around what the page shows (its sections, on screen), not the whole content
  // column, so the frame sits inside the window with room on every side; the card waits under it, pointing up.
  const shown = whole ? [...spot.el.querySelectorAll<HTMLElement>(":scope > * > *")].map((x) => x.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < H) : [];
  const page = whole && shown.length ? { top: Math.min(...shown.map((b) => b.top)), left: Math.min(...shown.map((b) => b.left)), right: Math.max(...shown.map((b) => b.right)), bottom: Math.max(...shown.map((b) => b.bottom)) } : null;
  // The page's frame keeps 20 px from the window and runs to the window's foot, so the card can wait inside it.
  const lit = flyout ?? (page ? { top: Math.max(page.top, 8), left: page.left, width: Math.min(page.right, W - 24) - page.left, height: H - 32 - Math.max(page.top, 8), right: Math.min(page.right, W - 24), bottom: H - 32 } : r);
  // Where the light goes: around the icon, the list, the thing or the page's sections (a little room).
  const pad = whole ? 18 : flyout ? 0 : 6;
  const box = { top: Math.max(lit.top - pad, 4), left: lit.left - pad, width: lit.width + pad * 2, height: Math.min(lit.height + pad * 2, H - 8 - Math.max(lit.top - pad, 4)) };
  const radius = whole ? 16 : flyout ? 16 : Math.min((parseFloat(getComputedStyle(spot.el).borderTopLeftRadius) || 8) + pad, 999);
  // The card: beside the rail's icon or the list (right of it, its pointer level with the row), else under or above
  // what is lit (the page's sections too).
  const side = step.kind === "rail" || step.kind === "menu" || (step.kind === "thing" && r.width < 120 && W - r.right - 30 >= cardW);
  const holderRight = (flyout?.right ?? r.right) + (flyout ? 8 : 0);
  const roomBelow = H - (box.top + box.height) >= 230;
  const aim = whole ? { top: box.top, left: box.left, width: box.width, height: box.height } : r;
  // The page as a whole: the card docks in the lit page's lower right corner, clear of the page's first sections.
  const pointAt = r;
  // Beside the rail or a list: the card's middle level with what is lit (about 90 px down a card).
  const cardTop = side ? Math.min(Math.max(pointAt.top + pointAt.height / 2 - 90, edge), H - 240) : whole ? Math.max(box.top + box.height - 214, box.top + 16) : roomBelow ? box.top + box.height + 18 : box.top - 18;
  // The page as a whole: the card docks in the lit page's lower right corner, no arrow (it points at no one thing).
  const cardLeft = side ? Math.min(holderRight + 24, W - cardW - edge) : whole ? box.left + box.width - cardW - 24 : Math.min(Math.max(aim.left + aim.width / 2 - cardW / 2, edge), W - cardW - edge);
  const arrowX = whole ? cardW / 2 : Math.min(Math.max(aim.left + aim.width / 2 - cardLeft, 20), cardW - 20);
  const arrowY = Math.min(Math.max(pointAt.top + pointAt.height / 2 - cardTop, 20), 180);
  const n = path.steps.length, last = path.i + 1 >= n, everywhere = path.route === "/";
  const where = step.kind === "rail" ? step.label : step.kind === "menu" ? step.label : step.kind === "thing" ? anchorEntry(registry, path.anchor)?.label ?? "" : step.label;
  const hint = step.kind === "rail" ? `This lives in ${step.label}. Tap Next to open it.` : step.kind === "menu" ? (path.steps[path.i + 1]?.kind === "note" ? `The whole ${step.label} page changed. Tap Next to open it.` : `Tap Next to open ${step.label}.`)
    : step.kind === "thing" ? "Here it is. Try it." : everywhere ? "This change is all over Pulse." : `This change is on the whole ${step.label} page.`;
  return createPortal(<div className={`${css.top} ${css.layer}`} data-new-path={step.kind} data-ready="">
    <div className={css.hole} data-whole={whole ? "" : undefined} data-menu={flyout ? "" : undefined} style={{ top: box.top, left: box.left, width: box.width, height: box.height, borderRadius: radius }} />
    {flyout ? <div className={css.thingRing} style={{ top: r.top, left: r.left, width: r.width, height: r.height, borderRadius: 10 }} /> : null}
    <div ref={card} key={key} className={css.card} role="dialog" aria-modal="false" aria-labelledby={titleId}
      data-side={side ? "right" : undefined} data-below={!side && (roomBelow || whole) ? "" : undefined} data-plain={whole ? "" : undefined}
      style={{ top: cardTop, left: cardLeft, width: cardW, "--arrow-x": `${arrowX}px`, "--arrow-y": `${arrowY}px` } as CSSProperties}>
      <div className={css.cardHead}>
        <span className={css.chip}>New</span>
        <span className={css.where}>{where}</span>
        <button type="button" className={css.close} aria-label="Close" onClick={close}><X size={16} aria-hidden="true" /></button>
      </div>
      <h2 id={titleId} className={css.title}>{path.text}</h2>
      <p className={css.pathHint}>{hint}</p>
      <p className={css.said} role="status">{`${stepWords(path.i, n)}. ${hint} ${path.text}`}</p>
      <div className={css.actions}>
        {n > 1 ? <span className={css.count}>{stepWords(path.i, n)}</span> : null}
        {last ? <button ref={primary} type="button" className={css.primary} onClick={close}>Got it</button>
          : <><button type="button" className={css.quiet} onClick={close}>Close</button>
            <button ref={primary} type="button" className={css.primary} onClick={advance}>Next<span aria-hidden="true"> →</span></button></>}
      </div>
    </div>
  </div>, document.body);
}
