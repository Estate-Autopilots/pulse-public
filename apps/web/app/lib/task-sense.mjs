// TASKS-P0: what a task means at a glance, computed the same way on every screen (task page, cards, Today's focus).
// Pure functions over the task API's fields; all days are IST (tasks are due at 18:00 IST when only a day is set).
import { placesIn } from "../destinations/registry.mjs";
export const IST_MS = 330 * 60000;
const DAY = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FINISHED = new Set(["done", "accepted", "in_review", "cancelled"]);

export const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
export const istClock = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16);
const at = (day) => Date.parse(`${day}T00:00:00Z`);
const between = (from, to) => Math.round((at(to) - at(from)) / DAY);
const label = (day) => { const d = new Date(at(day)); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** When the task is due, in ms: its due time, else 18:00 IST on its due day. */
export function dueMs(task) {
  if (task.dueAt) return Date.parse(task.dueAt);
  if (task.dueOn) return at(task.dueOn) + 18 * 3600000 - IST_MS;
  return null;
}

/** Urgency in words and a tone: "Due today 18:00 · 9 h left", "Overdue by 2 days", "Due Fri 16 Oct · 5 days". */
export function urgency(task, now = Date.now()) {
  if (FINISHED.has(task.status)) return { key: "done", text: task.status === "cancelled" ? "Cancelled" : "Finished", short: "Done", tone: "none", hoursLeft: null };
  const due = dueMs(task);
  if (due === null) return { key: "none", text: "No due date", short: "No date", tone: "none", hoursLeft: null };
  const today = istDay(now), day = istDay(due), days = between(today, day), clock = istClock(due);
  const hours = (due - now) / 3600000;
  if (due <= now) {
    const late = between(day, today);
    if (late < 1) { const h = Math.max(1, Math.round(-hours)); return { key: "overdue", text: `Overdue by ${plural(h, "hour")}`, short: `${h} h late`, tone: "late", hoursLeft: hours }; }
    return { key: "overdue", text: `Overdue by ${plural(late, "day")}`, short: `${late} d late`, tone: "late", hoursLeft: hours };
  }
  if (days === 0) {
    const left = hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min left` : `${Math.floor(hours)} h left`;
    return { key: "today", text: `Due today ${clock} · ${left}`, short: hours < 1 ? left : `Today ${clock}`, tone: "now", hoursLeft: hours };
  }
  if (days === 1) return { key: "tomorrow", text: `Due tomorrow ${clock}`, short: "Tomorrow", tone: "soon", hoursLeft: hours };
  if (days <= 7) return { key: "week", text: `Due ${label(day)} · ${plural(days, "day")}`, short: label(day).split(" ")[0], tone: days <= 3 ? "soon" : "calm", hoursLeft: hours };
  return { key: "later", text: `Due ${label(day)}${day.slice(0, 4) !== today.slice(0, 4) ? ` ${day.slice(0, 4)}` : ""} · ${plural(days, "day")}`, short: `${Number(day.slice(8))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`, tone: "calm", hoursLeft: hours };
}

/** The focus groups of a person's board: Overdue · Today · This week (the next 7 days) · Later · No date. */
export const FOCUS = [
  { key: "overdue", label: "Overdue" }, { key: "today", label: "Today" }, { key: "week", label: "This week" }, { key: "later", label: "Later" }, { key: "none", label: "No date" },
];
export function focusGroup(task, now = Date.now()) {
  const u = urgency(task, now);
  if (u.key === "tomorrow") return "week";
  return u.key === "done" ? "done" : u.key;
}

const PRIORITY_WEIGHT = { urgent: 1.5, high: 1.25, normal: 1, low: 0.8 };
/** UX-5B: the task's size in hours when anything says it (an estimate, else Pip's), else null. */
export function sizeHours(task) {
  const m = task.estimateMinutes ?? task.suggestion?.effortMinutes ?? null;
  return m ? Math.max(0.25, m / 60) : null;
}
/** Urgency × importance, for Today's focus: what to do first. Work that waits on others scores nothing (it cannot move).
 *  UX-5B: divided by the square root of the size when it is known (softened so that a deadline still leads): of two
 *  equally urgent tasks, the shorter goes first. INTEGRITY (owner, 22 Oct 2026): tasks carry no value points. */
export function focusScore(task, now = Date.now()) {
  if (FINISHED.has(task.status) || task.status === "blocked" || (task.openBlockers ?? 0) > 0) return 0;
  const u = urgency(task, now);
  const late = u.key === "overdue" ? Math.min(3, Math.max(0, -(u.hoursLeft ?? 0) / 24)) : 0;
  const when = { overdue: 5 + late, today: 4, tomorrow: 3, week: (u.hoursLeft ?? 999) <= 72 ? 2 : 1.5, later: 1, none: 0.8 }[u.key] ?? 1;
  const doing = task.status === "in_progress" ? 0.5 : 0;
  const size = sizeHours(task); const short = size ? Math.min(1.5, Math.max(0.75, 1 / Math.sqrt(size))) : 1;
  return (when + doing) * 3 * (PRIORITY_WEIGHT[task.priority] ?? 1) * short + (task.waiting ?? 0) * 1.5;
}
/** The top tasks to do first (default three). */
export function todaysFocus(tasks, now = Date.now(), n = 3) {
  return tasks.map((t) => ({ t, s: focusScore(t, now) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || String(a.t.title).localeCompare(String(b.t.title))).slice(0, n).map((x) => x.t);
}
/** What to do next after finishing `doneId`. */
export function nextUp(tasks, doneId, now = Date.now()) { return todaysFocus(tasks.filter((t) => t.id !== doneId), now, 1)[0] ?? null; }

// ---------------------------------------------------------------------------------------------------- the notes
/** A stable key for a step, so ticking survives edits to other steps. */
export function stepKey(text) {
  const norm = String(text).toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  let h = 0x811c9dc5;
  for (const ch of norm) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `s${h.toString(36)}`;
}
/** Numbered lines ("1. …", "2) …") become steps; the lines around them stay as text. */
export function parseNotes(notes) {
  const intro = [], steps = [], outro = [];
  for (const raw of String(notes ?? "").split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const m = line.match(/^(\d{1,2})[.)]\s+(.+)$/);
    if (m) steps.push({ n: steps.length + 1, text: m[2].trim(), key: stepKey(m[2]) });
    else (steps.length ? outro : intro).push(line);
  }
  return { intro, steps, outro };
}

/** Places in Pulse, as people write them ("Pulse → HR → Policies → Office presence"), and where each part opens.
 *  UX-5B: read from the destinations registry, which knows every page, tab and section. */
export function places(text) {
  return placesIn(String(text ?? "")).map((p) => ({ label: p.label, href: p.dest.href }));
}
/** Web links in the notes, with a short readable label. */
export function links(text) {
  const out = []; const seen = new Set();
  for (const m of String(text ?? "").matchAll(/https?:\/\/[^\s<>"“”]+/g)) {
    const href = m[0].replace(/[).,;:!?]+$/, "");
    if (seen.has(href)) continue; seen.add(href);
    let host = href; try { const u = new URL(href); host = u.hostname.replace(/^www\./, ""); const q = u.searchParams.get("q"); if (/(^|\.)google\.[a-z.]+$/.test(host) && u.pathname === "/search" && q) host = `Search “${q}”`; else if (u.pathname.length > 1 && host.split(".").length <= 3) host += u.pathname.split("/").slice(0, 2).join("/"); } catch { /* keep the raw text */ }
    out.push({ label: host, href });
  }
  return out;
}

/** "Why it matters" in one line: the value note, else the notes' first sentence, else the project's summary. */
export function whyLine(task, projectSummary) {
  const firstSentence = (s) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); const m = t.match(/^(.{12,200}?[.!?])(\s|$)/); return m ? m[1] : t.slice(0, 200); };
  if (task.valueNote?.trim()) return firstSentence(task.valueNote);
  const { intro } = parseNotes(task.notes);
  if (intro.length) return firstSentence(intro.join(" "));
  return projectSummary?.trim() ? firstSentence(projectSummary) : null;
}

// ---------------------------------------------------------------------------------------------------- the same work
const STOP = new Set(["a", "an", "and", "the", "to", "of", "for", "on", "in", "with", "that", "this", "it", "is", "by", "at", "or", "be", "from", "our", "your", "all", "every", "any"]);
const VERSION = /^(v\d+|\d+(\.\d+)*|draft|final|new)$/;
/** A word's stem, roughly: "invoices" → "invoice", "boxes" → "box", "policies" → "policy", "uploading" → "upload". */
export function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}
export function workTokens(title) {
  return [...new Set(String(title).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/)
    .map(stem).filter((w) => w.length > 1 && !STOP.has(w) && !VERSION.test(w)))];
}
/** How likely two titles name the same work, 0–1: the shared words over the shorter title's words (at least three).
 *  With the same verb they must also share a phrase ("Approve … staff notice"), unless nearly every word is shared;
 *  titles with different verbs must share nearly all. */
export function sameWork(a, b) {
  const x = workTokens(a), y = workTokens(b), ys = new Set(y);
  const shared = x.filter((w) => ys.has(w)).length;
  if (shared < 3 || !x.length || !y.length) return 0;
  const c = shared / Math.min(x.length, y.length);
  const pairs = (t) => new Set(t.slice(1, -1).map((w, i) => `${w} ${t[i + 2]}`));
  const py = pairs(y), phrase = [...pairs(x)].some((p) => py.has(p));
  const score = x[0] === y[0] ? (phrase || c >= 0.8 ? c : 0) : c >= 0.8 ? c * 0.9 : 0;
  return Math.round(score * 100) / 100;
}
/** Suggested when the same person has both open. Never merged automatically. */
export const SAME_WORK_AT = 0.6;
