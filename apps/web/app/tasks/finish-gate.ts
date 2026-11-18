"use client";
// DOREVE-FIX (owner, 17 Nov 2026): "Clicking task completed does nothing for a long time." Production telemetry showed why:
// Datup ticked parent tasks whose subtasks were still open, 9 times in three sessions; the database's finishing rule
// (0310 task_finish_guard: "Finish, move out or cancel its open subtask first") refused each one, and the table, boards,
// My work, Pip's "Mark done" and the other circles only said "Not changed" in a corner pill, cut short. The task page
// already has the way through (TASKS-4B: ?finish=1 opens "Mark done" with each open subtask's Finish / Move out / Cancel),
// so every circle now goes there: at once when the list knows the task has open subtasks, and when the server refuses
// for that reason (a count that changed since the list was drawn).
import { notify } from "@pulse/ui-shell";
import { finishHref, finishWords, isOpenSubtasks } from "../lib/finish-gate.mjs";

export { finishHref, finishWords, isOpenSubtasks } from "../lib/finish-gate.mjs";

/** Sends the person to the task's finishing dialog, saying why, instead of a dead "Not changed". */
export function openFinish(go: (href: string) => void, id: string, open?: number | null) {
  notify({ id: "task-confirm", tone: "info", ...finishWords(open), timeout: 4500 });
  go(finishHref(id));
}

/** For a "done" call: true (and on its way to the task page) when the refusal was the open-subtask rule. */
export function finishInstead(error: unknown, go: (href: string) => void, id: string, open?: number | null): boolean {
  if (!isOpenSubtasks(error)) return false;
  openFinish(go, id, open);
  return true;
}
