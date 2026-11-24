// REPLAY-FIXES #6: a half-written New task survives the app going to the background (lib/task-draft.mjs, create.tsx).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TASK_DRAFT_MAX_AGE_MS, draftOf, loadTaskDraft, plainNewTask, saveTaskDraft } from "./task-draft.mjs";

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test("a draft is kept only when something was written; person chips keep their name", () => {
  assert.equal(draftOf({ segs: [] }), null);
  assert.equal(draftOf({ segs: [{ kind: "text", text: "   " }], details: " " }), null);
  assert.deepEqual(draftOf({ segs: [{ kind: "text", text: "Call back " }, { kind: "person", id: "p1", name: "Kazuk Bukin" }, { kind: "text", text: " fri" }], whoId: "p1", due: { date: "2026-11-21", time: null }, priority: "high" }),
    { title: "Call back @Kazuk Bukin fri", details: "", whoId: "p1", due: { date: "2026-11-21", time: null }, project: null, priority: "high", category: null });
  assert.deepEqual(draftOf({ details: "Only details" }).details, "Only details");
});

test("saved per person, brought back the same day, forgotten after a day or when cleared", () => {
  const s = memory();
  const d = draftOf({ segs: [{ kind: "text", text: "Send the quote" }] });
  saveTaskDraft(s, "p1", d, 1000);
  assert.deepEqual(loadTaskDraft(s, "p1", 2000), d);
  assert.equal(loadTaskDraft(s, "p2", 2000), null, "another person's draft is not theirs");
  assert.equal(loadTaskDraft(s, "p1", 1000 + TASK_DRAFT_MAX_AGE_MS + 1), null, "a day old: forgotten");
  assert.equal(s.m.size, 0);
  saveTaskDraft(s, "p1", d, 5000); saveTaskDraft(s, "p1", null, 6000);
  assert.equal(loadTaskDraft(s, "p1", 7000), null, "created or thrown away: gone");
});

test("storage that is off or broken never breaks the form", () => {
  const off = { getItem() { throw new Error("off"); }, setItem() { throw new Error("off"); }, removeItem() { throw new Error("off"); } };
  assert.doesNotThrow(() => saveTaskDraft(off, "p1", { title: "x" }));
  assert.equal(loadTaskDraft(off, "p1"), null);
  const junk = memory(); junk.setItem("pulse.task.draft:p1", "{not json");
  assert.equal(loadTaskDraft(junk, "p1"), null);
});

test("only a plain New task keeps a draft (not one made from a chat, a project, a parent or with words given)", () => {
  assert.equal(plainNewTask({}), true);
  assert.equal(plainNewTask({ kind: "task" }), true);
  for (const r of [{ title: "x" }, { projectId: "p" }, { assigneeId: "a" }, { parentId: "t" }, { clientProjectId: "c" }, { chat: { channelId: "c" } }, { source: { label: "Mail" } }, { notes: "n" }])
    assert.equal(plainNewTask(r), false, JSON.stringify(r));
});

test("the New task form restores, keeps and clears the draft, and a click that brings the window back does not close it", () => {
  const src = readFileSync(new URL("../create.tsx", import.meta.url), "utf8");
  assert.match(src, /loadTaskDraft\(window\.localStorage, options\.me\)/);
  assert.match(src, /saveTaskDraft\(window\.localStorage, options\.me, draftOf\(/);
  assert.match(src, /saveTaskDraft\(window\.localStorage, options\.me, null\)/, "cleared once created (and by Start fresh)");
  assert.match(src, /Your unsent task is back/);
  assert.match(src, /Date\.now\(\) - back\.current < 600/, "the click that brought the window back is ignored");
});
