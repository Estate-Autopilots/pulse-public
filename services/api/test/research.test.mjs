import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shrunkRate,
  shrunkCpl,
  growthDelta,
  versionKind,
  WORK_CREDITS,
} from "../dist/research-model.js";
test("thin outcome samples stay hidden; a sufficient small sample shrinks toward its reference group", () => {
  assert.equal(shrunkRate(3, 3, 0.1).value, null);
  const r = shrunkRate(20, 40, 0.1);
  assert.equal(r.value, 0.3);
  assert.ok(r.low < r.value && r.high > r.value);
  assert.equal(r.n, 40);
});
test("payment CPL requires exposure and lead count; approximate interval and prior are explicit", () => {
  assert.equal(shrunkCpl(4000, 200, 300), null);
  assert.equal(shrunkCpl(10000, 49, 300), null);
  const r = shrunkCpl(10000, 100, 300);
  assert.ok(r.value > 100 && r.value < 300);
  assert.ok(r.low < r.value && r.high > r.value);
  assert.equal(r.priorLeads, 50);
});
test("growth compares six complete months including zero observation months", () => {
  assert.equal(growthDelta([100, 100, 100, 50, 50, 50]), -50);
  assert.equal(growthDelta([0, 0, 0, 1, 1, 1]), null);
  assert.equal(growthDelta([1]), null);
});
test("variants do not become revisions without feedback, credits remain provisional type units", () => {
  assert.equal(versionKind(3, true), "variant");
  assert.equal(versionKind(48, true), "revision");
  assert.equal(versionKind(48, false), "refresh_candidate");
  assert.equal(WORK_CREDITS.model_video, 4);
});
