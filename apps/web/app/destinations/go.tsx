"use client";
// UX-5B: "Go there". A link made by goHref() opens a page with ?go=<destination>; the spotlight waits for that
// destination's anchor (pages that load their data after rendering mark it a moment later), opens any closed section
// around it, scrolls to it smoothly, glows and pulses it, and puts a small coach mark beside it ("Add the office Wi-Fi
// here"). With reduced motion it jumps and glows without the pulse. `task=<id>` keeps the task companion with the
// person. Then `go` and `task` leave the address, so a refresh or a shared link does not spotlight again.
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { destination, goHref, type Destination } from "./registry.mjs";
import css from "./spotlight.module.css";

/** Open a destination with its spotlight, from anywhere (Ctrl+K, the companion, a task). */
export function goTo(dest: Destination | string, router: { push: (href: string) => void }, task?: string | null) { router.push(goHref(dest, task)); }

/** The companion listens for this: the task the person came from. */
export const COMPANION_EVENT = "pulse:companion";
export function keepTask(task: string, opts: { open?: boolean } = {}) {
  window.dispatchEvent(new CustomEvent(COMPANION_EVENT, { detail: { task, ...opts } }));
}

const WAIT_MS = 5000;
const GLOW_MS = 6500;
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const find = (id: string) => document.querySelector<HTMLElement>(`[data-dest="${CSS.escape(id)}"]`);
/** Every ancestor with an anchor, nearest first, so a page without the exact control still shows where to look. */
const chain = (d: Destination) => { const out: Destination[] = []; let at: Destination | undefined = d; while (at) { out.push(at); at = destination(at.parent); } return out; };

type Mark = { id: string; text: string; el: HTMLElement; top: number; left: number; below: boolean };

export function Spotlight() {
  const params = useSearchParams(); const pathname = usePathname();
  const go = params.get("go"), task = params.get("task");
  const [mark, setMark] = useState<Mark | null>(null);
  const markRef = useRef<Mark | null>(null);
  const clear = useCallback(() => {
    markRef.current?.el.removeAttribute("data-spotlight");
    markRef.current = null; setMark(null);
  }, []);

  // Keep the coach mark beside its element while the page scrolls or resizes.
  const place = useCallback(() => {
    const m = markRef.current; if (!m) return;
    const r = m.el.getBoundingClientRect(); const w = Math.min(300, window.innerWidth - 24);
    const below = r.top < 120;
    const next = { ...m, below, top: below ? r.bottom + 10 : r.top - 10, left: Math.max(12, Math.min(window.innerWidth - w - 12, r.left + Math.min(24, r.width / 4))) };
    markRef.current = next; setMark(next);
  }, []);
  const markKey = mark?.id ?? null;
  useEffect(() => {
    if (!markKey) return;
    let frame = 0; const on = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    window.addEventListener("scroll", on, true); window.addEventListener("resize", on);
    const done = window.setTimeout(clear, GLOW_MS);
    const away = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element)?.closest?.("[data-coach]")) clear(); };
    // The first press inside the spotlit control is the person doing the thing: the glow steps back.
    window.addEventListener("keydown", away); window.addEventListener("pointerdown", away, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", on, true); window.removeEventListener("resize", on); window.clearTimeout(done); window.removeEventListener("keydown", away); window.removeEventListener("pointerdown", away, true); };
  }, [markKey, place, clear]);

  useEffect(() => {
    if (!go) return;
    const d = destination(go);
    // After this render's effects, so a companion mounted beside the spotlight is listening (a link opened directly).
    if (task) window.setTimeout(() => window.dispatchEvent(new CustomEvent(COMPANION_EVENT, { detail: { task, from: "go" } })), 0);
    // Take `go` and `task` out of the address without a navigation.
    const strip = () => {
      const url = new URL(window.location.href); url.searchParams.delete("go"); url.searchParams.delete("task");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    };
    // A whole page is the place itself: nothing to wait for.
    if (!d || d.kind === "page") { strip(); return; }
    let stopped = false; const started = Date.now();
    const tick = () => {
      if (stopped) return;
      // The exact anchor; else what it needs first once that is on the page (an office before its Wi-Fi: they render
      // together, so the one without the other means it is not there yet); else, after waiting, the nearest ancestor.
      const exact = find(d.id); const first = destination(d.needs); const needed = !exact && first ? find(first.id) : null;
      const el = exact ?? needed ?? (Date.now() - started > WAIT_MS ? chain(d).slice(1).map((x) => find(x.id)).find(Boolean) ?? null : null);
      if (!el) { if (Date.now() - started <= WAIT_MS) { timer = window.setTimeout(tick, 120); } else strip(); return; }
      const shown = exact ? d : needed && first ? first : chain(d).find((x) => find(x.id) === el) ?? d;
      for (let p = el.parentElement; p; p = p.parentElement) if (p instanceof HTMLDetailsElement && !p.open) p.open = true;
      clear();
      el.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center", inline: "nearest" });
      el.setAttribute("data-spotlight", reduced() ? "still" : "on");
      // A control takes the keyboard at once, without scrolling again.
      if (shown.kind === "control") el.querySelector<HTMLElement>("input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])")?.focus({ preventScroll: true });
      const text = shown.id === d.id ? d.coach ?? `Here: ${d.label}` : shown.id === d.needs ? `First: ${(shown.coach ?? shown.label).replace(/^./, (c) => c.toLowerCase())}. ${d.label} goes in it.`
        : `${d.label} is not here yet. ${shown.coach ?? `Start in ${shown.label}`}.`;
      markRef.current = { id: `${d.id}:${Date.now()}`, text, el, top: 0, left: 0, below: false };
      window.setTimeout(place, reduced() ? 0 : 420);
      strip();
    };
    let timer = window.setTimeout(tick, 60);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [go, task, pathname, clear, place]);

  if (!mark || !mark.top) return null;
  return <div className={css.coach} data-coach="" data-below={mark.below ? "" : undefined} role="note" aria-live="polite"
    style={{ top: mark.top, left: mark.left }}>
    <span>{mark.text}</span>
    <button type="button" aria-label="Got it" title="Got it" onClick={clear}><X size={13} aria-hidden="true" /></button>
  </div>;
}
