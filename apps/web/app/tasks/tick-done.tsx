"use client";
/**
 * DITASU-2 (orchestrator decision under the owner's delegation, 17 Nov 2026, AC card 7): ticking a task's circle finishes
 * it in ONE click, right where you clicked, with Undo beside the circle (kit/undo-here.tsx through celebrate()). It
 * replaces EST-997's two-step circle (the first click only asked, and the question with its "Mark done" button showed
 * in Pip's corner, far from the pointer: Ditasu clicked one circle 7 times in 19 s). A double click (two clicks on the
 * same circle within 400 ms) still counts once, and a parent with open subtasks still goes to its finishing dialog
 * (tasks/finish-gate.ts) before this is called. Same on the list, the table, boards, My work, My day, the task page and
 * phones.
 */
import { tickOnce } from "../lib/tick-once.mjs";

const once = tickOnce(400);
/** A circle's click: `finish` runs now (once for a double click). */
export function tickDone(id: string, finish: () => void) { once(id, finish); }

/** The circle's name and tooltip (finished circles keep their status label). */
export function tickProps(title: string) {
  return { label: `Mark “${title}” done`, tip: "Mark done" };
}
