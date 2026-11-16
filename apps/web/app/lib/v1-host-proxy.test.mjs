import assert from "node:assert/strict";
import test from "node:test";
import { inboundHeaders } from "./host-mode.mjs";
import * as route from "../api/v1/[...path]/route.ts";

// Next's proxy.ts filters headers before the route receives decoded params.
async function throughHost(path, password, method, headers, fetchImpl) {
  const url = new URL(path, "https://web.test");
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await route[method](new Request(url, {
      method, headers: inboundHeaders(new Headers(headers), url.pathname, password, method),
      ...(["POST", "PATCH", "DELETE"].includes(method) ? { body: "{}" } : {}),
    }), { params: Promise.resolve({ path: url.pathname.split("/").slice(3).map(decodeURIComponent) }) });
  } finally { globalThis.fetch = previous; }
}

const paths = ["/api/v1/tasks/qa-unregistered-operation", "/api/v1/%74asks/qa-unregistered-operation",
  "/%61pi/%761/%74asks/qa-unregistered-operation"];
const identities = [
  { "x-pulse-session": "synthetic-session" }, { "x-pulse-client-session": "synthetic-client" },
  { "cf-access-jwt-assertion": "synthetic-jwt" }, { "cf-access-authenticated-user-email": "person@example.test" },
  { "cf-access-future-identity": "synthetic" }, { "x-dev-user": "synthetic" },
  { "x-pulse-access-id": "synthetic" }, { "x-pulse-agent-key": "synthetic" },
  { cookie: "pulse_session=synthetic" }, { "x-pulse-session": "" },
  { "cf-access-jwt-assertion": "" }, { "x-dev-user": "" },
];

for (const password of [true, false]) {
  test(`${password ? "password" : "Access"} host: v1 rejects mixed credentials before upstream, including encoded paths`, async () => {
    let calls = 0;
    for (const path of paths) for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      for (const token of ["psvc_synthetic", "pak_synthetic"]) for (const identity of identities) {
        const label = `${method} ${path} ${Object.keys(identity)[0]}`;
        const response = await throughHost(path, password, method, {
          host: "web.test", authorization: `Bearer ${token}`, ...identity,
        }, async () => { calls++; return Response.json({}, { status: 404 }); });
        assert.equal(response.status, 401, label);
        assert.equal(calls, 0, `${label}: must never fetch`);
        const problem = await response.json();
        assert.deepEqual(Object.keys(problem).sort(), ["detail", "requestId", "status", "title", "type"]);
        assert.equal(problem.status, 401);
        assert.equal(problem.requestId, response.headers.get("x-request-id"));
        assert.equal(response.headers.get("content-type"), "application/problem+json");
        assert.match(response.headers.get("cache-control"), /no-store/);
        assert.equal(response.headers.has("set-cookie"), false);
      }
    }
  });

  test(`${password ? "password" : "Access"} host: a bearer alone reaches the v1 route without an identity fallback`, async () => {
    for (const path of paths) for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      for (const token of ["psvc_synthetic", "pak_synthetic"]) {
        const calls = [];
        const response = await throughHost(`${path}?limit=1`, password, method, {
          host: "web.test", authorization: `Bearer ${token}`, "content-type": "application/json", "x-pulse-host": "forged.test",
          "x-pulse-viewer": "forged-person", "x-pulse-org-id": "forged-org", "idempotency-key": "synthetic-id",
        }, async (url, init) => { calls.push({ url, init }); return Response.json({}, { status: 404 }); });
        assert.equal(response.status, 404); // No domain operation or database authentication is claimed.
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /\/api\/v1\/tasks\/qa-unregistered-operation\?limit=1$/);
        assert.deepEqual(Object.fromEntries(calls[0].init.headers), {
          authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "synthetic-id", "x-pulse-host": "web.test",
        });
      }
    }
  });
}

test("host filtering preserves native sessions and unrelated v0 bearer handling", () => {
  for (const path of ["/api/native/sync", "/api/v0/me", "/settings", "/api/v10/tasks"]) {
    const headers = inboundHeaders({ authorization: "Bearer synthetic", "x-pulse-session": "synthetic", "x-dev-user": "forged" }, path, true);
    assert.equal(headers.get("authorization"), "Bearer synthetic");
    assert.equal(headers.has("x-dev-user"), false);
    assert.equal(headers.has("x-pulse-session"), path.startsWith("/api/native/"));
  }
});

test("the public v1 reference remains public and forwards no credentials after host filtering", async () => {
  for (const password of [true, false]) {
    const calls = [];
    const response = await throughHost("/api/v1/openapi.json", password, "GET", {
      host: "web.test", authorization: "Bearer synthetic", "x-pulse-session": "synthetic",
    }, async (_url, init) => { calls.push(init); return Response.json({ openapi: "3.1.0" }); });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.fromEntries(calls[0].headers), { "x-pulse-host": "web.test" });
  }
});
