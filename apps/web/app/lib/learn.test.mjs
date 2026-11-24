import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DONE_KEY, PLAYLISTS, TUTORIALS, matchTutorial, parseDone, playlistTutorials, stepParts, stepPlain, stepTargets, tutorial, tutorialsFor } from "./learn.mjs";

const web = fileURLToPath(new URL("../../", import.meta.url));

test("XRAY-LINK: every tutorial is complete and every id is unique", () => {
  assert.equal(new Set(TUTORIALS.map((t) => t.id)).size, TUTORIALS.length);
  for (const t of TUTORIALS) {
    assert.match(t.id, /^[a-z0-9-]+$/, t.id);
    assert.ok(t.title && t.who && t.summary && t.minutes > 0, t.id);
    assert.ok(t.steps.length >= 2, `${t.id}: at least two steps`);
    assert.ok(t.tryHref.startsWith("/") && !t.tryHref.startsWith("//"), `${t.id}: Try it stays inside Pulse`);
    assert.ok(t.pages.length && t.pages.every((p) => p.startsWith("/") && !p.endsWith("/")), `${t.id}: pages`);
    assert.equal(new Set(t.steps.filter((s) => s.shot).map((s) => s.shot)).size, t.steps.filter((s) => s.shot).length, `${t.id}: one shot per step`);
  }
});

test("XRAY-LINK: every playlist names known tutorials and every tutorial is in a topic playlist", () => {
  for (const p of PLAYLISTS) {
    assert.ok(p.items.length, p.id);
    for (const id of p.items) assert.ok(tutorial(id), `${p.id}: ${id}`);
    assert.equal(playlistTutorials(p.id).length, p.items.length);
  }
  for (const t of TUTORIALS) assert.ok(PLAYLISTS.some((p) => p.kind === "topic" && p.items.includes(t.id)), `${t.id} has a topic`);
  assert.ok(PLAYLISTS.some((p) => p.kind === "role"));
});

test("XRAY-LINK: How do I… finds a page's tutorials, nested pages and queries included, and nothing on other pages", () => {
  assert.deepEqual(tutorialsFor("/tasks").map((t) => t.id), ["tasks-basics"]);
  assert.ok(tutorialsFor("/tasks/0a1b?view=list").some((t) => t.id === "tasks-basics"));
  assert.deepEqual(tutorialsFor("/people/ai/123").map((t) => t.id)[0], "ai-employees", "the longest page first");
  assert.ok(tutorialsFor("/connections").some((t) => t.id === "close-a-deal"));
  assert.deepEqual(tutorialsFor("/taskschedule"), []);
  assert.deepEqual(tutorialsFor(""), []);
  assert.deepEqual(tutorialsFor("/kit"), []);
});

test("XRAY-LINK: **labels** split out of a step's words", () => {
  assert.deepEqual(stepParts("Press **New task** now"), [{ text: "Press ", ui: false }, { text: "New task", ui: true }, { text: " now", ui: false }]);
  assert.deepEqual(stepParts("plain"), [{ text: "plain", ui: false }]);
  for (const t of TUTORIALS) for (const s of t.steps) assert.equal((s.text.match(/\*\*/g) ?? []).length % 2, 0, `${t.id}: unbalanced ** in "${s.text}"`);
});

test("XRAY-LINK: the done list survives only as known ids; junk reads as empty", () => {
  assert.ok(DONE_KEY.startsWith("pulse.learn"));
  assert.deepEqual([...parseDone(JSON.stringify(["tasks-basics", "nope", 3]))], ["tasks-basics"]);
  assert.equal(parseDone("{bad").size, 0);
  assert.equal(parseDone(null).size, 0);
  assert.equal(parseDone('{"a":1}').size, 0);
});

test("XRAY-LINK: every screenshot a step names is in public/learn-shots, small enough for the web", () => {
  for (const t of TUTORIALS) for (const s of t.steps.filter((x) => x.shot)) {
    const file = `${web}public/learn-shots/${t.id}/${s.shot}.webp`;
    assert.ok(existsSync(file), `missing ${t.id}/${s.shot}.webp (tools/tutorials: shots.mjs, then learn.py webp)`);
    assert.ok(readFileSync(file).length < 250_000, `${t.id}/${s.shot}.webp is over 250 kB`);
  }
});

test("XRAY-LINK: learn-media.json names only tutorials that exist and plain file names", () => {
  const m = JSON.parse(readFileSync(new URL("./learn-media.json", import.meta.url), "utf8"));
  for (const [id, rec] of Object.entries(m.tutorials ?? {})) {
    assert.ok(tutorial(id), id);
    for (const f of [...Object.values(rec.video ?? {}), ...Object.values(rec.captions ?? {}), rec.poster].filter(Boolean)) assert.match(f, /^[a-z0-9][a-z0-9._-]*$/i, f);
    for (const url of Object.values(rec.youtube ?? {}).filter(Boolean)) assert.match(url, /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//, url);
  }
});

test("DOCS-EDITOR-8: \"how do I …\" finds the walkthrough that answers it, and nothing for a question no walkthrough answers", () => {
  const id = (q) => matchTutorial(q)?.id ?? null;
  assert.equal(id("How do I add a task?"), "tasks-basics");
  assert.equal(id("how to add task"), "tasks-basics");
  assert.equal(id("How do I add a bank statement"), "add-a-bank-statement");
  assert.equal(id("upload my statements"), "add-a-bank-statement");
  assert.equal(id("how do i record an expense"), "add-an-expense");
  assert.equal(id("send a quote"), "make-a-quotation");
  assert.equal(id("apply for a day off"), "apply-for-leave");
  assert.equal(id("add-a-bank-statement"), "add-a-bank-statement", "an id names one outright");
  assert.equal(id("how do i bake a cake"), null);
  assert.equal(id("how do I"), null);
  assert.equal(id(""), null);
  assert.equal(id(null), null);
});

test("DOCS-EDITOR-8: a step points at its `point` first, then its **labels**; every point is one of its labels", () => {
  assert.deepEqual(stepTargets({ text: "Press **A** and **B**" }), ["A", "B"]);
  assert.deepEqual(stepTargets({ text: "Press **A** and **B**", point: "B" }), ["B", "A"]);
  assert.deepEqual(stepTargets({ text: "No labels" }), []);
  assert.equal(stepPlain({ text: "Press **New task**." }), "Press New task.");
  for (const t of TUTORIALS) for (const s of t.steps) if (s.point) assert.ok(stepParts(s.text).some((p) => p.ui && p.text === s.point), `${t.id}: point "${s.point}" is one of the step's **labels**`);
  const bank = tutorial("add-a-bank-statement");
  assert.ok(bank && bank.tryHref === "/finance?tab=reconcile" && bank.steps.length >= 3);
});

test("DOCS-EDITOR-10: the walkthroughs an AI employee plays say in a few words what it does for them, and their first step is one sentence", () => {
  for (const id of ["tasks-basics", "add-a-bank-statement", "apply-for-leave"]) {
    const t = tutorial(id);
    assert.ok(t?.doing && /^[a-z]+ing\b/.test(t.doing) && t.doing.length <= 32, `${id}: doing "${t?.doing}" is a few plain words ("adding a task")`);
    // The guide bar shows a step's first sentence only: the first step must not lean on a second one.
    assert.equal(t.steps[0].text.search(/[.!?](\s+)(?=[A-Z@#“"(*])/), -1, `${id}: step 1 is one sentence`);
  }
  for (const t of TUTORIALS) if (t.doing !== undefined) assert.ok(typeof t.doing === "string" && t.doing.length > 0, `${t.id}: doing is words`);
});
