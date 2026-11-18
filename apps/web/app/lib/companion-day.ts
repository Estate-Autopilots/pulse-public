"use client";
// The person's day (GET /api/v0/companion), read once for every surface on the page: the header check-in control and
// the computer's corner companion share this one poll (every minute while visible, on focus and after any attendance
// action) instead of each asking the API.
import { useSyncExternalStore } from "react";
import { clockOffset, type CompanionPayload } from "@pulse/companion";

export type CompanionDay = CompanionPayload & {
  week?: { onTime: number; late: number; missed: number; days: { date: string; state: "on_time" | "late" | "missed" | "off" | "today" }[] } | null;
  arrival?: { at: string; office: string | null } | null;
};
export type DaySnapshot = { payload: CompanionDay; offset: number; gone?: false } | { payload: null; offset: 0; gone: boolean };

const EMPTY: DaySnapshot = { payload: null, offset: 0, gone: false };
let snapshot: DaySnapshot = EMPTY;
const listeners = new Set<() => void>();
let timer: number | null = null, loading: Promise<void> | null = null;

function emit() { for (const l of listeners) l(); }
/** Read the day now (coalescing concurrent calls). A 401/403 means this browser has no person: stop asking. */
export function refreshDay(): Promise<void> {
  if (typeof window === "undefined" || snapshot.gone) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    try {
      // ATT: a hidden tab says nothing about where someone is (the office network counts only from a page in view).
      const r = await fetch(`/api/v0/companion${document.visibilityState === "hidden" ? "?visible=0" : ""}`, { cache: "no-store" });
      if (r.status === 401 || r.status === 403) { snapshot = { payload: null, offset: 0, gone: true }; emit(); return; }
      if (!r.ok) return;
      const payload = await r.json() as CompanionDay;
      snapshot = { payload, offset: clockOffset(payload) }; emit();
    } catch { /* offline: keep the last day; the queue in attendance-recovery keeps taps safe */ }
    finally { loading = null; }
  })();
  return loading;
}
const visibleRefresh = () => { if (document.visibilityState === "visible") void refreshDay(); };
function start() {
  if (timer !== null) return;
  void refreshDay();
  timer = window.setInterval(visibleRefresh, 60000);
  window.addEventListener("focus", visibleRefresh);
  window.addEventListener("pulse:attendance", visibleRefresh);
  document.addEventListener("visibilitychange", visibleRefresh);
}
function stop() {
  if (timer === null) return;
  window.clearInterval(timer); timer = null;
  window.removeEventListener("focus", visibleRefresh);
  window.removeEventListener("pulse:attendance", visibleRefresh);
  document.removeEventListener("visibilitychange", visibleRefresh);
}
function subscribe(listener: () => void) {
  listeners.add(listener); start();
  return () => { listeners.delete(listener); if (!listeners.size) stop(); };
}
/** The last day read (after awaiting refreshDay()). */
export function currentDay(): CompanionDay | null { return snapshot.payload; }
/** The shared day, or { payload: null } until it is read (and on the server). */
const idle = () => () => {};
/** UI-POLISH (R120): `enabled` false (a client seat, which the API refuses) never asks. */
export function useCompanionDay(enabled = true): DaySnapshot {
  return useSyncExternalStore(enabled ? subscribe : idle, () => (enabled ? snapshot : EMPTY), () => EMPTY);
}

/** Events for Pip's notification island (UX-NOTIFY styles it later). Every surface may listen; nothing here sends
 *  anything outside the browser. detail: { id, kind, title, body?, actions: [{ id, label, href? }], at } */
export type Nudge = { id: string; kind: "arrival" | "long-break" | "checkout" | "streak" | "first-check-in" | "profile"; title: string; body?: string;
  actions: { id: string; label: string; href?: string }[]; at: number };
export function emitNudge(nudge: Nudge) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<Nudge>("pulse:nudge", { detail: nudge }));
}
