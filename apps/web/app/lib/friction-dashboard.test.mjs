import test from "node:test";
import assert from "node:assert/strict";
import { duration, fit, lastFrame, mergeEvents, seekOffset, share } from "./friction-dashboard.mjs";

// BUGKIT-TELEMETRY: the friction dashboard's and replay player's pure helpers. Synthetic events only.
test("durations read plainly", () => {
  assert.equal(duration(320), "320 ms");
  assert.equal(duration(1400), "1.4 s");
  assert.equal(duration(120_000), "2 min");
  assert.equal(duration(5_400_000), "1.5 h");
  assert.equal(duration(null), "–");
  assert.equal(share(1, 4), 25);
  assert.equal(share(1, 0), 0);
});

test("chunks merge in time order without repeats", () => {
  const a = [{ type: 4, timestamp: 10, data: {} }, { type: 2, timestamp: 11, data: { node: {} } }];
  const b = [{ type: 3, timestamp: 12, data: { source: 1 } }, { type: 2, timestamp: 11, data: { node: {} } }, { nope: 1 }];
  assert.deepEqual(mergeEvents([b, a]).map((e) => e.timestamp), [10, 11, 12]);
});

test("a still frame starts at the last full snapshot's meta event", () => {
  const events = [{ type: 4, timestamp: 0 }, { type: 2, timestamp: 5 }, { type: 3, timestamp: 9 }, { type: 4, timestamp: 100 }, { type: 2, timestamp: 102 }, { type: 3, timestamp: 150 }];
  const f = lastFrame(events);
  assert.equal(f.events[0].timestamp, 100);
  assert.equal(f.offset, 52);
  assert.equal(lastFrame([{ type: 3, timestamp: 1 }]), null);
});

test("?t= seeks a little before the moment, inside the replay", () => {
  assert.equal(seekOffset(10_000, 1_000, 20_000), 6_000);
  assert.equal(seekOffset(500, 1_000, 20_000), 0);
  assert.equal(seekOffset(99_000, 1_000, 20_000), 19_000);
  assert.equal(seekOffset("x", 1_000, 20_000), 0);
  assert.equal(fit(1440, 900, 720), 0.5);
  assert.equal(fit(390, 800, 720), 1);
});
