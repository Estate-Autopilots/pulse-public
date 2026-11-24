import assert from "node:assert/strict";
import { test } from "node:test";
import { GROUP_ORDER, GROUP_TEXT, RULE_TEXT, appKind, roleName } from "./ai-access.mjs";

test("five parts, each with plain words", () => {
  assert.deepEqual([...GROUP_ORDER], ["read", "work", "messages", "money", "delete"]);
  for (const g of GROUP_ORDER) {
    const t = GROUP_TEXT[g];
    assert.ok(t.label && t.hint && t.verb, g);
    // Short and plain: no word longer than 12 letters, no jargon.
    for (const s of [t.label, t.hint, t.verb]) {
      assert.ok(!/(api|scope|oauth|mcp|token|endpoint|tenant)/i.test(s), `${g}: ${s}`);
      assert.ok(s.split(/\s+/).every((w) => w.replace(/[^A-Za-z-]/g, "").length <= 12), `${g}: ${s}`);
    }
  }
});

test("the three choices match AI employees' words", () => {
  assert.deepEqual(RULE_TEXT, { on: "On its own", ask: "Ask first", off: "Never" });
});

test("app marks and role names", () => {
  assert.equal(appKind("Claude"), "claude");
  assert.equal(appKind("ChatGPT"), "chatgpt");
  assert.equal(appKind("Pulse CLI (laptop)"), "cli");
  assert.equal(appKind("Cursor"), "other");
  assert.equal(roleName("leadership"), "in leadership");
  assert.equal(roleName("site_lead"), "site lead");
});

test("the log reads in plain words, repeats grouped", async () => {
  const { actionWords, outcomeWords, groupLog, askParts } = await import("./ai-access.mjs");
  assert.equal(actionWords("createTask"), "Made a task");
  assert.equal(actionWords("listTasks"), "Looked at tasks");
  assert.equal(actionWords("useOrganisation"), "Switched company");
  assert.equal(actionWords("sendMessage"), "Sent a message");
  assert.equal(actionWords("deleteProject"), "Deleted a project");
  assert.equal(outcomeWords(200, null), "done"); assert.equal(outcomeWords(403, "ask"), "waiting for a yes"); assert.equal(outcomeWords(403, "off"), "stopped by your rules"); assert.equal(outcomeWords(403, null), "stopped");
  const g = groupLog([{ operation: "createTask", status: 403, rule: "ask", at: "2026-11-24T01:00:00Z" }, { operation: "createTask", status: 403, rule: "ask", at: "2026-11-24T00:59:00Z" },
    { operation: "createTask", status: 200, rule: "approved", at: "2026-11-24T00:58:00Z" }]);
  assert.deepEqual(g.map((x) => [x.what, x.how, x.times]), [["Made a task", "waiting for a yes", 2], ["Made a task", "done after a yes", 1]]);
  assert.deepEqual(askParts("Create a task: title: Call the plumber"), { title: "Create a task", details: "title: Call the plumber" });
});
