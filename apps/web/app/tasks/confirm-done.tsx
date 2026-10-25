"use client";
import { useSyncExternalStore } from "react";
import { dismissNotice, notify } from "@pulse/ui-shell";
import css from "./confirm-done.module.css";

/**
 * EST-997 (owner, 16 Oct 2026): a task's circle never closes a task on one stray click. The first click asks: the circle
 * turns green and Pip asks "Mark … done?". A second click on the circle, or Pip's "Mark done", finishes it. The question
 * lapses after 5 s or on Escape. One task asks at a time, and a double click (two clicks within 300 ms) counts as one.
 */
const WAIT = 5000, SETTLE = 300, NOTICE = "task-confirm";
let armed: string | null = null, armedAt = 0, lapse: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { arm(null); dismissNotice(NOTICE); } };

function arm(id: string | null) {
  armed = id; armedAt = Date.now();
  clearTimeout(lapse);
  if (typeof window !== "undefined") {
    if (id) window.addEventListener("keydown", escape); else window.removeEventListener("keydown", escape);
  }
  if (id) lapse = setTimeout(() => arm(null), WAIT);
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The task whose circle is asking now, if any. */
export function useArmedTask() { return useSyncExternalStore(subscribe, () => armed, () => null); }

/** A circle's click: asks first; the confirming click (or Pip's action) runs `finish`. */
export function tickDone(id: string, title: string, finish: () => void) {
  if (armed === id) {
    if (Date.now() - armedAt < SETTLE) return;
    arm(null); dismissNotice(NOTICE); finish();
    return;
  }
  arm(id);
  const short = title.length > 48 ? `${title.slice(0, 47)}…` : title;
  notify({ id: NOTICE, tone: "info", title: `Mark “${short}” done?`, message: "Click its circle again, or choose Mark done.", timeout: WAIT,
    action: { label: "Mark done", run: () => { if (armed === id) arm(null); finish(); } } });
}

/** The circle's name and tooltip while it is open (finished circles keep their status label). */
export function tickProps(title: string, asking: boolean) {
  return asking ? { label: `Confirm: mark “${title}” done`, tip: "Click again to mark done" } : { label: `Mark “${title}” done`, tip: "Mark done" };
}

/** Added to the circle's own class while it asks. */
export const armedClass = css.armed;
