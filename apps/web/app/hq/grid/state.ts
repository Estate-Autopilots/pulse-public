"use client";
// PULSE-HQ (owner, 23 Oct 2026): the fast sheet's view state. What a person is looking at (view kind, filters, sort,
// group-by, hidden fields, free-canvas positions) is remembered per sheet in this browser, read without a hydration
// mismatch (the server always draws the defaults), and can be saved as a named view on their account (sheet_view, 0973).
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type ViewKind = "sheet" | "board" | "compact" | "gallery" | "free" | string;
export type GridSettings = {
  kind: ViewKind;
  filters: Record<string, string[]>;
  sort: { key: string; up: boolean } | null;
  groupBy: string | null;
  boardBy: string | null;
  hidden: string[];
  query: string;
  positions: Record<string, [number, number]>;
};
export const BASE_SETTINGS: GridSettings = { kind: "sheet", filters: {}, sort: null, groupBy: null, boardBy: null, hidden: [], query: "", positions: {} };

const cache = new Map<string, { raw: string | null; val: GridSettings }>();
const EVENT = "pulse:grid-settings";
function read(key: string, defaults: GridSettings): GridSettings {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(key); } catch { /* private window */ }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.val;
  let val = defaults;
  try { val = raw ? { ...defaults, ...(JSON.parse(raw) as Partial<GridSettings>) } : defaults; } catch { val = defaults; }
  cache.set(key, { raw, val });
  return val;
}

/** This sheet's settings in this browser, and a setter that merges a change. */
export function useGridSettings(scope: string, defaults: GridSettings): [GridSettings, (patch: Partial<GridSettings>) => void] {
  const key = `pulse.grid.${scope}`;
  const s = useSyncExternalStore(
    (on) => { window.addEventListener("storage", on); window.addEventListener(EVENT, on); return () => { window.removeEventListener("storage", on); window.removeEventListener(EVENT, on); }; },
    () => read(key, defaults), () => defaults);
  const set = useCallback((patch: Partial<GridSettings>) => {
    try { window.localStorage.setItem(key, JSON.stringify({ ...read(key, defaults), ...patch })); } catch { /* private window */ }
    window.dispatchEvent(new Event(EVENT));
  }, [key, defaults]);
  return [s, set];
}

/** Changes a sheet's settings from outside it (e.g. "Compare" on a selection switches the view). */
export function patchGridSettings(scope: string, patch: Partial<GridSettings>) {
  const key = `pulse.grid.${scope}`;
  try { const raw = window.localStorage.getItem(key); window.localStorage.setItem(key, JSON.stringify({ ...(raw ? JSON.parse(raw) as object : {}), ...patch })); } catch { /* private window */ }
  window.dispatchEvent(new Event(EVENT));
}

export type SavedView = { id: string; name: string; body: Partial<GridSettings>; sort: number };

/** The person's saved views of this sheet (their account, every device). */
export function useSavedViews(scope: string) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/v0/sheet-views?scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(d.views)) setViews(d.views as SavedView[]);
    } catch { /* offline: no saved views */ }
  }, [scope]);
  useEffect(() => {
    let live = true;
    fetch(`/api/v0/sheet-views?scope=${encodeURIComponent(scope)}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null)
      .then((d: { views?: SavedView[] } | null) => { if (live && Array.isArray(d?.views)) setViews(d.views); }).catch(() => undefined);
    return () => { live = false; };
  }, [scope]);
  const call = useCallback(async (path: string, body: unknown) => {
    const r = await fetch(`/api/v0/sheet-views${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setError(typeof d?.error === "string" ? d.error : "The view did not save."); throw new Error("view"); }
    setError(null); await load(); return d as { id?: string };
  }, [load]);
  return {
    views, error,
    save: (name: string, body: Partial<GridSettings>) => call("", { scope, name, body }),
    update: (id: string, body: Partial<GridSettings>) => call(`/${id}`, { body }),
    rename: (id: string, name: string) => call(`/${id}`, { name }),
    remove: (id: string) => call(`/${id}/remove`, {}),
  };
}
