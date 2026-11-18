// SWITCH-SMOOTH (2165): the API's front door asks once whether this browser proved the person (device-trust.ts, app.ts),
// before the session or the tab picks a company; only with a device key the web proxy says the browser really kept.
// Synthetic ids and tokens only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { deviceOf, deviceSeen } from "../dist/device-trust.js";

const INSTALL = "00000000-0000-4000-8000-0000000000a1", A = "11111111-1111-4111-8111-111111111111";
const T = "q".repeat(43), ID = "d".repeat(64);
const hash = (t) => createHash("sha256").update(t).digest("hex");
const device = hash("pulse-device:" + ID);

test("the browser counts only when its device key was kept (or a sign-in answer keeps it now)", () => {
  assert.equal(deviceOf({ "x-pulse-device-id": ID, "x-pulse-device-known": "1" }), device);
  assert.equal(deviceOf({ "x-pulse-device-id": ID }), null, "a key made up for one request never counts");
  assert.equal(deviceOf({ "x-pulse-device-id": ID }, true), device, "a sign-in answer sets the cookie itself");
  assert.equal(deviceOf({ "x-pulse-device-id": "not-a-hash", "x-pulse-device-known": "1" }), null);
  assert.equal(deviceOf({}), null);
});

test("a burst of requests asks the database once, and a failure leaves the session as it was", async () => {
  const asked = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const db = { query: async (sql, params) => { asked.push(params); await gate; return { rows: [{ s: "lifted" }] }; } };
  const burst = [deviceSeen(db, "s1", device), deviceSeen(db, "s1", device), deviceSeen(db, "s1", device)];
  release();
  assert.deepEqual(await Promise.all(burst), ["lifted", "lifted", "lifted"], "every request of the burst waits for the lift");
  assert.equal(asked.length, 1);
  assert.equal(await deviceSeen(db, "s1", device), null, "checked a moment ago: nothing to ask");
  assert.equal(asked.length, 1);
  const broken = { query: async () => { throw new Error("down"); } };
  assert.equal(await deviceSeen(broken, "s2", device), null);
});

test("the front door asks before it picks the company, and only for a kept device key", async () => {
  const run = async (headers) => {
    const front = [];
    const database = { query: async (sql, params) => {
      front.push({ sql, params });
      if (sql.includes("pulse.acct_device_seen")) return { rows: [{ s: "lifted" }] };
      if (sql.includes("pulse.session_org")) return { rows: [{ org_id: A, status: "active", rehearsal: false }] };
      return { rows: [{ org_id: INSTALL }] };
    } };
    const client = { async query() { return { rows: [] }; }, release() {} };
    const app = createApp(database, { connect: async () => client });
    try { await app.inject({ method: "GET", url: "/api/v0/me", headers }); } finally { await app.close(); }
    return front;
  };
  const kept = await run({ "x-pulse-session": T, "x-pulse-device-id": "e".repeat(64), "x-pulse-device-known": "1" });
  const seen = kept.findIndex((c) => c.sql.includes("acct_device_seen"));
  assert.ok(seen >= 0, "asked");
  assert.deepEqual(kept[seen].params, [hash(T), hash("pulse-device:" + "e".repeat(64))]);
  assert.ok(seen < kept.findIndex((c) => c.sql.includes("session_org")), "before the session picks its company");
  const unknown = await run({ "x-pulse-session": T, "x-pulse-device-id": "f".repeat(64) });
  assert.equal(unknown.filter((c) => c.sql.includes("acct_device_seen")).length, 0);
  const signedOut = await run({ "x-pulse-device-id": "f".repeat(64), "x-pulse-device-known": "1" });
  assert.equal(signedOut.filter((c) => c.sql.includes("acct_device_seen")).length, 0);
});
