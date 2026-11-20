import assert from "node:assert/strict";
import test from "node:test";
import { REOPEN_MAX_MS, keepStream, reopenWait } from "./live-stream.mjs";

// A fake browser: streams that can open, drop (the browser retries: CONNECTING) or be refused (CLOSED for good).
function fakeEnv() {
  const made = [], timers = new Map(); let next = 1;
  class FakeSource {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = { open: [], error: [] }; made.push(this); }
    addEventListener(kind, f) { (this.listeners[kind] ??= []).push(f); }
    fire(kind) { for (const f of this.listeners[kind] ?? []) f(); }
    opened() { this.readyState = 1; this.fire("open"); }
    dropped() { this.readyState = 0; this.fire("error"); }
    refused() { this.readyState = 2; this.fire("error"); }
    close() { this.readyState = 2; this.closedByPage = true; }
  }
  const env = {
    EventSource: FakeSource,
    setTimeout: (f, ms) => { const id = next++; timers.set(id, { f, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  const run = () => { const [[id, t]] = [...timers]; timers.delete(id); t.f(); return t.ms; };
  return { env, made, timers, run };
}

test("waits grow from 1 s and stop at the cap", () => {
  assert.deepEqual([0, 1000, 2000, 8000, 15000].map(reopenWait), [1000, 2000, 4000, 15000, REOPEN_MAX_MS]);
});

test("a stream refused for good is opened again, with the page's listeners, and the wait resets once open (BC-178)", () => {
  const { env, made, timers, run } = fakeEnv();
  const setups = [];
  const kept = keepStream("/api/v0/chats/events", (es) => setups.push(es), env);
  assert.equal(made.length, 1); assert.equal(kept.current, made[0]); assert.deepEqual(setups, made);
  // A drop the browser retries by itself: nothing to do.
  made[0].opened(); made[0].dropped();
  assert.equal(timers.size, 0);
  // Refused (the edge's 502 during a release): opened again after 1 s, then 2 s.
  made[0].refused();
  assert.equal(run(), 1000); assert.equal(made.length, 2); assert.equal(kept.current, made[1]); assert.equal(setups.length, 2);
  made[1].refused();
  assert.equal(run(), 2000); assert.equal(made.length, 3);
  // It opens: the next refusal waits 1 s again.
  made[2].opened(); made[2].refused();
  assert.equal(run(), 1000); assert.equal(made.length, 4);
  // An old stream's late error changes nothing.
  made[1].refused(); assert.equal(timers.size, 0);
});

test("wake opens a closed stream at once; close ends it for good", () => {
  const { env, made, timers } = fakeEnv();
  const kept = keepStream("/api/v0/chats/events", () => {}, env);
  kept.wake(); assert.equal(made.length, 1);           // not closed: nothing
  made[0].refused(); assert.equal(timers.size, 1);
  kept.wake(); assert.equal(timers.size, 0); assert.equal(made.length, 2);
  made[1].refused(); kept.close();
  assert.equal(timers.size, 0); assert.equal(made[1].closedByPage, true);
  kept.wake(); assert.equal(made.length, 2);
});
