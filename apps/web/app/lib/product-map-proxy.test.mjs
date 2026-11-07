// PRODUCT-MAP: the proxy hands a Product map token to /api/v0/product-map/feed/* alone: no cookie, session or Access
// identity goes with it, a token with a person's session is refused, and other paths never take the token's route.
import assert from "node:assert/strict";
import test from "node:test";
import { createApiProxy, v0ProxyOptions } from "../api/proxy.mjs";

const context = (path) => ({ params: Promise.resolve({ path }) });
const TOKEN = "pmap_0123abcd_" + "A".repeat(43);
const capture = () => { const seen = []; return { seen, fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }); } }; };
const proxyWith = (fetchImpl) => createApiProxy({ ...v0ProxyOptions, fetchImpl, hostLookup: async () => ({ signIn: "access" }) });

test("a token reads the feed with nothing else forwarded", async () => {
  const { seen, fetchImpl } = capture();
  const r = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/product-map/feed/plan?format=md", { headers: { authorization: `Bearer ${TOKEN}`, "cf-access-jwt-assertion": "synthetic" } }), context(["product-map", "feed", "plan"]));
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/api\/v0\/product-map\/feed\/plan\?format=md$/);
  const sent = seen[0].init.headers;
  assert.equal(sent.authorization, `Bearer ${TOKEN}`);
  assert.equal(sent["cf-access-authenticated-user-email"], undefined);
  assert.equal(sent["cf-access-jwt-assertion"], undefined);
});

test("a token with a person's session or cookie is refused before the API", async () => {
  const { seen, fetchImpl } = capture();
  for (const extra of [{ cookie: "pulse_session=synthetic" }, { "x-pulse-session": "synthetic" }]) {
    const r = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/product-map/feed/map", { headers: { authorization: `Bearer ${TOKEN}`, ...extra } }), context(["product-map", "feed", "map"]));
    assert.equal(r.status, 401);
  }
  assert.equal(seen.length, 0);
});

test("odd feed paths are not found, and a token elsewhere is no sign-in", async () => {
  const { seen, fetchImpl } = capture();
  const odd = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/product-map/feed/..%2Fx", { headers: { authorization: `Bearer ${TOKEN}` } }), context(["product-map", "feed", "..%2Fx"]));
  assert.equal(odd.status, 404);
  const other = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/product-map", { headers: { authorization: `Bearer ${TOKEN}` } }), context(["product-map"]));
  assert.equal(other.status, 401, "outside the feed the token is not a person's sign-in");
  assert.equal(seen.length, 0);
});
