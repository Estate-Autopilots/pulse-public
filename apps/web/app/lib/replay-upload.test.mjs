import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { gunzipSync } from "node:zlib";
import ts from "typescript";
import * as privacy from "./friction.mjs";
import * as windows from "./replay-window.mjs";

// PM-BUILD-4 (23 Nov 2026): these took 0.05-0.4 s alone but 5-8 s inside the land gate's full web suite on a busy
// machine, and the 5 s limit failed three lanes' lands. replay.ts is now transpiled once for all of them, and the limit
// (there to catch a recorder that never answers) is 20 s. Every assertion is unchanged.
const TIMEOUT = 20_000;
// USER-INSIGHT (24 Nov 2026): the transpile now runs once when this file loads, outside every test's time limit. It was
// most of the first test's time, and on the land gate at load 10 that first test still passed 20 s (train run
// 20261124T014909Z-1: 1272 pass, this one cancelled). Assertions and limits unchanged.
const replayCode = ts.transpileModule(readFileSync(new URL("./replay.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const replaySource = () => replayCode;

// Exercise the real recorder, timers, compression and upload responses without a browser.
function recorder() {
  let emit, tick, status = 200, answer = { accepted: true }, done;
  const requests = [], storage = new Map();
  let snapshots = 0;
  const record = options => { emit = options.emit; return () => {}; };
  record.takeFullSnapshot = () => {
    snapshots++;
    emit({ type: 4, timestamp: Date.now(), data: { width: 1280, height: 720 } }, true);
    emit({ type: 2, timestamp: Date.now(), data: { node: { type: 0, childNodes: [] } } });
  };
  const fixtureModule = { exports: {} };
  const code = replaySource();
  runInNewContext(code, {
    module: fixtureModule, exports: fixtureModule.exports, Blob, Response, CompressionStream, btoa,
    window: {
      location: { href: "https://web.test/tasks" },
      sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
      setTimeout: fn => fn(), setInterval: fn => { tick = fn; }, addEventListener: () => {},
    },
    document: { visibilityState: "visible", addEventListener: () => {} },
    fetch: async (_url, options) => {
      requests.push(options);
      // The recorder processes this response before the test's next turn.
      setImmediate(() => done?.());
      return Response.json(answer, { status });
    },
    require: name => {
      if (name === "rrweb") return { record };
      if (name === "./friction.mjs") return privacy;
      if (name === "./replay-window.mjs") return windows;
      if (name === "./telemetry.mjs") return { telemetrySession: () => "sessionSYNTH01", screenOf: () => "/tasks" };
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  return {
    async start() { fixtureModule.exports.startReplay(); await new Promise(setImmediate); assert.ok(emit); },
    emit: event => emit(event), requests, get snapshots() { return snapshots; },
    async flush(nextStatus = 200, nextAnswer = { accepted: true }) {
      status = nextStatus; answer = nextAnswer;
      const sent = new Promise(resolve => { done = resolve; });
      tick();
      await sent;
    },
    tick: () => tick(),
  };
}

const event = () => ({ type: 3, timestamp: Date.now(), data: { source: 5, id: 1, text: "synthetic typed value" } });

test("successful uploads reset refusals so isolated rejected chunks never end the replay", { timeout: TIMEOUT }, async () => {
  const r = recorder();
  await r.start();
  for (let i = 0; i < 6; i++) {
    r.emit(event());
    await r.flush(i % 2 ? 413 : 400);
    assert.equal(r.snapshots, i + 1, "each isolated rejection requests a playable snapshot");
    await r.flush();
    const stored = r.requests.at(-1);
    const events = JSON.parse(gunzipSync(Buffer.from(JSON.parse(stored.body).gz, "base64")));
    assert.ok(events.some(e => e.type === 2), "recording continues with a full snapshot");
  }
  r.emit(event());
  await r.flush();
  assert.equal(r.requests.length, 13, "later events still upload after more than five isolated refusals");
  const events = JSON.parse(gunzipSync(Buffer.from(JSON.parse(r.requests.at(-1).body).gz, "base64")));
  assert.match(events[0].data.text, /^\*+$/, "typed text is masked before upload");
});

test("consecutive refused chunks still stop a persistently invalid recorder", { timeout: TIMEOUT }, async () => {
  const r = recorder();
  await r.start();
  for (let i = 0; i < 5; i++) { r.emit(event()); await r.flush(400); }
  r.emit(event());
  r.tick();
  await new Promise(setImmediate);
  assert.equal(r.requests.length, 5);
  assert.equal(r.snapshots, 4);
});

for (const status of [401, 403, 404]) test(`replay uploads stop after HTTP ${status}`, { timeout: TIMEOUT }, async () => {
  const r = recorder();
  await r.start();
  r.emit(event());
  await r.flush(status);
  r.emit(event());
  r.tick();
  await new Promise(setImmediate);
  assert.equal(r.requests.length, 1);
});
