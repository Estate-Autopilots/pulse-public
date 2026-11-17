"use client";
// AGENT-OPERATOR (owner, 13 Nov 2026, OWNER-FEEDBACK-1113 P4.2: "on the chat ... on the left side it's entirely opening
// things, doing work, going back and forth, reporting problems"). While the operator view (/operator) is open, the AI
// employee's screen actions happen inside the Pulse page framed on its left, not on the page around it: opening a page
// moves that frame, and reading, clicking, filling, uploading and downloading act on the framed page's document. This
// is the small store between the view (which owns the frame) and the action handlers (agent-ui/actions.tsx), plus the
// steps the view shows above the page (each step, ticked or crossed, with the bug a failed step filed).
import { useSyncExternalStore } from "react";
import type { Scope } from "./screen-map";

export type OperatorFrame = {
  /** The framed page now (null while it loads or when it is not a Pulse page). */
  scope: () => Scope | null;
  /** Moves the frame to a Pulse address and resolves once it has loaded (false when it did not within the wait). */
  go: (path: string) => Promise<boolean>;
  /** Waits until the framed page has drawn its main content (after a click that navigates). */
  settle: () => Promise<void>;
  /** Brings the page to the front (a phone shows the page or the chat): called before each step. */
  reveal?: () => void;
};
export type Step = { key: number; agent: string; text: string; state: "done" | "failed" | "asked"; bug?: { number: number; again: boolean } | null;
  /** For a question: the prompt it waits on (the step goes once it is answered). */
  askId?: string };

let frame: OperatorFrame | null = null;
let steps: Step[] = [];
let stopped = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** The operator view registers its frame while it is mounted; the handlers ask for it. */
export function bindOperatorFrame(f: OperatorFrame) { frame = f; stopped = false; emit(); return () => { if (frame === f) { frame = null; emit(); } }; }
export const operatorFrame = () => frame;
/** Whether the operator view is open in this tab (the prompt tray then sits over its page). */
export const useOperatorOpen = () => useSyncExternalStore(subscribe, () => frame !== null, () => false);

/** The operator view's Stop: no more screen steps in this tab until the person presses Go on (or asks again). */
export const operatorStopped = () => frame !== null && stopped;
export function setOperatorStopped(on: boolean) { stopped = on; emit(); }
export const useOperatorStopped = () => useSyncExternalStore(subscribe, () => stopped, () => false);

/** The chat's side: a message of the person waits for the AI employee's answer (the strip says it is thinking). */
let thinking = false;
export function setOperatorThinking(on: boolean) { if (thinking !== on) { thinking = on; emit(); } }
export const useOperatorThinking = () => useSyncExternalStore(subscribe, () => thinking, () => false);

export function pushStep(s: Omit<Step, "key">) { steps = [...steps, { ...s, key: Date.now() + Math.random() }].slice(-30); emit(); }
export function clearSteps() { steps = []; emit(); }
/** A question answered (or ended) is no longer a step: only the open ones stay. */
export function resolveAsks(open: readonly string[]) {
  const next = steps.filter((s) => !s.askId || open.includes(s.askId));
  if (next.length !== steps.length) { steps = next; emit(); }
}
const serverSteps: Step[] = [];
export const useSteps = () => useSyncExternalStore(subscribe, () => steps, () => serverSteps);
