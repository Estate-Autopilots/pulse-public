// DITASU-FIX (17 Nov 2026): the pure half of tasks/finish-gate.ts (no React, no shell), so tests can load it.
/** The database's refusal for open subtasks (0310 task_finish_guard), however many there are. */
export const OPEN_SUBTASKS = /open subtasks? first/i;

/** True when an error from `tasks/:id/move` means "finish its open subtasks first". */
export function isOpenSubtasks(error) {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return OPEN_SUBTASKS.test(text);
}

/** Where a parent with open subtasks is finished: its page, with "Mark done" open. */
export const finishHref = (id) => `/tasks/${encodeURIComponent(String(id))}?finish=1`;

/** The words said on the way there. */
export function finishWords(open) {
  const n = Math.max(1, Math.floor(Number(open) || 1));
  return {
    title: n === 1 ? "One subtask is still open" : `${n} subtasks are still open`,
    message: "Opening the task: finish, move out or cancel each one, then mark it done.",
  };
}
