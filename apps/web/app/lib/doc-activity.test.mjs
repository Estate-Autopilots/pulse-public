// DOCS-ACTIVITY: the words for a doc's and folder's activity (lib/doc-activity.mjs) and the list's newest-activity sort.
import assert from "node:assert/strict";
import test from "node:test";
import { activityLine, agentName, folderLine, madeByAi, readWords, trailTone, trailWords, viaWords, whoWord } from "./doc-activity.mjs";
import { sortRows } from "./docs-drive.mjs";

const asha = { id: "a", name: "Asha Sample" }, ravi = { id: "r", name: "Ravi Sample" }, helper = { id: "h", name: "Ops Helper (AI)", agent: true };
const at = "2026-11-17T10:00:00Z";

test("who did it: you, a first name, an AI employee by its whole name", () => {
  assert.equal(whoWord(asha, "a"), "You");
  assert.equal(whoWord(ravi, "a"), "Ravi");
  assert.equal(whoWord(null, "a"), "Someone");
  assert.equal(activityLine({ at, kind: "commented", by: ravi }, "a"), "Ravi commented");
  assert.equal(activityLine({ at, kind: "edited", by: asha }, "a"), "You edited");
  assert.equal(activityLine({ at, kind: "created", by: helper }, "a"), "Ops Helper (AI) made it");
  assert.equal(activityLine({ at, kind: "created", by: asha, via: "script", viaLabel: "weekly report tool" }, "a"), "You made it with automation");
  assert.equal(activityLine({ at, kind: "commented", by: asha, via: "script" }, "a"), "You commented", "only making and editing say how");
  assert.equal(activityLine(null, "a"), "");
  // An AI employee whose name does not say so is still named as AI (small avatars carry no AI badge).
  assert.equal(agentName({ id: "x", name: "Artha", agent: true }), "Artha (AI)");
  assert.equal(agentName(helper), "Ops Helper (AI)");
  assert.equal(activityLine({ at, kind: "edited", by: { id: "x", name: "Artha", agent: true } }, "a"), "Artha (AI) edited");
});

test("how it was made: AI, an API key, an automation, or a person (nothing)", () => {
  assert.equal(viaWords("ai", null), "AI");
  assert.equal(viaWords("api", "Claude"), "via Claude");
  assert.equal(viaWords("api", null), "via an API key");
  assert.equal(viaWords("script", "weekly report tool"), "by automation (weekly report tool)");
  assert.equal(viaWords(null, null), null);
  assert.equal(madeByAi({ madeVia: "script" }), true);
  assert.equal(madeByAi({ madeVia: "ai" }), true);
  assert.equal(madeByAi({ madeVia: "api" }), false, "a person's own key is the person");
  assert.equal(madeByAi({ madeVia: null }), false);
});

test("a folder says who did what to which doc inside it", () => {
  assert.equal(folderLine({ at, kind: "edited", by: ravi, doc: { id: "d", title: "Launch brief" } }, "a"), "Ravi edited “Launch brief”");
  assert.equal(folderLine({ at, kind: "commented", by: asha, doc: { id: "d", title: "Price list" } }, "a"), "You commented on “Price list”");
  assert.equal(folderLine({ at, kind: "created", by: asha, doc: null }, "a"), "You made this folder");
  assert.equal(folderLine({ at, kind: "added", by: ravi, doc: { id: "f", title: "site.pdf" } }, "a"), "Ravi added “site.pdf”");
});

test("the trail in plain words", () => {
  assert.equal(trailWords({ at, kind: "moved", by: asha, from: "My Docs", to: "HR and policies" }, "r"), "Asha moved it from My Docs to HR and policies");
  assert.equal(trailWords({ at, kind: "moved", by: asha, from: "a private folder", to: "Clients" }, "r"), "Asha moved it from a private folder to Clients");
  assert.equal(trailWords({ at, kind: "shared", by: asha, person: "Ravi Sample", role: "can comment" }, "r"), "Asha shared it with Ravi Sample (can comment)");
  assert.equal(trailWords({ at, kind: "edited", by: asha, times: 3 }, "r"), "Asha edited it (3 times)");
  assert.equal(trailWords({ at, kind: "viewed", by: ravi, readPct: 80 }, "a"), "Ravi read most of it");
  assert.deepEqual([95, 80, 45, 10, 0].map(readWords), ["read all of it", "read most of it", "read about half", "read a little of it", "opened it"]);
  assert.equal(trailWords({ at, kind: "access", by: asha, from: "private", to: "company" }, "r"), "Asha opened it to everyone in the company");
  assert.equal(trailWords({ at, kind: "commented", by: ravi, words: "Can we show the yearly price?" }, "a"), "Ravi commented: “Can we show the yearly price?”");
  assert.equal(trailWords({ at, kind: "edited", by: ravi, doc: { id: "d", title: "Launch brief" } }, "a", { inFolder: true }), "Ravi edited “Launch brief”");
  assert.equal(trailWords({ at, kind: "renamed", by: asha, from: "Offers", to: "Offers and pricing" }, "r", { inFolder: true }), "Asha renamed the folder from “Offers” to “Offers and pricing”");
  assert.equal(trailTone("shared"), "share");
  assert.equal(trailTone("edited"), "edit");
});

test("the list sorts by newest activity, folders first, never-active ones last", () => {
  const rows = [
    { key: "d1", kind: "doc", name: "Old", activityAt: "2026-11-01T10:00:00Z" },
    { key: "d2", kind: "doc", name: "New", activityAt: "2026-11-17T09:00:00.123+00:00" },
    { key: "d3", kind: "doc", name: "Never", activityAt: null },
    { key: "f1", kind: "folder", name: "Quiet", activityAt: "2026-10-01T10:00:00Z" },
    { key: "f2", kind: "folder", name: "Busy", activityAt: "2026-11-17T08:00:00Z" },
  ];
  assert.deepEqual(sortRows(rows, "activity", "desc").map((r) => r.key), ["f2", "f1", "d2", "d1", "d3"]);
  assert.deepEqual(sortRows(rows, "activity", "asc").map((r) => r.key), ["f1", "f2", "d1", "d2", "d3"]);
});
