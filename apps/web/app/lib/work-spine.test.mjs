// WORK-SPINE: the roll-up (tasks → project → goal), late and due-soon words, and the trail (lib/work-spine.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { countedWords, dueState, goalRollup, isDone, isOpen, projectHref, rollup, trail, typeWord } from "./work-spine.mjs";

test("a project's progress is finished of the tasks that count", () => {
  const r = rollup([{ status: "done" }, { status: "accepted" }, { status: "in_review" }, { status: "open" }, { status: "in_progress" }, { status: "blocked" },
    { status: "cancelled" }, { status: "not_applicable" }, { status: "merged" }]);
  assert.deepEqual(r, { total: 6, done: 3, open: 3, pct: 50 });
  assert.deepEqual(rollup([]), { total: 0, done: 0, open: 0, pct: 0 });
  assert.equal(rollup([{ status: "done" }, { status: "open" }, { status: "open" }]).pct, 33);
  assert.equal(rollup([{ status: "done" }]).pct, 100);
});

test("a goal's progress counts every task under it once (a big project weighs more)", () => {
  const g = goalRollup([{ total: 12, done: 3 }, { total: 2, done: 0 }]);
  assert.deepEqual(g, { total: 14, done: 3, parts: 2, pct: 21 });
  // Not the average of the projects' percentages (25% and 0% would say 13%).
  assert.notEqual(g.pct, Math.round((25 + 0) / 2));
  assert.deepEqual(goalRollup([]), { total: 0, done: 0, parts: 0, pct: 0 });
  // A bad count never goes over 100% or below 0.
  assert.equal(goalRollup([{ total: 2, done: 5 }]).pct, 100);
  assert.equal(goalRollup([{ total: -1, done: 0 }, { total: 4, done: 1 }]).pct, 25);
});

test("tasks finished, open, or neither", () => {
  for (const s of ["done", "accepted", "in_review"]) assert.ok(isDone(s));
  for (const s of ["open", "in_progress", "blocked", "unknown"]) assert.ok(isOpen(s));
  for (const s of ["cancelled", "not_applicable", "merged"]) assert.ok(!isDone(s) && !isOpen(s));
});

test("late is explained: the due day passed and it is not done", () => {
  const late = dueState("2026-11-09", "2026-11-10", "open");
  assert.equal(late.state, "late");
  assert.equal(late.chip, "Late · was due 9 Nov");
  assert.equal(late.why, "It was due 9 Nov (1 day ago) and is not done yet.");
  assert.match(dueState("2026-11-01", "2026-11-10", "blocked").why, /9 days ago/);
  // Finished or no due day: never late.
  assert.equal(dueState("2026-11-01", "2026-11-10", "done").state, "none");
  assert.equal(dueState("2026-11-01", "2026-11-10", "cancelled").state, "none");
  assert.equal(dueState(null, "2026-11-10", "open").state, "none");
});

test("due today, soon and later", () => {
  assert.deepEqual(dueState("2026-11-10", "2026-11-10", "open"), { state: "today", chip: "Due today", why: "Due today." });
  assert.equal(dueState("2026-11-11", "2026-11-10", "open").chip, "Due tomorrow");
  assert.equal(dueState("2026-11-12", "2026-11-10", "in_progress").state, "soon");
  assert.deepEqual(dueState("2026-11-28", "2026-11-10", "open"), { state: "ok", chip: "Due 28 Nov", why: null });
  assert.equal(dueState("2027-01-31", "2026-11-10", "open").chip, "Due 31 Jan 2027");
});

test("the trail goes Goal › Project › parent › task", () => {
  const t = trail({ goals: [{ id: "g1", title: "Register the company" }, { id: "g2", title: "Other" }], project: { id: "p1", name: "Incorporate" }, parents: [{ id: "t0", title: "SPICe+" }] });
  assert.deepEqual(t.items.map((x) => x.href), ["/goals/g1", "/tasks/projects/p1", "/tasks/t0"]);
  assert.deepEqual(t.items.map((x) => x.kind), ["goal", "project", "task"]);
  assert.equal(t.moreGoals, 1);
  assert.deepEqual(trail({}).items, []);
  assert.deepEqual(trail({ project: { id: "p1", name: "Incorporate" } }).items.map((x) => x.label), ["Incorporate"]);
});

test("every work project opens on its own page, with one type word", () => {
  assert.equal(projectHref("p1"), "/tasks/projects/p1");
  assert.equal(typeWord("internal"), "Internal");
  assert.equal(typeWord("client_delivery"), "Client");
  assert.equal(typeWord("personal"), "Personal");
  assert.equal(typeWord(null), "Internal");
});

test("the goal says how its number is counted", () => {
  assert.equal(countedWords({ basis: "work", tasks: 14, tasksDone: 3, projects: 2 }), "Counted from the tasks of 2 projects: every task finished moves it.");
  assert.equal(countedWords({ basis: "work", tasks: 1, tasksDone: 0, projects: 0 }), "Counted from the tasks: every task finished moves it.");
  assert.equal(countedWords({ basis: "measure" }), "Counted from the number you update.");
  assert.equal(countedWords({ basis: "none" }), "Link a project or a task, and its progress counts here.");
});

test("a project's view comes from its switch and never carries another project's filters", async () => {
  const { projectView } = await import("./work-spine.mjs");
  const leaked = { layout: "board", defaultLayout: null, config: { group: "person", sort: "title", filters: { people: ["someone-else"], q: "pan", status: "done" } } };
  const v = projectView({}, leaked);
  assert.equal(v.layout, "board");
  assert.equal(v.group, "person");
  assert.equal(v.sort, "title");
  assert.deepEqual(v.filters, { status: "all", due: "any", projects: [], people: [], tags: [], pool: false, q: "" });
  // Switching views: the page's own switch wins, for each of the four.
  for (const view of ["list", "board", "timeline", "calendar"]) assert.equal(projectView({ view }, leaked).layout, view);
  // Table and gallery are not project views; an unknown one falls back.
  assert.equal(projectView({ view: "gallery" }, null).layout, "list");
  assert.equal(projectView({ view: "nonsense" }, { layout: "table" }).layout, "list");
  assert.equal(projectView({}, { defaultLayout: "calendar", layout: "board" }).layout, "calendar");
  assert.equal(projectView({}, { config: { group: "none" } }).group, "status");
});

test("activity says what happened in plain words, not 'visibility set to members'", async () => {
  const { activityWords, activityTone } = await import("./work-spine.mjs");
  assert.equal(activityWords({ src: "task", kind: "created", by: "Asha", taskTitle: "Book the name" }), "Asha added “Book the name”");
  assert.equal(activityWords({ src: "task", kind: "status", from: "open", to: "done", by: "Asha", taskTitle: "Get PAN" }), "Asha finished “Get PAN”");
  assert.equal(activityWords({ src: "task", kind: "status", from: "done", to: "open", by: "Ravi", taskTitle: "Get PAN" }), "Ravi reopened “Get PAN”");
  assert.equal(activityWords({ src: "task", kind: "status", from: "open", to: "in_progress", by: "Ravi", taskTitle: "Get TAN" }), "Ravi started “Get TAN”");
  assert.equal(activityWords({ src: "task", kind: "assigned", to: "Kazuk Bukin", by: "Savuzo", taskTitle: "File Part A" }), "Savuzo gave “File Part A” to Kazuk Bukin");
  assert.equal(activityWords({ src: "project", kind: "visibility", from: "org", to: "members", by: "Savuzo" }), "Savuzo changed who can see it to its members");
  assert.equal(activityWords({ src: "project", kind: "project_type", from: "client_delivery", to: "internal", by: "Savuzo" }), "Savuzo changed the type to Internal");
  assert.equal(activityWords({ src: "project", kind: "owner_id", to: "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75", by: "Savuzo" }), "Savuzo changed the owner");
  assert.equal(activityWords({ src: "project", kind: "started_by", to: "person", by: "Savuzo" }), "Savuzo kept this project in the main list");
  assert.equal(activityWords({ src: "task", kind: "created", taskTitle: "x" }), "Pulse added “x”");
  assert.equal(activityTone({ kind: "status", to: "done" }), "good");
  assert.equal(activityTone({ kind: "blocked" }), "bad");
  assert.equal(activityTone({ kind: "created" }), "plain");
});

test("PROJECTS-FIX: a project's state in plain words, with why", async () => {
  const { projectState, taskInProjectHref } = await import("./work-spine.mjs");
  assert.equal(projectState({ status: "active", total: 14, open: 4, late: 1, blocked: 2 }).word, "Behind");
  assert.equal(projectState({ status: "active", total: 14, open: 4, late: 0, blocked: 2 }).word, "Waiting");
  assert.equal(projectState({ status: "active", total: 14, open: 4, late: 0, blocked: 0 }).word, "On track");
  assert.equal(projectState({ status: "active", total: 14, open: 14, late: 0, blocked: 0 }).word, "Not started");
  assert.equal(projectState({ status: "active", total: 14, open: 14, late: 0, blocked: 0, doing: 2 }).word, "On track");
  assert.equal(projectState({ status: "active", total: 3, open: 0, late: 0, blocked: 0 }).word, "All tasks done");
  assert.equal(projectState({ status: "active", total: 0, open: 0, late: 0, blocked: 0 }).word, "No tasks yet");
  assert.equal(projectState({ status: "paused", total: 5, open: 5, late: 3, blocked: 0 }).word, "Paused");
  assert.match(projectState({ status: "active", total: 2, open: 2, late: 1, blocked: 0 }).why, /1 task is past the due day/);
  assert.equal(taskInProjectHref({ id: "t1", projectId: "p1" }), "/tasks/projects/p1?task=t1");
  assert.equal(taskInProjectHref({ id: "t1", projectId: null }), "/tasks/t1");
});
