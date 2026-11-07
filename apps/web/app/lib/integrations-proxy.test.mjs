import assert from "node:assert/strict";
import test from "node:test";
import { createApiProxy, v0ProxyOptions } from "../api/proxy.mjs";
import { inboundHeaders } from "./host-mode.mjs";

const routes = [
  ["GET", ["integrations", "keys"]],
  ["POST", ["integrations", "keys"]],
  ["POST", ["integrations", "keys", "00000000-0000-4000-8000-000000000001", "revoke"]],
];
const aiKey = "pak_0123abcd_" + "a".repeat(64);
const context = (path) => ({ params: Promise.resolve({ path }) });
const requestFor = (method, path, headers, signIn, origin = "https://web.test") => {
  const url = `https://web.test/api/v0/${path.join("/")}`;
  return new Request(url, {
    method,
    headers: inboundHeaders(new Headers({ host: "web.test", ...(origin ? { origin } : {}), ...headers }), new URL(url).pathname, signIn === "password", method),
    ...(method === "POST" ? { body: "{}" } : {}),
  });
};
const assertNoStore = (response) => assert.equal(response.headers.get("cache-control"), "private, no-store");

for (const signIn of ["password", "access"]) {
  test(`${signIn}: every Integrations key method refuses signed-out, AI and mixed credentials without forwarding or caching`, async () => {
    let calls = 0;
    const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn, own: false }),
      fetchImpl: async () => { calls++; throw new Error("Refusals must not reach upstream"); } });
    const credentials = [
      ["signed out", {}, 401],
      ["AI", { "x-pulse-agent-key": aiKey }, 401],
      ["AI + staff", { "x-pulse-agent-key": aiKey, cookie: "pulse_session=synthetic-admin" }, 401],
      ["AI + Access", { "x-pulse-agent-key": aiKey, "cf-access-authenticated-user-email": "synthetic@example.test" }, 401],
      ["client", { cookie: "pulse_client_session=synthetic-client" }, 403],
      ["service", { authorization: "Bearer psvc_synthetic" }, 403],
      ["service + staff", { authorization: "Bearer psvc_synthetic", cookie: "pulse_session=synthetic-admin" }, 403],
      ["catalog", { authorization: "Bearer pcat_synthetic" }, 403],
      ["catalog + staff", { authorization: "Bearer pcat_synthetic", cookie: "pulse_session=synthetic-admin" }, 403],
    ];
    for (const [method, path] of routes) {
      for (const [label, headers, status] of credentials) {
        const response = await proxy(requestFor(method, path, headers, signIn), context(path));
        assert.equal(response.status, status, `${method} ${path.join("/")} ${label}`);
        assertNoStore(response);
        const body = await response.json();
        assert.deepEqual(Object.keys(body), ["error"]);
        assert.equal(typeof body.error, "string");
        assert.equal(calls, 0, `${label} must never fetch`);
      }
    }
  });

  test(`${signIn}: Integrations mutations retain CSRF refusal and unsupported methods remain denied`, async () => {
    let calls = 0;
    const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn, own: false }),
      fetchImpl: async () => { calls++; throw new Error("Refusals must not reach upstream"); } });
    // Access hosts require their verified Access identity even when a staff cookie is present.
    const headers = { cookie: "pulse_session=synthetic-admin", "cf-access-authenticated-user-email": "synthetic@example.test" };
    for (const [method, path] of routes.filter(([method]) => method === "POST")) {
      for (const origin of [null, "https://other.test"]) {
        const response = await proxy(requestFor(method, path, headers, signIn, origin), context(path));
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: "Invalid origin" });
        assertNoStore(response);
      }
    }
    const path = ["integrations", "keys"];
    const response = await proxy(requestFor("PUT", path, headers, signIn), context(path));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, POST");
    assertNoStore(response);
    assert.equal(calls, 0);
  });
}

test("Integrations upstream successes, refusals and outages stay private and uncached", async () => {
  const headers = { cookie: "pulse_session=synthetic-admin" };
  for (const [method, path] of routes) {
    for (const status of [200, 201, 400, 401, 403, 404, 503, "outage"]) {
      let calls = 0;
      const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn: "password", own: false }),
        fetchImpl: async (_url, init) => {
          calls++;
          assert.equal(init.cache, "no-store");
          assert.equal(init.headers["x-pulse-session"], "synthetic-admin");
          assert.equal(init.headers.authorization, undefined);
          if (status === "outage") throw new Error("Synthetic outage");
          return Response.json({ ok: status < 400 }, { status });
        } });
      const response = await proxy(requestFor(method, path, headers, "password"), context(path));
      assert.equal(response.status, status === "outage" ? 503 : status);
      assertNoStore(response);
      assert.equal(calls, 1);
    }
  }
});
