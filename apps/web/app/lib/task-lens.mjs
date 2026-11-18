// MY-TASKS (owner, 28 Oct 2026): whose list My tasks shows. "Assigned to me" is work someone else gave you (the
// default), "I created" is what you made (for yourself, someone else or the pool), "I'm reviewing" is someone else's
// work that you accept, and "All mine" is everything on your plate.

export const LENSES = [
  { key: "assigned", label: "Assigned to me", tip: "Given to you by someone else" },
  { key: "created", label: "I created", tip: "Tasks you made, for yourself, someone else or the pool" },
  { key: "reviewing", label: "I’m reviewing", tip: "Someone else’s work that you accept" },
  { key: "all", label: "All mine", tip: "Everything on your plate" },
];

const FINISHED = ["done", "in_review", "accepted"];

/** Whether a task belongs in a lens. A task with no known giver (a tracker row) counts as given to you. */
export function inLens(lens, t, me) {
  const mine = !!me && t.assigneeId === me;
  if (lens === "assigned") return mine && t.assignerId !== me;
  if (lens === "created") return !!me && t.createdBy === me;
  if (lens === "reviewing") return !!me && t.reviewerId === me && !mine;
  return mine;
}

/** Open tasks in a lens (the number on its button). */
export function lensCount(lens, rows, me) {
  return rows.filter((t) => inLens(lens, t, me) && !FINISHED.includes(t.status) && t.status !== "cancelled").length;
}

/** The lens My tasks opens on: the one asked for, else "Assigned to me", else (nothing from anyone) "All mine". */
export function firstLens(asked, rows, me) {
  if (LENSES.some((l) => l.key === asked)) return asked;
  return rows.some((t) => inLens("assigned", t, me)) ? "assigned" : "all";
}

/** My rows, then what I created and what I review, each task once. */
export function lensRows(home) {
  const seen = new Set();
  return [...(home.rows ?? []), ...(home.created ?? []), ...(home.reviewing ?? [])].filter((t) => !seen.has(t.id) && !!seen.add(t.id));
}
