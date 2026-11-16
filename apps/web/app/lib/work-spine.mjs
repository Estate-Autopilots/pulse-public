// WORK-SPINE (owner, 10 Nov 2026: "Goals are the highest measure. Under them, the projects and tasks must be clear,
// visible and working"). One model everywhere: a goal holds projects, a project holds tasks, a task may hold a checklist.
// This file is the pure part the goal, project, task and My work screens share: the roll-up (tasks → project % → goal %),
// the words for late and due soon (always with why), and the trail (Goal › Project › Task).

const FINISHED = ["done", "accepted", "in_review"];
const OPEN = ["open", "in_progress", "blocked", "unknown"];
/** Finished: done, waiting for review, or accepted. */
export const isDone = (/** @type {string} */ s) => FINISHED.includes(s);
/** Still to do: open, doing, blocked. Cancelled, not applicable and merged tasks are neither: they do not count. */
export const isOpen = (/** @type {string} */ s) => OPEN.includes(s);

/** Tasks → a project's progress: finished of the tasks that count.
 * @param {{ status: string }[]} tasks */
export function rollup(tasks) {
  let done = 0, open = 0;
  for (const t of tasks) { if (isDone(t.status)) done++; else if (isOpen(t.status)) open++; }
  const total = done + open;
  return { total, done, open, pct: total ? Math.round((100 * done) / total) : 0 };
}

/** Projects → a goal's progress. Every task under the goal counts once, so a project with 40 tasks weighs more than one
 *  with 2 (the same rule as the database's goal_progress). A task linked to the goal on its own is a project of one.
 * @param {{ total: number, done: number }[]} parts */
export function goalRollup(parts) {
  const total = parts.reduce((n, p) => n + Math.max(0, p.total || 0), 0), done = parts.reduce((n, p) => n + Math.max(0, Math.min(p.done || 0, p.total || 0)), 0);
  return { total, done, parts: parts.length, pct: total ? Math.round((100 * done) / total) : 0 };
}

/** How the goal's number is made, in one plain line. @param {{ basis?: string, tasks?: number, tasksDone?: number, projects?: number, steps?: number, stepsDone?: number }} p */
export function countedWords(p) {
  if (p.basis === "measure") return "Counted from the number you update.";
  if (p.basis === "steps") return `Counted from its steps: ${p.stepsDone ?? 0} of ${p.steps ?? 0} done.`;
  if (p.basis === "done") return "Marked done.";
  if (p.tasks) return `Counted from the tasks${p.projects ? ` of ${p.projects} ${p.projects === 1 ? "project" : "projects"}` : ""}: every task finished moves it.`;
  return "Link a project or a task, and its progress counts here.";
}

const DAY = 86400000;
const dayNo = (/** @type {string} */ d) => Math.floor(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / DAY);
const FMT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const FMT_Y = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** "9 Nov" (this year) or "9 Nov 2027". */
export const shortDay = (/** @type {string} */ d, /** @type {string} */ today) => (d.slice(0, 4) === today.slice(0, 4) ? FMT : FMT_Y).format(new Date(`${d.slice(0, 10)}T00:00:00Z`));

export const LATE_HELP = "Late means the due day has passed and the task is not done yet. Finish it, or move its due day.";
/** Where a task stands against its due day, with the words for a chip and the reason behind it.
 *  late: the due day passed and it is not done · today · soon: in the next 2 days · ok · none: no due day or finished.
 * @param {string | null | undefined} dueOn @param {string} today @param {string} status */
export function dueState(dueOn, today, status) {
  if (!dueOn) return { state: "none", chip: null, why: null };
  const on = shortDay(dueOn, today);
  if (!isOpen(status)) return { state: "none", chip: null, why: null };
  const d = dayNo(dueOn) - dayNo(today);
  if (d < 0) return { state: "late", chip: `Late · was due ${on}`, why: `It was due ${on} (${-d === 1 ? "1 day" : `${-d} days`} ago) and is not done yet.` };
  if (d === 0) return { state: "today", chip: "Due today", why: "Due today." };
  if (d <= 2) return { state: "soon", chip: d === 1 ? "Due tomorrow" : `Due ${on}`, why: `Due soon: ${d === 1 ? "tomorrow" : `in ${d} days`}.` };
  return { state: "ok", chip: `Due ${on}`, why: null };
}

/** Goal › Project › parent task › task, as links. More than one goal: the first is in the trail, the rest are counted.
 * @param {{ goals?: { id: string, title: string }[], project?: { id: string, name: string } | null, parents?: { id: string, title: string }[] }} at */
export function trail(at) {
  /** @type {{ label: string, href: string, kind: "goal" | "project" | "task" }[]} */
  const out = [];
  const goals = at.goals ?? [];
  if (goals[0]) out.push({ label: goals[0].title, href: `/goals/${goals[0].id}`, kind: "goal" });
  if (at.project) out.push({ label: at.project.name, href: `/tasks/projects/${at.project.id}`, kind: "project" });
  for (const p of at.parents ?? []) out.push({ label: p.title, href: `/tasks/${p.id}`, kind: "task" });
  return { items: out, moreGoals: Math.max(0, goals.length - 1) };
}

/** Where a project opens: every work project on its own page (Tasks, Overview, Files, Activity); a client's package page
 *  only for what the client bought. @param {string | null | undefined} id */
export const projectHref = (id) => `/tasks/projects/${id}`;

/** PROJECTS-FIX (owner, 10 Nov 2026: the goal's next step "consult the CA… due 9 Nov" linked to work he could not find):
 *  a task named from a goal opens in its project's list, scrolled to and highlighted, so it is seen with the work around
 *  it. A task with no project opens on its own page.
 * @param {{ id: string, projectId?: string | null }} t */
export const taskInProjectHref = (t) => t.projectId ? `/tasks/projects/${t.projectId}?task=${t.id}` : `/tasks/${t.id}`;

/** PROJECTS-FIX (owner, 10 Nov 2026: an internal project must show "what the project is, its state, and a clean list of
 *  its tasks"): a project's state in one or two words, with its tone and why.
 * @param {{ status?: string | null, total: number, open: number, late: number, blocked: number }} p
 * @returns {{ word: string, tone: "good" | "bad" | "warn" | "muted", why: string }} */
export function projectState(p) {
  const s = p.status ?? "active";
  if (s === "paused") return { word: "Paused", tone: "muted", why: "Someone paused this project. Its tasks wait until it starts again." };
  if (s === "done") return { word: "Finished", tone: "good", why: "This project is marked finished." };
  if (s === "cancelled") return { word: "Stopped", tone: "muted", why: "This project was stopped." };
  if (s === "planned") return { word: "Not started yet", tone: "muted", why: "This project is planned and has not started." };
  if (!p.total) return { word: "No tasks yet", tone: "muted", why: "Add the first task and its progress starts to count." };
  if (!p.open) return { word: "All tasks done", tone: "good", why: `All ${p.total} tasks are done.` };
  if (p.late) return { word: "Behind", tone: "bad", why: `${p.late} ${p.late === 1 ? "task is" : "tasks are"} past the due day and not done yet.` };
  if (p.blocked) return { word: "Waiting", tone: "warn", why: `${p.blocked} ${p.blocked === 1 ? "task is" : "tasks are"} blocked or waiting on other work.` };
  return { word: "On track", tone: "good", why: "Nothing is late." };
}

/** The project's type in one word, from the one field that says it. @param {string | null | undefined} t */
export const typeWord = (t) => t === "client_delivery" ? "Client" : t === "personal" ? "Personal" : "Internal";

/** The four ways to see a project's tasks, as tabs inside Tasks. */
export const PROJECT_VIEWS = /** @type {const} */ (["list", "board", "timeline", "calendar"]);
/** A project page's view (owner, 10 Nov 2026: "List, Board, Timeline and Calendar are EMPTY even though the project has
 *  tasks"). The view comes from the page's own switch (?view=), else the person's last one, else List. Grouping and sort
 *  are kept; filters never are: a person or a word filtered on one project used to empty the next project's views. Every
 *  task shows, finished ones too (the board's Done column, the calendar's past days).
 * @param {Record<string, string | undefined>} q @param {{ layout?: string | null, defaultLayout?: string | null, config?: { group?: string, sort?: string } } | null} prefs */
export function projectView(q, prefs) {
  const pick = (/** @type {unknown} */ v) => PROJECT_VIEWS.includes(/** @type {any} */ (v)) ? /** @type {typeof PROJECT_VIEWS[number]} */ (v) : null;
  const layout = pick(q.view) ?? pick(prefs?.defaultLayout) ?? pick(prefs?.layout) ?? "list";
  const c = prefs?.config ?? {};
  return { layout, group: c.group && c.group !== "none" ? c.group : "status", sort: c.sort ?? "due", filters: { status: "all", due: "any", projects: [], people: [], tags: [], pool: false, q: "" } };
}

const STATUS_WORDS = /** @type {Record<string, string>} */ ({ done: "finished", accepted: "accepted", in_review: "sent for review", in_progress: "started", blocked: "marked as blocked",
  cancelled: "cancelled", not_applicable: "closed as not needed", merged: "merged" });
const FIELD_WORDS = /** @type {Record<string, string>} */ ({ project_type: "the type", visibility: "who can see it", started_by: "where it is listed", status: "the status",
  due_on: "the due day", starts_on: "the start day", ends_on: "the end day", owner_id: "the owner", title: "the name", name: "the name", summary: "the description", client_id: "the client" });
const VALUE_WORDS = /** @type {Record<string, string>} */ ({ internal: "Internal", client_delivery: "Client", personal: "Personal", org: "everyone in the company", members: "its members",
  leadership: "leadership", person: "the main list", ai: "Started by AI" });
/** One line of a project's activity, in plain words: who did what to which task.
 * @param {{ src: string, kind: string, from?: string | null, to?: string | null, by?: string | null, taskTitle?: string | null }} e */
export function activityWords(e) {
  const who = e.by ?? "Pulse", task = e.taskTitle ? `“${e.taskTitle}”` : "a task";
  if (e.src === "project") {
    const what = FIELD_WORDS[e.kind] ?? e.kind.replace(/_/g, " ");
    if (e.kind === "started_by") return e.to === "person" ? `${who} kept this project in the main list` : `${who} moved this project under Started by AI`;
    const to = e.to ? VALUE_WORDS[e.to] ?? (/^[0-9a-f-]{36}$/.test(e.to) ? null : e.to) : null;
    return to ? `${who} changed ${what} to ${to}` : `${who} changed ${what}`;
  }
  if (e.kind === "created") return `${who} added ${task}`;
  if (e.kind === "status") {
    if (e.to === "open" && (e.from === "done" || e.from === "accepted" || e.from === "in_review" || e.from === "cancelled")) return `${who} reopened ${task}`;
    if (e.to === "open") return `${who} moved ${task} back to to-do`;
    return `${who} ${STATUS_WORDS[e.to ?? ""] ?? "changed"} ${task}`;
  }
  if (e.kind === "assigned") return e.to ? `${who} gave ${task} to ${e.to}` : `${who} took ${task} off its person`;
  if (e.kind === "blocked") return `${who} marked ${task} as waiting on other work`;
  if (e.kind === "moved") return `${who} moved ${task}`;
  if (e.kind === "reviewer") return e.to ? `${who} asked ${e.to} to review ${task}` : `${who} changed who reviews ${task}`;
  return `${who} changed ${task}`;
}
/** The tone of an activity line: done (green), late or blocked (red), or plain. @param {{ kind: string, to?: string | null }} e */
export const activityTone = (e) => e.kind === "status" && (e.to === "done" || e.to === "accepted") ? "good" : e.kind === "blocked" || (e.kind === "status" && e.to === "blocked") ? "bad" : "plain";
