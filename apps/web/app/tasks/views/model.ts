// TASKS-4A: one view system for Work, like a database's views. A place (my tasks, a pod, the company, a person, a
// project, the pool) shows the same rows as a List, Board, Table, Calendar, Timeline or Gallery, grouped, sorted and
// filtered in the browser. This file is the pure part: the config, what it does to rows, and how it sits in the URL.
import type { Task } from "../types";
import { eisenhower, EISENHOWER } from "../priority";

export const LAYOUTS = ["list", "board", "table", "calendar", "timeline", "gallery"] as const;
export type Layout = typeof LAYOUTS[number];
export const GROUPS = ["none", "status", "when", "priority", "person", "project", "kind", "eisenhower"] as const;
export type Group = typeof GROUPS[number];
export const SORTS = ["due", "priority", "value", "updated", "created", "title"] as const;
export type Sort = typeof SORTS[number];
export const DUES = ["any", "overdue", "today", "week", "next", "none"] as const;
export type Due = typeof DUES[number];
export const STATUSES = ["open", "doing", "blocked", "done", "all"] as const;
export type StatusFilter = typeof STATUSES[number];
export type Filters = { status: StatusFilter; due: Due; projects: string[]; people: string[]; tags: string[]; pool: boolean; q: string };
export type ViewConfig = { layout: Layout; group: Group; sort: Sort; filters: Filters };
export type Place = "me" | "pod" | "company" | "person" | "project" | "pool";
export type SavedView = { id: string; name: string; config: Partial<ViewConfig> };
/** A place's remembered view, from GET work/views. */
export type ViewPrefs = { place: string; layout: Layout | null; defaultLayout: Layout | null; config: Partial<ViewConfig>; saved: SavedView[]; ask: Layout | null };

export const LAYOUT_LABEL: Record<Layout, string> = { list: "List", board: "Board", table: "Table", calendar: "Calendar", timeline: "Timeline", gallery: "Gallery" };
export const GROUP_LABEL: Record<Group, string> = { none: "No grouping", status: "Status", when: "When", priority: "Priority", person: "Person", project: "Project", kind: "Kind of work", eisenhower: "Importance × urgency" };
export const SORT_LABEL: Record<Sort, string> = { due: "Due date", priority: "Priority", value: "Value", updated: "Recently changed", created: "Newest", title: "Title" };
export const DUE_LABEL: Record<Due, string> = { any: "Any time", overdue: "Overdue", today: "Due today", week: "Due this week", next: "Due next week", none: "No due date" };
export const STATUS_LABEL: Record<StatusFilter, string> = { open: "Open", doing: "Doing", blocked: "Blocked", done: "Finished", all: "Everything" };
export const NO_FILTERS: Filters = { status: "open", due: "any", projects: [], people: [], tags: [], pool: false, q: "" };
/** What each place opens with before anyone chose (the API keeps the same defaults). */
export const DEFAULTS: Record<Place, ViewConfig> = {
  me: { layout: "list", group: "when", sort: "due", filters: NO_FILTERS },
  pod: { layout: "board", group: "status", sort: "due", filters: NO_FILTERS },
  company: { layout: "table", group: "none", sort: "due", filters: NO_FILTERS },
  person: { layout: "list", group: "when", sort: "due", filters: NO_FILTERS },
  project: { layout: "list", group: "status", sort: "due", filters: NO_FILTERS },
  pool: { layout: "gallery", group: "none", sort: "priority", filters: NO_FILTERS },
};

const FINISHED = ["done", "in_review", "accepted"];
const OPEN = ["open", "in_progress", "blocked", "unknown"];
const DAY = 86400000;
const days = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
const weekEnd = (today: string) => { const wd = new Date(`${today}T00:00:00Z`).getUTCDay(); return new Date(Date.parse(`${today}T00:00:00Z`) + ((7 - wd) % 7) * DAY).toISOString().slice(0, 10); };
export const isFinished = (t: Pick<Task, "status">) => FINISHED.includes(t.status);

/** The filters, in order: status, due, project, person, tags, pool, words. */
export function applyFilters(rows: Task[], f: Filters, today: string): Task[] {
  const end = weekEnd(today), nextEnd = new Date(Date.parse(`${end}T00:00:00Z`) + 7 * DAY).toISOString().slice(0, 10);
  const q = f.q.trim().toLowerCase();
  return rows.filter((t) => {
    if (f.status === "open" && !OPEN.includes(t.status)) return false;
    if (f.status === "doing" && t.status !== "in_progress") return false;
    if (f.status === "blocked" && !(t.status === "blocked" || (t.openBlockers > 0 && OPEN.includes(t.status)))) return false;
    if (f.status === "done" && !FINISHED.includes(t.status)) return false;
    const due = t.dueOn;
    if (f.due === "overdue" && !(due && due < today && !isFinished(t))) return false;
    if (f.due === "today" && due !== today) return false;
    if (f.due === "week" && !(due && due >= today && due <= end)) return false;
    if (f.due === "next" && !(due && due > end && due <= nextEnd)) return false;
    if (f.due === "none" && due) return false;
    if (f.projects.length && !f.projects.includes(t.projectId ?? "none")) return false;
    if (f.people.length && !f.people.includes(t.assigneeId ?? "none")) return false;
    if (f.tags.length && !f.tags.some((x) => t.tags?.includes(x))) return false;
    if (f.pool && !(t.poolScope && !t.assigneeId)) return false;
    if (q && !`${t.title} ${t.projectName ?? ""} ${t.assigneeName ?? ""} ${(t.tags ?? []).join(" ")}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
export const activeFilters = (f: Filters) => (f.status !== "open" ? 1 : 0) + (f.due !== "any" ? 1 : 0) + f.projects.length + f.people.length + f.tags.length + (f.pool ? 1 : 0) + (f.q.trim() ? 1 : 0);

const RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
export function sortRows(rows: Task[], sort: Sort, dir: 1 | -1 = 1): Task[] {
  const due = (t: Task) => Date.parse(t.dueAt ?? "") || Infinity;
  const by: Record<Sort, (a: Task, b: Task) => number> = {
    due: (a, b) => due(a) - due(b) || RANK[a.priority] - RANK[b.priority],
    priority: (a, b) => RANK[a.priority] - RANK[b.priority] || due(a) - due(b),
    value: (a, b) => RANK[a.priority] - RANK[b.priority] || due(a) - due(b), // INTEGRITY: no value; saved "value" sorts by priority
    updated: (a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0),
    created: (a, b) => (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0),
    title: (a, b) => a.title.localeCompare(b.title),
  };
  return [...rows].sort((a, b) => dir * by[sort](a, b) || a.title.localeCompare(b.title));
}

export type Bucket = { key: string; label: string; tone?: "late" | "now" | "accent" | "muted"; hint?: string; rows: Task[] };
const STATUS_GROUPS: [string, string, (t: Task) => boolean][] = [["todo", "To do", (t) => t.status === "open" || t.status === "unknown"], ["doing", "Doing", (t) => t.status === "in_progress"],
  ["blocked", "Blocked", (t) => t.status === "blocked"], ["review", "Done, waiting for review", (t) => t.status === "done" || t.status === "in_review"], ["accepted", "Accepted", (t) => t.status === "accepted"],
  ["cancelled", "Cancelled", (t) => t.status === "cancelled"]];
/** Rows into groups, in a sensible order for each grouping; empty groups are kept for a board's columns. */
export function groupRows(rows: Task[], group: Group, today: string, me?: string | null): Bucket[] {
  if (group === "none") return [{ key: "all", label: "All tasks", rows }];
  if (group === "status") return STATUS_GROUPS.map(([key, label, is]) => ({ key, label, rows: rows.filter(is), tone: key === "blocked" ? "late" as const : undefined })).filter((b) => b.rows.length || b.key !== "cancelled");
  if (group === "when") {
    const end = weekEnd(today);
    const of = (t: Task) => isFinished(t) ? "done" : !t.dueOn ? "none" : t.dueOn < today ? "overdue" : t.dueOn === today ? "today" : t.dueOn <= end ? "week" : "later";
    return ([["overdue", "Overdue", "late"], ["today", "Today", "now"], ["week", "This week"], ["later", "Later"], ["none", "No date", "muted"], ["done", "Finished", "muted"]] as [string, string, Bucket["tone"]?][])
      .map(([key, label, tone]) => ({ key, label, tone, rows: rows.filter((t) => of(t) === key) }));
  }
  if (group === "priority") return (["urgent", "high", "normal", "low"] as const).map((p) => ({ key: p, label: { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" }[p], tone: p === "urgent" ? "late" as const : undefined, rows: rows.filter((t) => t.priority === p) }));
  if (group === "eisenhower") return Object.entries(EISENHOWER).map(([key, e]) => ({ key, label: e.label, hint: e.hint, tone: key === "now" ? "late" as const : undefined, rows: rows.filter((t) => eisenhower(t, today) === key) }));
  const keyOf = (t: Task) => group === "person" ? t.assigneeId ?? "none" : group === "project" ? t.projectId ?? "none" : t.category ?? "none";
  const labelOf = (t: Task) => group === "person" ? (t.assigneeId === me ? "Me" : t.assigneeName ?? (t.poolScope ? "In the pool" : "Nobody yet")) : group === "project" ? t.projectName ?? "No project" : t.categoryLabel ?? "Other";
  const map = new Map<string, Bucket>();
  for (const t of rows) { const k = keyOf(t); if (!map.has(k)) map.set(k, { key: k, label: labelOf(t), rows: [] }); map.get(k)!.rows.push(t); }
  return [...map.values()].sort((a, b) => (a.key === "none" ? 1 : 0) - (b.key === "none" ? 1 : 0) || (a.key === me ? -1 : b.key === me ? 1 : 0) || b.rows.length - a.rows.length || a.label.localeCompare(b.label));
}
/** Days until due: negative is late. */
export const dueIn = (t: Pick<Task, "dueOn">, today: string) => t.dueOn ? days(t.dueOn, today) : null;

// ----------------------------------------------------------------------------------------------------- the URL
const list = (v: string | null | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const one = <T extends string>(v: string | null | undefined, all: readonly T[], d: T): T => (all as readonly string[]).includes(v ?? "") ? v as T : d;
/** The view in the URL (layout, group, sort and filters), over the person's remembered one, over the place's default. */
export function readConfig(q: Record<string, string | undefined>, saved: Partial<ViewConfig> | null, place: Place, rememberedLayout?: string | null): ViewConfig {
  const d = DEFAULTS[place], s = saved ?? {};
  const sf = (s.filters ?? {}) as Partial<Filters>;
  return {
    layout: one(q.layout, LAYOUTS, one(rememberedLayout ?? undefined, LAYOUTS, s.layout ?? d.layout)),
    group: one(q.group === "focus" ? "when" : q.group, GROUPS, s.group ?? d.group),
    sort: one(q.sort, SORTS, s.sort ?? d.sort),
    filters: {
      status: one(q.status === "in_progress" ? "doing" : q.status, STATUSES, sf.status ?? d.filters.status),
      due: one(q.due, DUES, sf.due ?? "any"),
      projects: q.projects !== undefined ? list(q.projects) : sf.projects ?? [], people: q.people !== undefined ? list(q.people) : sf.people ?? [],
      tags: q.tags !== undefined ? list(q.tags) : sf.tags ?? [], pool: q.pool !== undefined ? q.pool === "1" : sf.pool ?? false, q: q.q ?? sf.q ?? "",
    },
  };
}
/** Only what differs from the place's default goes in the URL. */
export function writeConfig(c: ViewConfig, place: Place, base: URLSearchParams) {
  const d = DEFAULTS[place], out = new URLSearchParams(base);
  for (const k of ["layout", "group", "sort", "status", "due", "projects", "people", "tags", "pool", "q", "view"]) out.delete(k);
  if (c.layout !== d.layout) out.set("layout", c.layout);
  if (c.group !== d.group) out.set("group", c.group);
  if (c.sort !== d.sort) out.set("sort", c.sort);
  const f = c.filters;
  if (f.status !== d.filters.status) out.set("status", f.status);
  if (f.due !== "any") out.set("due", f.due);
  if (f.projects.length) out.set("projects", f.projects.join(","));
  if (f.people.length) out.set("people", f.people.join(","));
  if (f.tags.length) out.set("tags", f.tags.join(","));
  if (f.pool) out.set("pool", "1");
  if (f.q.trim()) out.set("q", f.q.trim());
  return out;
}
