// DITASU-2 (decision 3, 17 Nov 2026): replays only around struggle moments (plus 10% of sessions in full). The device's
// trigger reads the same signals as the leadership view's detector (services/api/src/struggle-model.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isStruggle, SEGMENTS, WINDOW_MS, windowUntil } from "./replay-window.mjs";

test("struggle moments start a replay window; ordinary use does not", () => {
  for (const k of ["ui.rage", "ui.dead", "ui.stuck", "ui.early", "ui.form.abandon", "error.js", "error.promise", "error.boundary"]) assert.equal(isStruggle(k, {}), true, k);
  // Ditasu's refused circle: a click whose call was refused (DITASU-FIX's fail/failed fields).
  assert.equal(isStruggle("ui.click", { d: 240, x: { fail: 400, failed: "tasks/:id/move" } }), true);
  assert.equal(isStruggle("ui.click", { d: 3200, x: {} }), true, "a wait of 3 s or more");
  assert.equal(isStruggle("ui.click", { d: 180, x: { api: 1 } }), false, "an answered click");
  assert.equal(isStruggle("perf.longtask", { d: 1400 }), true, "a freeze of a second or more");
  assert.equal(isStruggle("perf.longtask", { d: 300 }), false);
  for (const k of ["nav.route", "ui.scroll", "error.resource", "error.stream", "api", "ui.key"]) assert.equal(isStruggle(k, { d: 9000 }), false, k);
});

test("the window is a minute after the last moment; the buffer holds the minute before", () => {
  assert.equal(WINDOW_MS, 60_000);
  assert.equal(SEGMENTS, 3, "three 30-s segments: 60-90 s before the moment");
  assert.equal(windowUntil(1_000_000), 1_060_000);
  assert.equal(windowUntil(1_030_000, 1_060_000), 1_090_000, "a later moment extends it");
  assert.equal(windowUntil(1_000_000, 1_090_000), 1_090_000);
});

test("the recorder sends sampled sessions in full and the others only in struggle windows", () => {
  const src = readFileSync(new URL("./replay.ts", import.meta.url), "utf8");
  assert.match(src, /addEventListener\("pulse:struggle"/);
  assert.match(src, /r\.sampled \? "sample" : "struggle"/);
  assert.match(src, /r\.segments\.length > SEGMENTS/);
  const tel = readFileSync(new URL("./telemetry.mjs", import.meta.url), "utf8");
  assert.match(tel, /if \(isStruggle\(k, f\)\) w\.dispatchEvent\(new CustomEvent\("pulse:struggle"/);
  // The API's defaults: 10% of sessions, 7 days.
  const model = readFileSync(new URL("../../../../services/api/src/replay-model.ts", import.meta.url), "utf8");
  assert.match(model, /replaySample: 0\.1/);
  assert.match(model, /replayDays: 7, replayBudgetMb: 1024/);
});
