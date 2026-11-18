import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { poolCounts, SESSIONS_SQL, watchPool } from "../dist/pool-watch.js";

// LAND-CAPTAIN-10: production hung 43 h with every API query waiting for a client and nothing said which statements held
// them. The watch logs the pool's counts and the API's own busy sessions when requests keep waiting.
const fakePool = () => Object.assign(new EventEmitter(), { totalCount: 10, idleCount: 3, waitingCount: 0 });

test("pool counts come from node-pg's pool and are absent for anything else", () => {
  assert.deepEqual(poolCounts(fakePool()), { total: 10, idle: 3, waiting: 0 });
  assert.equal(poolCounts({ query: () => {} }), null);
  assert.equal(poolCounts(null), null);
});

test("requests waiting on two checks in a row log the counts and sessions, at most once a minute", async () => {
  const pool = fakePool(), logs = [];
  let clock = 0, snaps = 0;
  const w = watchPool(pool, { warn: (o, msg) => logs.push({ o, msg }) }, async () => { snaps++; return [{ pid: 7, state: "active", wait: "Lock:transactionid" }]; }, 60_000, () => clock);
  try {
    await w.tick();                                   // nobody waiting: nothing
    pool.waitingCount = 4; pool.idleCount = 0;
    await w.tick();                                   // first starved check: a burst, not yet a stall
    assert.equal(logs.length, 0);
    await w.tick();                                   // second in a row: logged with what the sessions do
    assert.equal(logs.length, 1);
    assert.equal(logs[0].msg, "API requests are waiting for a database client");
    assert.deepEqual(logs[0].o.pool, { total: 10, idle: 0, waiting: 4 });
    assert.deepEqual(logs[0].o.sessions, [{ pid: 7, state: "active", wait: "Lock:transactionid" }]);
    clock += 30_000; await w.tick();                  // still starved 30 s later: not repeated
    assert.equal(logs.length, 1);
    clock += 31_000; await w.tick();                  // a minute on: logged again
    assert.equal(logs.length, 2);
    assert.equal(snaps, 2);
    pool.waitingCount = 0; await w.tick();            // recovered: the count starts again
    pool.waitingCount = 1; clock += 61_000; await w.tick();
    assert.equal(logs.length, 2);
  } finally { w.stop(); }
});

test("a snapshot that fails still logs the counts", async () => {
  const pool = Object.assign(fakePool(), { waitingCount: 2, idleCount: 0 }), logs = [];
  const w = watchPool(pool, { warn: (o, msg) => logs.push({ o, msg }) }, async () => { throw new Error("timeout exceeded when trying to connect"); }, 60_000, () => 0);
  try {
    await w.tick(); await w.tick();
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0].o.pool, { total: 10, idle: 0, waiting: 2 });
    assert.equal(logs[0].o.sessions, null);
    assert.match(logs[0].o.reason, /timeout exceeded/);
  } finally { w.stop(); }
});

test("a borrowed client the server ends is logged, not an unhandled error that stops the API", () => {
  const pool = fakePool(), logs = [];
  const w = watchPool(pool, { warn: (o, msg) => logs.push({ o, msg }) }, async () => [], 60_000);
  try {
    const client = new EventEmitter();
    pool.emit("connect", client);
    client.emit("error", Object.assign(new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" }));
    assert.deepEqual(logs, [{ o: { code: "25P03" }, msg: "PostgreSQL ended an API connection" }]);
  } finally { w.stop(); }
});

test("the session snapshot reads only this login's busy sessions and no values", () => {
  assert.match(SESSIONS_SQL, /usename = current_user/);
  assert.match(SESSIONS_SQL, /state is distinct from 'idle'/);
  assert.match(SESSIONS_SQL, /pg_blocking_pids\(pid\)/);
  assert.match(SESSIONS_SQL, /left\(regexp_replace\(query/);
});
