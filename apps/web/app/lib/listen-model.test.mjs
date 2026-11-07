import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, lastSeq, mergeSegments, pickMime, PURPOSES, toBase64 } from "./listen-model.mjs";

test("the recording format is the first one the browser makes", () => {
  assert.equal(pickMime((m) => m === "audio/mp4"), "audio/mp4");
  assert.equal(pickMime(() => true), "audio/webm;codecs=opus");
  assert.equal(pickMime(() => { throw new Error("old browser"); }), "");
});

test("the transcript merges new parts in order without repeats", () => {
  const a = [{ seq: 1, part: 0, text: "second" }, { seq: 0, part: 0, text: "first" }];
  const merged = mergeSegments(mergeSegments([], a), [{ seq: 1, part: 0, text: "second" }, { seq: 1, part: 1, text: "third" }, null]);
  assert.deepEqual(merged.map((s) => s.text), ["first", "second", "third"]);
  assert.equal(lastSeq(merged), 1);
  assert.equal(lastSeq([]), -1);
});

test("clock and base64", () => {
  assert.equal(clock(75000), "1:15");
  assert.equal(clock(3725000), "1:02:05");
  assert.equal(clock(-5), "0:00");
  assert.equal(toBase64(new Uint8Array([104, 105])), "aGk=");
  const big = new Uint8Array(100000).fill(65);
  assert.equal(Buffer.from(toBase64(big), "base64").length, 100000);
});

test("every purpose the database accepts has words", () => {
  assert.deepEqual(PURPOSES.map((p) => p.value), ["general", "quotation", "requirements", "meeting"]);
  assert.ok(PURPOSES.every((p) => p.label && p.hint));
});
