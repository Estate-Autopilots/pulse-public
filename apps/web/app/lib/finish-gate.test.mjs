// DITASU-FIX (owner, 17 Nov 2026): "Clicking task completed does nothing for a long time." In production Datup ticked parent
// tasks with open subtasks 9 times in three sessions; each was refused by the database (0310 task_finish_guard) and the
// screens said only "Not changed" in a corner. These tests keep every circle that marks a task done going to the task's
// finishing dialog instead (tasks/finish-gate.ts), before asking when the list knows, and on the server's refusal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { finishHref, finishWords, isOpenSubtasks, OPEN_SUBTASKS } from "./finish-gate.mjs";

const here = new URL("../", import.meta.url);
const src = (path) => readFileSync(new URL(path, here), "utf8");

test("the database's refusal is recognised, one subtask or many, and nothing else is", () => {
  // The exact sentences 0310's task_finish_guard raises (the API passes PL/pgSQL messages on as they are).
  assert.equal(isOpenSubtasks(new Error("Finish, move out or cancel its open subtask first")), true);
  assert.equal(isOpenSubtasks(new Error("Finish, move out or cancel 3 open subtasks first")), true);
  assert.equal(isOpenSubtasks("Finish, move out or cancel 12 open subtasks first"), true);
  for (const other of ["Task not found", "Only the people on this task, their pod head or leadership can change it", "Pulse data is temporarily unavailable", "", null, undefined, 42])
    assert.equal(isOpenSubtasks(other instanceof Error ? other : typeof other === "string" ? new Error(other) : other), false, String(other));
  const migration = readFileSync(new URL("../../../../db/migrations/0310_task_finish_review.sql", import.meta.url), "utf8");
  const raised = /raise exception 'Finish, move out or cancel % first',case when n=1 then '([^']+)' else n\|\|' ([^']+)' end/.exec(migration);
  assert.ok(raised, "0310 still raises the open-subtask sentence");
  assert.match(`Finish, move out or cancel ${raised[1]} first`, OPEN_SUBTASKS);
  assert.match(`Finish, move out or cancel 2 ${raised[2]} first`, OPEN_SUBTASKS);
});

test("the way through is the task page with Mark done open, in plain words", () => {
  assert.equal(finishHref("8c1f1d2e-0000-4000-8000-000000000001"), "/tasks/8c1f1d2e-0000-4000-8000-000000000001?finish=1");
  assert.deepEqual(finishWords(1), { title: "One subtask is still open", message: "Opening the task: finish, move out or cancel each one, then mark it done." });
  assert.equal(finishWords(3).title, "3 subtasks are still open");
  assert.equal(finishWords(undefined).title, "One subtask is still open", "a count the screen did not know still reads well");
  // The task page opens the dialog for ?finish=1 (TASKS-4B), and that dialog lists the open subtasks with their actions.
  const page = src("tasks/focus.tsx");
  assert.match(page, /finishNow/);
  assert.match(page, /<OpenSubtasks items=\{open\}/);
});

// Every screen that marks a task done through tasks/:id/move, and how it handles a parent with open subtasks.
const DONE_PATHS = ["tasks/views/table.tsx", "tasks/views/boards.tsx", "tasks/board.tsx", "tasks/my-work.tsx", "tasks/companion.tsx", "tasks/spine.tsx", "tasks/projects-tree.tsx", "tasks/client.tsx"];
// The goal/project spine's rows (TickTask) carry no subtask count: there the server's refusal is the signal.
const NO_COUNT = new Set(["tasks/spine.tsx"]);

test("every circle that marks a task done goes to the finishing dialog instead of a dead 'Not changed'", () => {
  for (const file of DONE_PATHS) {
    const s = src(file);
    assert.match(s, /tasks\/\$\{[^}]+\}\/move/, `${file} still marks tasks done here`);
    const handles = /finishInstead\(/.test(s) || /\/tasks\/\$\{[^}]+\}\?finish=1/.test(s);
    assert.ok(handles, `${file}: a refusal for open subtasks must open the task's finishing dialog`);
    const asksFirst = NO_COUNT.has(file) || /subtasksOpen|openSubtasks/.test(s);
    assert.ok(asksFirst, `${file}: a task the list knows has open subtasks goes there before any confirm question`);
  }
});

test("the table keeps a ticked task in its row, so the next one never slides under the pointer", () => {
  const s = src("tasks/views/table.tsx");
  assert.match(s, /setKept\(\(k\) => \(\{ \.\.\.k, \[t\.id\]:/, "a finished task is kept");
  assert.match(s, /Object\.values\(kept\)\.filter\(\(t\) => !here\.has\(t\.id\)\)/, "kept rows stay in the list after the refresh drops them");
});
