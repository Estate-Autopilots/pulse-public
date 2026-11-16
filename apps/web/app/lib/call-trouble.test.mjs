import assert from "node:assert/strict";
import test from "node:test";
import { MEDIA_WAIT_MS, SLOW_MS, STUCK_MS, connectLine, connectStage, mediaProblem, mediaReason, withTimeout } from "./call-trouble.mjs";

test("the browser's microphone errors become plain reasons", () => {
  assert.equal(mediaReason("NotReadableError"), "media-busy");
  assert.equal(mediaReason("AbortError"), "media-busy");
  assert.equal(mediaReason("NotAllowedError"), "media-denied");
  assert.equal(mediaReason("SecurityError"), "media-denied");
  assert.equal(mediaReason("NotFoundError"), "media-missing");
  assert.equal(mediaReason("TimeoutError"), "media-timeout");
  assert.equal(mediaReason(undefined), "media-unsupported");
});

test("each reason says what happened and what to do, ending in Try again where a retry can help", () => {
  const busy = mediaProblem("media-busy");
  assert.equal(busy.title, "Your microphone is in use");
  assert.match(busy.text, /Another app is using it.*Try again/);
  assert.equal(mediaProblem("media-busy", true).title, "Your microphone and camera are in use");
  assert.match(mediaProblem("media-denied").text, /Allow the microphone/);
  assert.match(mediaProblem("media-timeout").text, /15 seconds/);
  assert.equal(mediaProblem("nonsense").reason, "media-unsupported");
  for (const r of ["media-busy", "media-denied", "media-missing", "media-timeout"]) assert.match(mediaProblem(r).text, /Try again/);
});

test("Connecting… becomes Still connecting… and then a message, never forever", () => {
  assert.equal(connectStage(null, 1000), null);
  assert.equal(connectStage(0, SLOW_MS - 1), "connecting");
  assert.equal(connectStage(0, SLOW_MS), "slow");
  assert.equal(connectStage(0, STUCK_MS), "stuck");
  assert.equal(connectLine("connecting"), "Connecting…");
  assert.equal(connectLine("slow"), "Still connecting…");
  assert.equal(connectLine("stuck"), "Not connecting");
  assert.ok(SLOW_MS < STUCK_MS && MEDIA_WAIT_MS <= 20000);
});

test("a microphone that never answers gives up, and a stream that arrives late is handed back to be stopped", async () => {
  let late = null, resolveLater;
  const slow = new Promise((r) => { resolveLater = r; });
  await assert.rejects(withTimeout(slow, 20, (v) => { late = v; }), (e) => e.name === "TimeoutError");
  resolveLater("stream"); await new Promise((r) => setTimeout(r, 5));
  assert.equal(late, "stream");
  assert.equal(await withTimeout(Promise.resolve(7), 50), 7);
  await assert.rejects(withTimeout(Promise.reject(Object.assign(new Error("busy"), { name: "NotReadableError" })), 50), (e) => e.name === "NotReadableError");
});
