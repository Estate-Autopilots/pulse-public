// REPLAY-FIXES #6 (REPLAY-INSIGHTS: Sakobe's half-written New task closed when he came back to the app, 12:55 IST): what
// is typed into a new task is kept on this device until it is created or thrown away, so leaving the app (a call, another
// window, the phone putting Pulse to sleep) never loses it; opening New task again brings it back. Only a plain New task
// (not one made from a chat message, a project or a parent task: those carry their own words). In this browser only
// (localStorage, one per person), for a day.

export const TASK_DRAFT_MAX_AGE_MS = 24 * 3600_000;
const KEY = "pulse.task.draft:";

/** The draft of what is on the form, or null when nothing worth keeping is on it. Person chips keep their name (@Name). */
export function draftOf({ segs = [], details = "", whoId = null, due = null, project = null, priority = "normal", category = null } = {}) {
  const title = segs.map((s) => s?.kind === "person" ? `@${s.name ?? ""}` : String(s?.text ?? "")).join("").replace(/ /g, " ");
  if (!title.trim() && !String(details).trim()) return null;
  return { title: title.slice(0, 300), details: String(details).slice(0, 4000), whoId, due: due && (due.date || due.time) ? { date: due.date ?? null, time: due.time ?? null } : null, project, priority, category };
}

/** Keep (or, for null, forget) the person's draft. Never throws (storage off, full or private). */
export function saveTaskDraft(storage, person, draft, now = Date.now()) {
  try { if (draft) storage.setItem(KEY + (person || "me"), JSON.stringify({ at: now, draft })); else storage.removeItem(KEY + (person || "me")); } catch { /* storage off */ }
}

/** The person's draft from the last day, or null (an older one is forgotten). */
export function loadTaskDraft(storage, person, now = Date.now()) {
  try {
    const saved = JSON.parse(storage.getItem(KEY + (person || "me")) ?? "null");
    if (!saved?.draft || typeof saved.at !== "number") return null;
    if (now - saved.at > TASK_DRAFT_MAX_AGE_MS) { storage.removeItem(KEY + (person || "me")); return null; }
    return saved.draft;
  } catch { return null; }
}

/** A New task with nothing given to it (a draft is kept and restored only for these). */
export const plainNewTask = (request = {}) => !request.title && !request.projectId && !request.assigneeId && !request.parentId && !request.clientProjectId && !request.chat && !request.source && !request.notes;
