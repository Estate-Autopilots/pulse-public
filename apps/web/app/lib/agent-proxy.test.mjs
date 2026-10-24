// EST-1035: the proxy hands an AI co-worker's key to /api/v0/agent/* and nothing else; a person's credential never
// travels with it, a person's path carrying a key is refused outright, and agent paths are plain segments only.
import assert from "node:assert/strict";
import test from "node:test";
import { createApiProxy, v0ProxyOptions, v1ProxyOptions } from "../api/proxy.mjs";
import { inboundHeaders } from "./host-mode.mjs";

const context = (path) => ({ params: Promise.resolve({ path }) });
const KEY = "pak_0123abcd_" + "a".repeat(64);
const capture = () => { const seen = []; return { seen, fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }); } }; };
const proxyWith = (fetchImpl, signIn = "access", options = v0ProxyOptions) => createApiProxy({ ...options, fetchImpl, hostLookup: async () => ({ signIn }) });
// Compose the same header boundary used by proxy.ts with the API proxy, on either host mode.
const hostRequest = (url, init, signIn = "password") => new Request(url, { ...init, headers: inboundHeaders(new Headers(init.headers), new URL(url).pathname, signIn === "password") });
const passwordRequest = (url, init) => hostRequest(url, init);

test("a password host keeps the co-worker key through proxy.ts and still drops every client-sent identity header", () => {
  const sent = { "x-pulse-agent-key": KEY, "x-pulse-host": "other.test", "X-Pulse-Viewer": "v", "x-pulse-org-id": "other-org",
                 "x-dev-user": "d", accept: "application/json" };
  const kept = inboundHeaders(new Headers(sent), "/api/v0/agent/me", true);
  assert.deepEqual([...kept.keys()].sort(), ["accept", "x-pulse-agent-key"]);
  assert.equal(kept.get("x-pulse-agent-key"), KEY);
  const person = { "x-pulse-session": "s", "x-pulse-client-session": "c", "cf-access-authenticated-user-email": "synthetic@example.test" };
  assert.equal(inboundHeaders(new Headers(person), "/api/native/sync", true).get("x-pulse-session"), "s");
  assert.deepEqual([...inboundHeaders(new Headers(person), "/api/v0/me", true)], []);
  const access = inboundHeaders(new Headers(sent), "/api/v0/agent/me", false);
  assert.equal(access.get("x-pulse-host"), null);
  assert.equal(access.get("x-pulse-agent-key"), KEY);
});

for (const signIn of ["password", "access"]) {
  test(`${signIn} host: middleware and API forward only the key and computed host for GET and POST`, async () => {
    const { seen, fetchImpl } = capture();
    for (const method of ["GET", "POST"]) {
      const response = await proxyWith(fetchImpl, signIn)(hostRequest("http://web.test/api/v0/agent/me?check=synthetic", {
        method, ...(method === "POST" ? { body: "{}" } : {}), headers: {
          host: "web.test", "x-pulse-agent-key": KEY, "x-pulse-host": "other.test", "x-pulse-org-id": "other-org",
          "x-pulse-viewer": "other-person", "x-pulse-client-ip": "192.0.2.1", "x-dev-user": "other-person",
        },
      }, signIn), context(["agent", "me"]));
      assert.equal(response.status, 200, method);
      assert.equal(seen.length, method === "GET" ? 1 : 2);
      assert.deepEqual(seen.at(-1).init.headers, { "content-type": "application/json", "x-pulse-agent-key": KEY, "x-pulse-client-ip": "agent-runner", "x-pulse-host": "web.test" });
      assert.match(seen.at(-1).url, /\/api\/v0\/agent\/me\?check=synthetic$/);
      assert.equal(seen.at(-1).init.body, method === "POST" ? "{}" : undefined);
    }
  });

  test(`${signIn} host: middleware cannot turn mixed credentials into a key-only request`, async () => {
    const { seen, fetchImpl } = capture();
    for (const method of ["GET", "POST"]) {
      for (const extra of [{ cookie: "pulse_session=synthetic-session" }, { cookie: "pulse_client_session=synthetic-client" },
        { "cf-access-authenticated-user-email": "synthetic@example.test" }, { "cf-access-jwt-assertion": "synthetic-jwt" },
        { authorization: "Bearer synthetic-person" }, { "x-pulse-session": "synthetic-session" }, { "x-pulse-client-session": "synthetic-client" },
        { "x-pulse-session": "" }, { "cf-access-jwt-assertion": "" }]) {
        const label = `${method} ${Object.keys(extra)[0]}`;
        const response = await proxyWith(fetchImpl, signIn)(hostRequest("http://web.test/api/v0/agent/me", {
          method, ...(method === "POST" ? { body: "{}" } : {}), headers: { "x-pulse-agent-key": KEY, ...extra },
        }, signIn), context(["agent", "me"]));
        assert.equal(response.status, 401, label);
        assert.equal(seen.length, 0, `${label} must never fetch`);
      }
    }
  });

  test(`${signIn} host: person routes refuse keys even when mixed credentials are sanitized`, async () => {
    const { seen, fetchImpl } = capture();
    for (const [version, path, options] of [["v0", ["chats"], v0ProxyOptions], ["v1", ["deliveries", "synthetic-delivery", "claim"], v1ProxyOptions]]) {
      for (const method of ["GET", "POST"]) {
        for (const extra of [{}, { cookie: "pulse_session=synthetic-session" }, { "x-pulse-session": "synthetic-session" }, { "cf-access-authenticated-user-email": "synthetic@example.test" }]) {
          const response = await proxyWith(fetchImpl, signIn, options)(hostRequest(`http://web.test/api/${version}/${path.join("/")}`, {
            method, ...(method === "POST" ? { body: "{}" } : {}), headers: { "x-pulse-agent-key": KEY, host: "web.test", origin: "http://web.test", ...extra },
          }, signIn), context(path));
          assert.equal(response.status, 401, `${version} ${method}`);
          assert.equal(seen.length, 0, `${version} ${method} must never fetch`);
        }
      }
    }
  });

  test(`${signIn} host: missing and malformed keys are rejected after middleware with no upstream call`, async () => {
    const { seen, fetchImpl } = capture();
    for (const method of ["GET", "POST"]) {
      for (const headers of [{}, { "x-pulse-agent-key": "" }, { "x-pulse-agent-key": "pak_short" }]) {
        const response = await proxyWith(fetchImpl, signIn)(hostRequest("http://web.test/api/v0/agent/me", {
          method, ...(method === "POST" ? { body: "{}" } : {}), headers,
        }, signIn), context(["agent", "me"]));
        assert.equal(response.status, 401, method);
        assert.equal(seen.length, 0, `${method} must never fetch`);
      }
    }
  });
}

test("on a password host an agent route reaches the API with the key, and mixed or misplaced keys are still refused", async () => {
  const { seen, fetchImpl } = capture();
  const ok = await proxyWith(fetchImpl, "password")(passwordRequest("http://web.test/api/v0/agent/chats/c/messages", { method: "POST", body: "{}", headers: { "x-pulse-agent-key": KEY } }), context(["agent", "chats", "c", "messages"]));
  assert.equal(ok.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.headers["x-pulse-agent-key"], KEY);
  for (const method of ["GET", "POST"]) {
    const init = { method, ...(method === "POST" ? { body: "{}" } : {}) };
    const mixed = await proxyWith(fetchImpl, "password")(passwordRequest("http://web.test/api/v0/agent/me", { ...init, headers: { "x-pulse-agent-key": KEY, cookie: "pulse_session=person-session-token" } }), context(["agent", "me"]));
    assert.equal(mixed.status, 401, `${method} cookie`);
    const person = await proxyWith(fetchImpl, "password")(passwordRequest("http://web.test/api/v0/chats", { ...init, headers: { "x-pulse-agent-key": KEY, origin: "http://web.test", host: "web.test" } }), context(["chats"]));
    assert.equal(person.status, 401, `${method} person path`);
  }
  assert.equal(seen.length, 1);
});

test("an agent route without a well-formed key is refused before the API is called", async () => {
  const { seen, fetchImpl } = capture();
  const response = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/agent/me", { headers: { "x-pulse-agent-key": "pak_short" } }), context(["agent", "me"]));
  assert.equal(response.status, 401);
  assert.equal(seen.length, 0);
});

test("an agent route forwards the key alone and needs no origin", async () => {
  const { seen, fetchImpl } = capture();
  const request = new Request("http://web.test/api/v0/agent/events/claim", { method: "POST", body: '{"limit":5}', headers: { "x-pulse-agent-key": KEY } });
  const response = await proxyWith(fetchImpl)(request, context(["agent", "events", "claim"]));
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  const headers = seen[0].init.headers;
  assert.equal(headers["x-pulse-agent-key"], KEY);
  assert.equal(headers["x-pulse-session"], undefined);
  assert.equal(headers["cf-access-authenticated-user-email"], undefined);
  assert.equal(seen[0].init.body, '{"limit":5}');
  assert.match(seen[0].url, /\/api\/v0\/agent\/events\/claim$/);
});

test("an agent route with a person's cookie, session, Access identity or bearer token beside the key is refused, not stripped", async () => {
  const { seen, fetchImpl } = capture();
  for (const method of ["GET", "POST"]) {
    for (const extra of [{ cookie: "pulse_session=person-session-token" }, { "cf-access-authenticated-user-email": "leader@example.com" },
                         { "cf-access-jwt-assertion": "jwt" }, { authorization: "Bearer " + "x".repeat(43) },
                         { "x-pulse-session": "person-session-token" }, { "x-pulse-client-session": "client-session-token" }]) {
      const response = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/agent/me", { method, ...(method === "POST" ? { body: "{}" } : {}),
        headers: { "x-pulse-agent-key": KEY, ...extra } }), context(["agent", "me"]));
      assert.equal(response.status, 401, `${method} ${Object.keys(extra)[0]}`);
      assert.equal(seen.length, 0, `${method} ${Object.keys(extra)[0]} must never fetch`);
    }
  }
  assert.equal(seen.length, 0);
});

test("a person's path carrying a co-worker key is refused before anything is forwarded (mixed credentials)", async () => {
  const { seen, fetchImpl } = capture();
  for (const method of ["GET", "POST"]) {
    const response = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/chats", { method, ...(method === "POST" ? { body: "{}" } : {}),
      headers: { "x-pulse-agent-key": KEY, "cf-access-authenticated-user-email": "leader@example.com", origin: "http://web.test", host: "web.test" } }), context(["chats"]));
    assert.equal(response.status, 401, method);
  }
  assert.equal(seen.length, 0);
});

test("an agent path with dot segments, an encoded slash or a malformed escape is refused before the API is called", async () => {
  const { seen, fetchImpl } = capture();
  for (const method of ["GET", "POST"]) {
    for (const path of [["agent", "..", "chats"], ["agent", ".", "me"], ["agent", "%2e%2e", "people"], ["agent", "%2E", "me"], ["agent", "x%2F..%2Fchats"], ["agent", "a%5Cb"], ["agent", "%E0%A4%A"]]) {
      const response = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/agent/me", { method, ...(method === "POST" ? { body: "{}" } : {}), headers: { "x-pulse-agent-key": KEY } }), context(path));
      assert.equal(response.status, 404, `${method} ${path.join("/")}`);
    }
  }
  assert.equal(seen.length, 0);
});
