// VITALS-HOSTS (owner, 4 Nov 2026): platform host families: which job each host does, where it sends people, and the
// one issuer per family. Synthetic hosts only (*.test, *.localhost).
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostFamilies, hostFamily, hostRoute, sameOriginFor } from "./host-families.mjs";

const FAMILY = { name: "vitals", app: "app.vitals.test", api: "api.vitals.test", mcp: "mcp.vitals.test", id: "id.vitals.test" };
const env = { PULSE_HOST_FAMILIES: JSON.stringify([FAMILY]), PULSE_PUBLIC_URL: "https://pulse.legacy.test" };

test("the configured family and the install's own address are both families", () => {
  assert.deepEqual(hostFamilies(env).map((f) => [f.name, f.listed, f.app]), [["vitals", true, "app.vitals.test"], ["install", false, "pulse.legacy.test"]]);
  // Nothing configured: the install's address is the only family, as before.
  assert.deepEqual(hostFamilies({ PULSE_PUBLIC_URL: "https://pulse.legacy.test" }).map((f) => f.name), ["install"]);
  assert.deepEqual(hostFamilies({}), []);
});

test("each host knows its job and its family's addresses", () => {
  const app = hostFamily("APP.vitals.test", env);
  assert.deepEqual(app, { name: "vitals", listed: true, role: "app", host: "app.vitals.test", self: "https://app.vitals.test", app: "https://app.vitals.test",
    issuer: "https://id.vitals.test", mcp: "https://app.vitals.test", signIn: "https://app.vitals.test" });
  const mcp = hostFamily("mcp.vitals.test", env);
  assert.equal(mcp.role, "mcp"); assert.equal(mcp.mcp, "https://mcp.vitals.test"); assert.equal(mcp.signIn, "https://app.vitals.test");
  const id = hostFamily("id.vitals.test.", env);
  assert.equal(id.role, "id"); assert.equal(id.signIn, "https://id.vitals.test"); assert.equal(id.mcp, "https://mcp.vitals.test");
  const api = hostFamily("api.vitals.test:443", env);
  assert.equal(api.role, "api"); assert.equal(api.signIn, "https://app.vitals.test"); assert.equal(api.issuer, "https://id.vitals.test");
  // The install's address is its own issuer and MCP server (unchanged for existing connections).
  const legacy = hostFamily("pulse.legacy.test", env);
  assert.deepEqual([legacy.name, legacy.listed, legacy.role, legacy.issuer, legacy.mcp], ["install", false, "app", "https://pulse.legacy.test", "https://pulse.legacy.test"]);
  // A company's own address, or any other host, is in no family.
  assert.equal(hostFamily("acme.vitals.test", env), null);
  assert.equal(hostFamily("evil.test", env), null);
  assert.equal(hostFamily("", env), null);
  assert.equal(hostFamily(null, env), null);
});

test("a family without id or mcp hosts uses its app host for both", () => {
  const e = { PULSE_HOST_FAMILIES: JSON.stringify([{ name: "small", app: "pulse.small.test", api: "api.small.test" }]) };
  const api = hostFamily("api.small.test", e);
  assert.equal(api.issuer, "https://pulse.small.test"); assert.equal(api.mcp, "https://pulse.small.test");
});

test("a *.localhost rehearsal is plain http on the port in use", () => {
  const e = { PULSE_HOST_FAMILIES: JSON.stringify([{ name: "vitals", app: "app.vitals.localhost", mcp: "mcp.vitals.localhost", id: "id.vitals.localhost" }]) };
  const mcp = hostFamily("mcp.vitals.localhost:4410", e);
  assert.equal(mcp.self, "http://mcp.vitals.localhost:4410"); assert.equal(mcp.issuer, "http://id.vitals.localhost:4410"); assert.equal(mcp.app, "http://app.vitals.localhost:4410");
});

test("bad or overlapping families are skipped, never half-applied", () => {
  const e = { PULSE_HOST_FAMILIES: JSON.stringify([{ name: "a", app: "app.a.test" }, { name: "b", app: "app.b.test", api: "app.a.test" }, { name: "c", api: "api.c.test" },
    { name: "d", app: "x.d.test", id: "x.d.test" }, "junk", { name: "BAD NAME", app: "app.e.test", mcp: "not a host" }]) };
  assert.deepEqual(hostFamilies(e).map((f) => [f.name, f.app, f.mcp]), [["a", "app.a.test", null], ["family-6", "app.e.test", null]]);
  assert.deepEqual(hostFamilies({ PULSE_HOST_FAMILIES: "{not json" }), []);
  assert.deepEqual(hostFamilies({ PULSE_HOST_FAMILIES: "{\"app\":\"app.x.test\"}" }), []);
  // The install's address listed in a family is that family's, not a second one.
  const merged = hostFamilies({ PULSE_HOST_FAMILIES: JSON.stringify([{ name: "legacy", app: "pulse.legacy.test" }]), PULSE_PUBLIC_URL: "https://pulse.legacy.test" });
  assert.deepEqual(merged.map((f) => f.name), ["legacy"]);
});

test("api, mcp and id answer only their own paths; other GETs go to the app host", () => {
  const route = (host, path, method = "GET", search = "") => hostRoute(host, path, search, method, env);
  // The app host and hosts outside a family are untouched.
  for (const path of ["/", "/dashboard", "/mcp", "/api/v0/me", "/login"]) assert.equal(route("app.vitals.test", path), null);
  assert.equal(route("pulse.legacy.test", "/dashboard"), null);
  assert.equal(route("acme.vitals.test", "/dashboard"), null);
  // api: the API and discovery.
  for (const path of ["/api/v0/host", "/api/v1/people", "/api/native/v0/me", "/.well-known/oauth-protected-resource"]) assert.equal(route("api.vitals.test", path), null);
  assert.deepEqual(route("api.vitals.test", "/", "GET"), { status: 302, location: "https://app.vitals.test/" });
  assert.deepEqual(route("api.vitals.test", "/people", "HEAD", "?tab=x"), { status: 302, location: "https://app.vitals.test/people?tab=x" });
  assert.deepEqual(route("api.vitals.test", "/login", "POST"), { status: 404, body: "Pulse is at https://app.vitals.test\n" });
  // SERVERS-AI: a paired server's calls stay on api. (never redirected); the installer path is not the API's.
  for (const path of ["/runner/v1/pair", "/runner/v1/poll", "/runner/v1/jobs/job_1/outputs"]) assert.equal(route("api.vitals.test", path, "POST"), null);
  assert.equal(route("api.vitals.test", "/runner/install.sh").status, 302);
  // mcp: /mcp and its OAuth discovery only.
  for (const path of ["/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"])
    assert.equal(route("mcp.vitals.test", path, "POST"), null);
  assert.equal(route("mcp.vitals.test", "/api/v0/me").status, 302);
  assert.equal(route("mcp.vitals.test", "/.well-known/assetlinks.json").status, 302);
  assert.equal(route("mcp.vitals.test", "/login").status, 302);
  assert.equal(route("mcp.vitals.test", "/oauth/mcp/token", "POST").status, 404);
  // id: the issuer's discovery and endpoints, and the sign-in page they need (with its scripts and the API it calls).
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/oauth/mcp/authorize", "/oauth/mcp/token",
    "/login", "/login/link", "/api/v0/auth/sign-in", "/_next/static/chunks/a.js", "/favicon.ico", "/icon.svg", "/manifest.webmanifest"]) assert.equal(route("id.vitals.test", path), null);
  assert.deepEqual(route("id.vitals.test", "/"), { status: 302, location: "https://app.vitals.test/" });
  assert.deepEqual(route("id.vitals.test", "/dashboard"), { status: 302, location: "https://app.vitals.test/dashboard" });
  assert.equal(route("id.vitals.test", "/loginx").status, 302);
  assert.equal(route("id.vitals.test", "/mcp", "POST").status, 404);
});

test("a family host is its own origin for same-origin checks; others keep the caller's rule", () => {
  assert.equal(sameOriginFor("app.vitals.test", "https://pulse.legacy.test", env), "https://app.vitals.test");
  assert.equal(sameOriginFor("id.vitals.test", "https://pulse.legacy.test", env), "https://id.vitals.test");
  // The install's address and other hosts: unchanged (the caller passes PULSE_PUBLIC_URL or the request's own origin).
  assert.equal(sameOriginFor("pulse.legacy.test", "https://pulse.legacy.test", env), "https://pulse.legacy.test");
  assert.equal(sameOriginFor("127.0.0.1:3000", "http://127.0.0.1:3000", env), "http://127.0.0.1:3000");
  assert.equal(sameOriginFor("acme.vitals.test", "http://acme.vitals.test", env), "http://acme.vitals.test");
});
