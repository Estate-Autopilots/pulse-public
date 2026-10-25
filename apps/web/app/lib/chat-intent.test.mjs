import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_OPEN, SUGGEST, decide, detectIntent, openablePlaces } from "./chat-intent.mjs";

// Synthetic people and projects only.
const ctx = { viewer: "p-me", projects: [{ id: "w1", name: "Riverside Villas" }, { id: "w2", name: "Website" }, { id: "w3", name: "Ops" }], people: [{ id: "p-ravi", name: "Ravi Kalah" }, { id: "p-me", name: "Asha Rao" }] };

test("“update your profile in My profile” opens the reader's own profile by itself, with Pip on the edit card", () => {
  const { auto } = decide(detectIntent("Please update your profile in My profile", ctx));
  assert.ok(auto, "opens by itself");
  assert.equal(auto.href, "/people/p-me?tab=info");
  assert.equal(auto.coach.selector, "#info-about");
  assert.ok(auto.confidence >= AUTO_OPEN);
});

test("“add tasks to the Riverside Villas project” opens that project and points at Add task", () => {
  const { auto } = decide(detectIntent("Can you add tasks to the Riverside Villas project for the site visit?", ctx));
  assert.equal(auto?.href, "/tasks/projects/w1");
  assert.equal(auto.coach.button, "Add task");
});

test("a one-word project name needs the word project", () => {
  assert.equal(detectIntent("the website is slow today", ctx).some((i) => i.id === "project:w2"), false);
  assert.equal(detectIntent("update the Website project timeline", ctx).some((i) => i.id === "project:w2"), true);
  assert.equal(detectIntent("ops review project", ctx).some((i) => i.id === "project:w3"), false, "too short to trust");
});

test("places by the words people use: a chip unless clearly asked", () => {
  const leave = decide(detectIntent("Please apply for leave before Friday", ctx));
  const all = [leave.auto, ...leave.chips].filter(Boolean);
  assert.ok(all.some((i) => i.href === "/me?tab=leave"), "apply for leave → My desk → Leave");
  const finance = detectIntent("check the Finance page for the July numbers", { ...ctx, role: "Organisation owner/admin" });
  assert.ok(finance.some((i) => i.href === "/finance" && i.confidence >= SUGGEST));
});

test("ordinary chat says nothing", () => {
  for (const text of ["thanks!", "see you at home", "ok me too", "good morning team", "what time is the meeting", "I will leave at 5", "", "/task call the client"])
    assert.deepEqual(decide(detectIntent(text, ctx)), { auto: null, chips: [] }, text);
});

test("someone's profile by name", () => {
  const i = detectIntent("have a look at Ravi's profile", ctx);
  assert.equal(i[0].href, "/people/p-ravi");
});

test("what a role cannot see is never offered", () => {
  const hr = detectIntent("check the Finance page", { ...ctx, role: "HR" });
  assert.equal(hr.some((i) => i.href === "/finance"), false);
});

test("an assigned task leans a little more towards opening", () => {
  const plain = detectIntent("update profile photo", ctx)[0].confidence;
  const directed = detectIntent("update profile photo", { ...ctx, directed: true })[0].confidence;
  assert.ok(directed > plain);
});

test("open-able places leave out the chat itself", () => {
  const places = openablePlaces("Organisation owner/admin");
  assert.ok(places.some((p) => p.href === "/finance"));
  assert.equal(places.some((p) => p.href === "/chats"), false);
});
