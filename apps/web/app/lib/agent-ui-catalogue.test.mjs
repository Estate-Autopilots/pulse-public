// AGENT-UI-CONTROL: the browser's screen actions are the API's (services/api/data/agent-ui-actions.json), with the same
// levels, and every prompt and activity line is plain words (no raw ids or addresses where a name fits).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACTIONS, FORMS, KINDS, LEVELS, asks, did, isEmoji, levelOf, placeName } from "../agent-ui/catalogue.mjs";

const api = JSON.parse(readFileSync(new URL("../../../../services/api/data/agent-ui-actions.json", import.meta.url), "utf8"));

test("the same actions, levels, forms and level words as the API", () => {
  assert.deepEqual(Object.keys(ACTIONS).sort(), api.actions.map((a) => a.name).sort());
  for (const a of api.actions) { assert.equal(ACTIONS[a.name].level, a.level, a.name); assert.equal(ACTIONS[a.name].asks, a.asks, a.name); assert.equal(ACTIONS[a.name].did, a.did, a.name); }
  assert.deepEqual(FORMS, api.forms);
  assert.deepEqual(Object.keys(KINDS).sort(), Object.keys(ACTIONS).sort(), "each kind has its few words");
  assert.deepEqual(LEVELS, api.levels);
  assert.ok(new RegExp(api.adminPaths, "i").test("/settings?tab=ai"));
});

test("the ActionName type lists every action (agent-ui/actions.tsx handles each: a Record<ActionName, …>, so typecheck fails on a missing one)", () => {
  const types = readFileSync(new URL("../agent-ui/catalogue.d.mts", import.meta.url), "utf8");
  const names = [...(types.match(/export type ActionName = ([^;]+);/)?.[1] ?? "").matchAll(/"([a-z]+\.[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), Object.keys(ACTIONS).sort());
});

test("prompts say what it wants in plain words", () => {
  assert.equal(asks("panel.open", { target: "/erp/documents/0a0a0a0a-0000-4000-8000-000000000001" }), "open the quotation beside the chat");
  assert.equal(asks("panel.open", { target: "quote:0a0a0a0a-0000-4000-8000-000000000001" }), "open the quotation beside the chat");
  assert.equal(asks("panel.open", { target: "/tasks", title: "My tasks" }), "open “My tasks” beside the chat");
  assert.equal(asks("sidebar.set", { open: false }), "close the sidebar");
  assert.equal(did("sidebar.set", { open: true }), "Opened the sidebar");
  assert.equal(asks("form.open", { form: "client" }), "open the client form");
  assert.equal(asks("emoji.insert", { emoji: "🎉" }), "add 🎉 to your message");
  assert.equal(asks("page.open", { path: "/settings?tab=ai" }), "open Settings");
  assert.equal(placeName("https://docs.google.com/document/d/abc"), "a Google Doc");
  assert.equal(placeName("https://www.example.com/x"), "example.com");
  assert.equal(placeName("0a0a0a0a-0000-4000-8000-000000000001"), "a page", "never a raw id");
  assert.equal(asks("screen.wipe"), "use your screen");
});

test("levels as the database decides them", () => {
  assert.equal(levelOf("page.open", { path: "/tasks" }), "view");
  assert.equal(levelOf("page.open", { path: "/settings" }), "admin");
  assert.equal(levelOf("panel.open", { target: "https://pulse.example/admin/x" }), "admin");
  assert.equal(levelOf("form.open", { form: "person" }), "admin");
  assert.equal(levelOf("form.open", { form: "task" }), "act");
  assert.equal(levelOf("mic.start"), "act");
  assert.equal(levelOf("nope"), null);
  assert.ok(isEmoji("🎉") && isEmoji("👍🏽") && !isEmoji("hi") && !isEmoji("<b>") && !isEmoji(""));
});

test("FIX-CHAT-AI / AGENT-OPERATOR: a click that deletes, sends, pays or approves needs the person's yes (confirm); reading the screen is view; a fill is act", () => {
  assert.equal(levelOf("screen.read"), "view");
  assert.equal(levelOf("element.click", { text: "Remove" }), "confirm");
  assert.equal(levelOf("element.click", { text: "Send for approval" }), "confirm");
  assert.equal(levelOf("element.click", { text: "Pay ₹4,000" }), "confirm");
  assert.equal(levelOf("file.upload", { file: "file:abcdef12" }), "act");
  assert.equal(levelOf("file.download", { text: "Download PDF" }), "act");
  assert.equal(asks("file.download", { text: "Download PDF" }), "download “Download PDF” into the chat");
  assert.equal(levelOf("element.click", { text: "Add a line" }), "act");
  assert.equal(levelOf("field.fill", { field: "Client" }), "act");
  assert.equal(asks("element.click", { text: "Remove" }), "click “Remove”");
  assert.equal(did("field.fill", { field: "Client name" }), "Filled in “Client name”");
});

test("DOCS-EDITOR-8: showing how is view (it points and shows steps, never clicks), in plain words", () => {
  assert.equal(levelOf("guide.play", { question: "How do I add a task?" }), "view");
  assert.equal(asks("guide.play", { question: "add a bank statement" }), "show you how, step by step: “add a bank statement”");
  assert.equal(did("guide.play", { question: "add a task" }), "Showed you how: “add a task”");
});
