// UX-DELIGHT (6 Nov 2026): one table of how each task state looks and counts, so My day, Work, project pages and lists
// agree. "Not applicable" is closed (it leaves every open list) but never counts as done: progress leaves it out of
// both sides, like Cancelled.

/** @typedef {{ key: string, label: string, tone: "neutral"|"accent"|"danger"|"success"|"muted", closed: boolean, done: boolean }} TaskState */

/** @type {Record<string, TaskState>} */
export const TASK_STATES = {
  unknown: { key: "unknown", label: "No status yet", tone: "neutral", closed: false, done: false },
  open: { key: "open", label: "To do", tone: "neutral", closed: false, done: false },
  in_progress: { key: "in_progress", label: "Doing", tone: "accent", closed: false, done: false },
  blocked: { key: "blocked", label: "Blocked", tone: "danger", closed: false, done: false },
  in_review: { key: "in_review", label: "Done · in review", tone: "success", closed: true, done: true },
  done: { key: "done", label: "Done", tone: "success", closed: true, done: true },
  accepted: { key: "accepted", label: "Accepted", tone: "success", closed: true, done: true },
  not_applicable: { key: "not_applicable", label: "Not applicable", tone: "muted", closed: true, done: false },
  cancelled: { key: "cancelled", label: "Cancelled", tone: "muted", closed: true, done: false },
};

/** @param {string} status */
export const stateOf = (status) => TASK_STATES[status] ?? TASK_STATES.unknown;
/** Finished one way or another: nothing more to do on it. @param {string} status */
export const isClosed = (status) => stateOf(status).closed;
/** Finished as done (counts toward progress). @param {string} status */
export const isDone = (status) => stateOf(status).done;
/** Closed without being done: Not applicable or Cancelled. @param {string} status */
export const isSetAside = (status) => stateOf(status).closed && !stateOf(status).done;

/**
 * Progress over a list of tasks: done out of those that still count (Not applicable and Cancelled leave both sides).
 * @param {{ status: string }[]} tasks
 * @returns {{ done: number, total: number, setAside: number, open: number, ratio: number }}
 */
export function progressOf(tasks) {
  let done = 0, total = 0, setAside = 0;
  for (const t of tasks) { if (isSetAside(t.status)) { setAside++; continue; } total++; if (isDone(t.status)) done++; }
  return { done, total, setAside, open: total - done, ratio: total ? done / total : 0 };
}

/**
 * The milestone just crossed going from `before` to `after` (the round numbers a person notices), or null.
 * @param {number} before @param {number} after @param {readonly number[]} [steps]
 */
export function milestone(before, after, steps = [5, 10, 25, 50, 100, 250, 500, 1000]) {
  for (const s of steps) if (before < s && after >= s) return s;
  return null;
}

/**
 * A run of months, counting back from the latest: `hit` true extends it, false ends it, null (no data yet, or the month
 * still running) neither breaks nor extends it. Finance uses it for "months in a row with money in".
 * @param {{ month: string, hit: boolean | null }[]} months  any order, month as YYYY-MM
 */
export function streakOf(months) {
  let n = 0;
  for (const m of [...months].sort((a, b) => b.month.localeCompare(a.month))) {
    if (m.hit === null) continue;
    if (!m.hit) break;
    n++;
  }
  return n;
}
