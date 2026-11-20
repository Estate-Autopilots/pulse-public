// NAV-CONNECT (owner, 17 Nov 2026: "The new-update pop-up highlights the wrong thing, just one thing at the top, and
// doesn't take you to the specific item arrow by arrow"): the path from What's new to the change, step by step, and the
// rule that it never points at a guess. Lines here are synthetic, written like the real release lines of 16–17 Nov.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PATH_MS, inferAnchor, pathFrom, pathPlan, stepWords } from "./new-path.mjs";

const registry = JSON.parse(readFileSync(new URL("./new-anchors.json", import.meta.url), "utf8"));
const MONEY = { group: "money", groupLabel: "Money", href: "/erp", label: "Billing" };
const CHAT = { group: "chat", groupLabel: "Messages", href: "/chats", label: "Chats" };

test("from another page: the rail's group, then the page in its list, then the thing", () => {
  assert.deepEqual(pathPlan({ route: "/chats", anchor: "chats.search", here: "/dashboard", spot: CHAT, rail: true }), [
    { kind: "rail", group: "chat", label: "Messages" },
    { kind: "menu", group: "chat", href: "/chats", label: "Chats" },
    { kind: "thing", anchor: "chats.search" },
  ]);
  assert.equal(stepWords(0, 3), "Step 1 of 3");
  assert.equal(stepWords(0, 1), "", "a one-step path says no count");
});

test("a change to a page as a whole ends on the page's own entry (Open it), never on a guessed thing or its title", () => {
  const steps = pathPlan({ route: "/erp/documents", here: "/whats-new", spot: MONEY, rail: true });
  assert.deepEqual(steps, [{ kind: "rail", group: "money", label: "Money" }, { kind: "menu", group: "money", href: "/erp", label: "Billing" }, { kind: "note", label: "Billing" }]);
});

test("already on the page, or on a phone (no rail lists), the path is the last step only", () => {
  assert.deepEqual(pathPlan({ route: "/chats", anchor: "chats.search", here: "/chats", spot: CHAT, rail: true }), [{ kind: "thing", anchor: "chats.search" }]);
  assert.deepEqual(pathPlan({ route: "/chats", here: "/dashboard", spot: CHAT, rail: false }), [{ kind: "page", label: "Chats" }]);
  assert.deepEqual(pathPlan({ route: "/nowhere", here: "/dashboard", spot: null, rail: true }), [{ kind: "page", label: "This page" }], "a page no menu entry holds");
});

test("a change to the whole app (route /) stays where the person is", () => {
  assert.deepEqual(pathPlan({ route: "/", anchor: "shell.rail", here: "/tasks", spot: null, rail: true }), [{ kind: "thing", anchor: "shell.rail" }]);
  assert.deepEqual(pathPlan({ route: "/", here: "/tasks", spot: null, rail: true }), [{ kind: "page", label: "Everywhere in Pulse" }]);
});

test("a line without an anchor finds its thing only when exactly one thing on its page matches", () => {
  const line = (route, text, anchor = "") => ({ route, text, anchor });
  // Lines like the real ones of 16–17 Nov:
  assert.equal(inferAnchor(line("/chats", "Chats search now ignores accents, so a name is found however you type it."), registry), "chats.search");
  assert.equal(inferAnchor(line("/contacts", "The contact book now has People, Companies and Clients tabs, each with its count."), registry), "contacts.tabs");
  assert.equal(inferAnchor(line("/", "Rest your mouse on a side menu group, like Sales or Money, and it opens beside it."), registry), "shell.rail");
  assert.equal(inferAnchor(line("/tasks", "Tap New task, then pick a template."), registry), "work.new-task");
  // Behaviour, not a thing: the page itself.
  assert.equal(inferAnchor(line("/chats", "Voice notes now hear words like kilowatt correctly."), registry), "");
  assert.equal(inferAnchor(line("/erp/documents", "Your online shop can now get the PDF of an issued invoice."), registry), "");
  // Two things named: no guess.
  assert.equal(inferAnchor(line("/tasks", "The pool and Reviews are tidier."), registry), "");
  // A thing on another page is never taken.
  assert.equal(inferAnchor(line("/docs", "Search chats from the doc."), registry), "");
  // A line's own anchor wins when the registry knows it; an unknown one is dropped.
  assert.equal(inferAnchor(line("/tasks", "Anything", "work.more.pool"), registry), "work.more.pool");
  assert.equal(inferAnchor(line("/tasks", "Anything", "work.nope"), registry), "");
  assert.equal(inferAnchor(null, registry), "");
});

test("a stored path is checked before it is followed", () => {
  const now = 1_800_000_000_000;
  const good = { route: "/chats", href: "/chats", text: "Search", anchor: "chats.search", inferred: true, steps: [{ kind: "rail" }, { kind: "menu" }, { kind: "thing" }], i: 1, at: now - 1000 };
  assert.equal(pathFrom(good, now)?.i, 1);
  assert.equal(pathFrom({ ...good, at: now - PATH_MS - 1 }, now), null, "too old");
  for (const bad of [null, "x", { ...good, route: "//evil.example" }, { ...good, href: "https://evil.example" }, { ...good, i: 3 }, { ...good, steps: [] }, { ...good, steps: [{ kind: "jump" }] }])
    assert.equal(pathFrom(bad, now), null, JSON.stringify(bad));
});
