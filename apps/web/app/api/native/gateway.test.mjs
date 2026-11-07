import { test } from "node:test";
import assert from "node:assert/strict";
import { admit, createLimiter, LIMITS } from "./gateway.mjs";

const T = "Bearer " + "a".repeat(43);
const S = "s".repeat(43);
const go = (over = {}) => admit({ path: "companion", authorization: T, session: null, address: "1.2.3.4", limiter: createLimiter(), ...over });

test("token-only: device routes need a bearer credential; Access never stands in", () => {
  assert.equal(go({ authorization: null }).status, 401);
  assert.equal(go({ authorization: null, session: S }).status, 401, "a browser session cannot use device routes");
  assert.equal(go({ authorization: "Bearer short" }).status, 401);
  assert.equal(go({ authorization: "Basic abc" }).status, 401);
  const ok = go();
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.forward, { authorization: T }, "only the bearer credential is forwarded");
});

test("bootstrap: sign-in, pairing and rotation work without a device credential", () => {
  for (const path of ["auth/sign-in", "auth/two-step", "native/pair/start", "native/pair/poll", "native/refresh", "native/about"]) assert.equal(go({ path, authorization: null }).ok, true, path);
  const enrol = go({ path: "native/exchange", authorization: null, session: S });
  assert.deepEqual(enrol.forward, { "x-pulse-session": S }, "a password session can only enrol a device");
  assert.deepEqual(go({ path: "me", authorization: null, session: "bad session" }).forward, {});
});

test("scope: admin and unknown routes are outside the device scope", () => {
  for (const path of ["settings", "hr/presence", "native/pair/decide", "people/abc/salary", "admin/x", "admin/devices/pairings", "attendance", "../api/v0/me"]) assert.equal(go({ path }).status, 403, path);
  for (const path of ["companion", "companion/presence", "attendance/check-in", "attendance/break", "attendance/check-out", "me", "devices", "hr/self"]) assert.equal(go({ path }).ok, true, path);
});

test("kill switch", () => {
  assert.equal(go({ enabled: false }).status, 503);
});

test("rate limits: per address for sign-in and pairing, per credential for devices", () => {
  let t = 0;
  const limiter = createLimiter({ now: () => t });
  const call = (over) => admit({ path: "auth/sign-in", authorization: null, session: null, address: "9.9.9.9", limiter, ...over });
  for (let i = 0; i < LIMITS.signIn; i++) assert.equal(call().ok, true);
  const refused = call();
  assert.equal(refused.status, 429);
  assert.equal(refused.headers["retry-after"], "60");
  assert.equal(call({ address: "8.8.8.8" }).ok, true, "another address is not affected");
  t = 61000;
  assert.equal(call().ok, true, "the window resets");
  const pair = (over) => admit({ path: "native/pair/start", authorization: null, session: null, address: "7.7.7.7", limiter, ...over });
  for (let i = 0; i < LIMITS.pairStart; i++) assert.equal(pair().ok, true);
  assert.equal(pair().status, 429);
  const dev = (authorization) => admit({ path: "companion", authorization, session: null, address: "6.6.6.6", limiter });
  const a = "Bearer " + "b".repeat(43), b = "Bearer " + "c".repeat(43);
  for (let i = 0; i < LIMITS.device; i++) assert.equal(dev(a).ok, true);
  assert.equal(dev(a).status, 429);
  assert.equal(dev(b).ok, true, "another device on the same network is not affected");
});

test("the limiter table stays bounded", () => {
  const limiter = createLimiter({ max: 100 });
  for (let i = 0; i < 1000; i++) limiter.hit(`k${i}`, 5);
  assert.ok(limiter.size() <= 100);
});


test('Companion inbox, feed, read and preferences require a device token without admitting administrative notification routes',()=>{
 for(const path of ['companion/inbox','companion/updates','companion/read','companion/ack','companion/snooze','companion/notification-settings']){
  assert.equal(admit({path,address:'test',limiter:createLimiter()}).status,401);
  assert.equal(admit({path,authorization:'Bearer '+'a'.repeat(43),address:'test',limiter:createLimiter()}).ok,true);
 }
 for(const path of ['notifications/connections','notifications/connect','notifications/payroll-access','notifications/payroll-processed','companion/web-push'])assert.equal(admit({path,authorization:'Bearer '+'a'.repeat(43),address:'test',limiter:createLimiter()}).status,403);
});
