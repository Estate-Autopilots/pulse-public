"use client";
// VISUAL-QA (owner, 10 Nov 2026: "a crossed-out bell chip sits next to the bell, with no explanation"): whether this
// browser's alerts are off lives here, so the bell can say it and its panel can offer Turn on / Later, instead of a
// second, unlabelled bell beside it. NotifyWelcome (notify-welcome.tsx) owns the state and the full-screen card; it
// publishes the state here and listens for the panel's two answers.
import { useSyncExternalStore } from "react";

/** "off": Pulse can ask; "blocked": only the browser's site settings can allow them. `nag`: not put off with Later. */
export type AlertsOff = Readonly<{ state: "off" | "blocked"; nag: boolean }> | null;
let current: AlertsOff = null;
const listeners = new Set<() => void>();

export function publishAlertsOff(next: AlertsOff) {
  if (next?.state === current?.state && next?.nag === current?.nag) return;
  current = next;
  listeners.forEach((l) => l());
}
export function useAlertsOff(): AlertsOff {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => current, () => null);
}
/** The panel's answers: open the full card to turn alerts on, or put the reminder off for a week. */
export const ALERTS_TURN_ON = "pulse:alerts-turn-on";
export const ALERTS_LATER = "pulse:alerts-later";
export const askTurnOn = () => window.dispatchEvent(new Event(ALERTS_TURN_ON));
export const askLater = () => window.dispatchEvent(new Event(ALERTS_LATER));
/** Is there a bell in the top bar to carry the state? (Chats switched off: no bell, so the chip stays.) */
export const hasBell = () => !!document.querySelector("[data-shell-actions] button[aria-label^='Notifications']");
