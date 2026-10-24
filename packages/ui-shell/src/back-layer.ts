"use client";
// FLOAT-2 (device audit, 22 Oct 2026): Android back closes what is open, never the page or the app. Each layer that
// opens over a page (Pip's menu, the bell panel, the account menu, the More sheet, a popover) adds one history entry
// for the same address; back (the phone's key, the browser's button, a swipe) takes that entry away and the layer
// closes. A layer closed any other way (a tap outside, Esc, one of its items) leaves its entry behind as a spare: back
// skips a spare, so one press always does one visible thing. The Pulse phone app asks `closeTopLayer()` first
// (window.__pulseBack in the app's shell bridge), so its back key closes the layer instead of leaving Pulse.
import { useEffect, useRef } from "react";

type Layer = { id: string; close: () => void };
const KEY = "__pulseLayer";
const stack: Layer[] = [];
const spares = new Set<string>();
let installed = false, current: string | undefined, seq = 0;

const layerOf = (state: unknown) => (state && typeof state === "object" ? (state as Record<string, unknown>)[KEY] : undefined) as string | undefined;

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  current = layerOf(history.state);
  const push = history.pushState.bind(history);
  history.pushState = (...args: Parameters<History["pushState"]>) => { current = layerOf(args[0]); return push(...args); };
  window.addEventListener("popstate", () => {
    const was = current;
    current = layerOf(history.state);
    const keep = current ? stack.findIndex((l) => l.id === current) : -1;
    const closing = stack.splice(keep + 1);
    if (closing.length) { for (const l of closing.reverse()) l.close(); return; }
    // Left a spare, or landed on one: nothing changed on screen, so this press goes one step further.
    if ((was && spares.has(was)) || (current && spares.has(current))) { if (was) spares.delete(was); history.back(); }
  });
}

/** Close the topmost open layer through history (its entry goes with it). True when one was open. */
export function closeTopLayer(): boolean {
  if (!stack.length) return false;
  history.back();
  return true;
}

/** While `open`, back closes this layer (calls `close`) instead of leaving the page. */
export function useBackLayer(open: boolean, close: () => void) {
  const latest = useRef(close);
  useEffect(() => { latest.current = close; });
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    install();
    const id = `l${Date.now().toString(36)}${(seq++).toString(36)}`;
    const layer: Layer = { id, close: () => latest.current() };
    stack.push(layer);
    try { history.pushState({ ...(history.state ?? {}), [KEY]: id }, ""); } catch { stack.pop(); return; }
    return () => {
      const at = stack.indexOf(layer);
      if (at < 0) return; // closed by back: its entry is gone already
      stack.splice(at, 1);
      spares.add(id);
    };
  }, [open]);
}
