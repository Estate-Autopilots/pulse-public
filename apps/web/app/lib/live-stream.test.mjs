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

// PM-BUILD-4 (USER-INSIGHT L3): one signed-out tab asked two streams ~4,450 times in five hours (401 each).
test("a stream refused twice asks once why; signed out (401/403) it stays closed until the page is shown again", async () => {
  for (const status of [401, 403]) {
    const { env, made, timers, run } = fakeEnv();
    const asked = [];
    env.fetch = async (url, init) => { asked.push(url); assert.equal(init.cache, "no-store"); return { status }; };
    const kept = keepStream("/api/v0/screen/events", () => {}, env);
    made[0].refused();                                    // first refusal: no question, opened again after 1 s
    assert.equal(asked.length, 0); assert.equal(run(), 1000); assert.equal(made.length, 2);
    made[1].refused();                                    // second in a row: one question, then nothing more
    await new Promise((ok) => setImmediate(ok));
    assert.deepEqual(asked, ["/api/v0/screen/events"]);
    assert.equal([...timers.values()].filter((t) => t.ms !== 8000).length, 0, `${status}: no reopen is planned`);
    assert.equal(made.length, 2);
    kept.wake();                                          // the page is shown again: one more try
    assert.equal(made.length, 3);
    kept.close();
  }
});

test("a restarting server (502, or no answer) is still opened again with the growing wait", async () => {
  for (const answer of [{ status: 502 }, null]) {
    const { env, made, timers } = fakeEnv();
    env.fetch = async () => { if (!answer) throw new Error("offline"); return answer; };
    keepStream("/api/v0/chats/events", () => {}, env);
    made[0].refused();
    const first = [...timers.values()].find((t) => t.ms === 1000); assert.ok(first);
    timers.clear(); first.f();
    made[1].refused();
    await new Promise((ok) => setImmediate(ok));
    assert.ok([...timers.values()].some((t) => t.ms === 2000), "opened again after 2 s");
  }
});
