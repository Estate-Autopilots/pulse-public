// USER-INSIGHT (23 Nov 2026): the calls engine's background reads back off. Production telemetry 17-23 Nov: 1,295
// failed reads of GET /api/v0/calls/events/next from 26 people; 1,132 of them (87%) while the app was hidden, median
// 21 ms (no network: a laptop asleep, a phone offline), a run of up to 37 failures in a row, one a minute for hours.
// The reads came every 5 s while the stream was down, whatever happened to the last one, online or not.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pollWait, POLL_SETUP_MS } from "./call-poll.mjs";

const at = (o) => pollWait({ setup: false, down: true, hidden: false, offline: false, fails: 0, ...o });

test("a call being set up still reads every second, failures or not (the offer and answer must get through)", () => {
  assert.equal(POLL_SETUP_MS, 1000);
  assert.equal(at({ setup: true }), 1000);
  assert.equal(at({ setup: true, fails: 9 }), 1000);
  assert.equal(at({ setup: true, hidden: true }), 1000);
});

test("a live stream needs no reads; a device with no network makes none (going online reads at once)", () => {
  assert.equal(at({ down: false }), null);
  assert.equal(at({ offline: true }), null);
  assert.equal(at({ offline: true, setup: true }), null);
});

test("on screen with the stream down: every 5 s, doubling after each failure up to 60 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((fails) => at({ fails })), [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
});

test("hidden: every 15 s, doubling after each failure up to 2 min", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((fails) => at({ hidden: true, fails })), [15000, 30000, 60000, 120000, 120000, 120000]);
});

test("Willow Lane's worst hour: a hidden tab with no network for 37 minutes now tries 0 times (was 37), and 21 times (was 37: the browser slows a hidden tab to one a minute) with a network that fails", () => {
  let fails = 0, tries = 0;
  for (let t = 0, next = 0; t < 37 * 60000; t += 1000) {
    const wait = pollWait({ setup: false, down: true, hidden: true, offline: true, fails });
    if (wait !== null && t >= next) { tries++; fails++; next = t + wait; }
  }
  assert.equal(tries, 0);
  for (let t = 0, next = 0; t < 37 * 60000; t += 1000) {
    const wait = pollWait({ setup: false, down: true, hidden: true, offline: false, fails });
    if (wait !== null && t >= next) { tries++; fails++; next = t + wait; }
  }
  assert.equal(tries, 21);
});

const src = readFileSync(new URL("../calls/engine.ts", import.meta.url), "utf8");
test("the engine uses the rule: counts failures, clears them on success, going online or coming back in front", () => {
  assert.match(src, /import \{ pollWait \} from "\.\.\/lib\/call-poll\.mjs";/);
  assert.match(src, /const wait = pollWait\(\{ setup, down, hidden: document\.visibilityState === "hidden", offline: navigator\.onLine === false, fails: this\.pollFails \}\);/);
  assert.match(src, /if \(wait !== null && Date\.now\(\) - this\.polled >= wait\)/);
  const poll = src.slice(src.indexOf("private async pollEvents()"), src.indexOf("disconnect() {"));
  assert.match(poll, /if \(!r\.ok\) \{ this\.pollFails\+\+; return; \}/, "a server error counts");
  assert.match(poll, /this\.pollFails = 0;/, "a good read clears the count");
  assert.match(poll, /catch \{ this\.pollFails\+\+; \}/, "no answer counts");
  assert.match(src, /const changed = \(\) => \{ (?:this\.out = false; )?this\.pollFails = 0; this\.polled = 0;/, "online again: read at once");
  assert.match(src, /if \(document\.visibilityState !== "visible"\) return; this\.pollFails = 0;/, "back in front: read at once");
  assert.match(src, /if \(this\.es && navigator\.onLine !== false && Date\.now\(\) - this\.heard > 25000\) this\.open\(\);/, "no stream reopen while offline");
});
