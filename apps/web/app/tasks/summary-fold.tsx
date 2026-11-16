"use client";
// TASKS-SCROLL (owner, 7 Nov 2026: "summary strips, insights and the check-in card fold away behind Show summary,
// collapsed by default once the user has seen them, the choice remembered per person"). What sits above Work's list
// (the check-in card, the set-up list, Today's focus) is shown the first time a person opens Work on this device and is
// folded from then on; "Show summary" / "Hide summary" in the toolbar keeps their own choice (per person, this device).
import { ChevronDown } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import css from "./work3.module.css";

const listeners = new Set<() => void>();
const choiceKey = (person: string) => `vitals.work.summary.${person}`;
const seenKey = (person: string) => `vitals.work.summary-seen.${person}`;
// Whether this page load is the person's first sight of the summary on this device (decided once per load, so marking
// it seen does not fold it under their eyes).
const first = new Map<string, boolean>();

function openFor(person: string): boolean {
  try {
    const choice = localStorage.getItem(choiceKey(person));
    if (choice === "open") return true;
    if (choice === "closed") return false;
    if (!first.has(person)) { first.set(person, !localStorage.getItem(seenKey(person))); localStorage.setItem(seenKey(person), "1"); }
    return first.get(person) ?? false;
  } catch { return false; }
}
function subscribe(listener: () => void) {
  listeners.add(listener); window.addEventListener("storage", listener);
  return () => { listeners.delete(listener); window.removeEventListener("storage", listener); };
}
function choose(person: string, open: boolean) {
  try { localStorage.setItem(choiceKey(person), open ? "open" : "closed"); } catch { /* private mode: this page only */ first.set(person, open); }
  for (const l of listeners) l();
}
const useOpen = (person: string) => useSyncExternalStore(subscribe, () => openFor(person), () => false);

/** The toolbar's switch for what is folded above the list. */
export function SummaryToggle({ person }: { person: string }) {
  const open = useOpen(person);
  return <button type="button" className={css.summaryToggle} aria-expanded={open} onClick={() => choose(person, !open)} data-summary-toggle="">
    <ChevronDown size={14} aria-hidden="true" />{open ? "Hide summary" : "Show summary"}
  </button>;
}

/** What folds away: shown while the summary is open. */
export function SummaryFold({ person, children }: { person: string; children: ReactNode }) {
  const open = useOpen(person);
  return <div className={css.summaryFold} hidden={!open} data-summary="">{children}</div>;
}
