// PR-PIPELINE: the pipeline screens' helpers (lib/pr-pipeline.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { contrast, contrastWords, nextMoves, num, proofHref, stepReady, trend } from "./pr-pipeline.mjs";

test("contrast follows WCAG: black on white is 21:1, and 4.5:1 is the line for body text", () => {
  assert.equal(Math.round(contrast("#000000", "#FFFFFF")), 21);
  assert.equal(contrast("#777777", "#777777"), 1);
  assert.equal(contrast("nope", "#FFFFFF"), null);
  assert.equal(contrastWords(contrast("#0E2A2F", "#EEF2F1")).ok, true);
  assert.equal(contrastWords(contrast("#999999", "#FFFFFF")).ok, false);
});

test("the trend compares with the score before", () => {
  assert.deepEqual(trend(62, 50), { dir: "up", text: "Up 12" });
  assert.deepEqual(trend(40, 50), { dir: "down", text: "Down 10" });
  assert.equal(trend(40, 40).dir, "level");
  assert.equal(trend(40, null).dir, "new");
});

test("a draft moves draft -> review -> approved -> posted, with the client's OK first when it names a client", () => {
  assert.deepEqual(nextMoves({ approval: "draft" }), ["review"]);
  assert.deepEqual(nextMoves({ approval: "review" }), ["approved", "draft"]);
  assert.deepEqual(nextMoves({ approval: "approved", needsClientOk: false }), ["posted", "draft"]);
  assert.deepEqual(nextMoves({ approval: "approved", needsClientOk: true, clientOkAt: null }), ["client_ok", "draft"]);
  assert.deepEqual(nextMoves({ approval: "approved", needsClientOk: true, clientOkAt: "2026-11-06" }), ["posted", "draft"]);
  assert.deepEqual(nextMoves({ approval: "posted" }), []);
});

test("numbers, proof links and the wizard's steps", () => {
  assert.equal(num(1234567, "INR"), "12,34,567");
  assert.equal(num(1234567, "USD"), "1,234,567");
  assert.equal(proofHref("/tasks/x"), "/tasks/x");
  assert.equal(proofHref("https://example.com/c/1"), "https://example.com/c/1");
  assert.equal(proofHref("git:exmp0001"), null);
  assert.equal(proofHref("javascript:alert(1)"), null);
  assert.equal(stepReady(0, { name: "Example", kind: "company", bg: "#0E2A2F", fg: "#EEF2F1" }), true);
  assert.equal(stepReady(0, { name: "Example", kind: "client", bg: "#0E2A2F", fg: "#EEF2F1" }), false, "a client brand names its client");
  assert.equal(stepReady(0, { name: "Example", kind: "company", bg: "#888888", fg: "#999999" }), false, "faint colours do not pass");
  assert.equal(stepReady(1, { audiences: [{ name: "" }] }), false);
  assert.equal(stepReady(2, { postsPerWeek: 3 }), true);
});
