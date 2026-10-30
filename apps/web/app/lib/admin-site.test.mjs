// PULSE-ADMIN: which requests the web forwards to the admin site, and where Pulse links to it (configuration only).
import assert from "node:assert/strict";
import test from "node:test";
import { adminHosts, adminOrigin, adminUrl } from "./admin-site.mjs";

test("the admin site's host follows Pulse's own domain unless it is configured", () => {
  assert.deepEqual(adminHosts({ PULSE_PUBLIC_URL: "https://pulse.example.test" }), ["pulse-admin.example.test"]);
  assert.deepEqual(adminHosts({ PULSE_ADMIN_HOSTS: "Admin.Pulse.Example.Test, bad host,pulse-admin.example.test" }), ["admin.pulse.example.test", "pulse-admin.example.test"]);
  assert.deepEqual(adminHosts({ PULSE_ADMIN_HOSTS: "", PULSE_PUBLIC_URL: "https://pulse.example.test" }), [], "an empty list turns forwarding off");
  assert.deepEqual(adminHosts({ PULSE_PUBLIC_URL: "https://example.test" }), [], "no guess from a bare domain");
  assert.deepEqual(adminHosts({}), []);
});

test("only the admin site's own host is forwarded, to the admin server", () => {
  const env = { PULSE_PUBLIC_URL: "https://pulse.example.test" };
  assert.equal(adminOrigin("pulse-admin.example.test", env), "http://127.0.0.1:8083");
  assert.equal(adminOrigin("PULSE-ADMIN.example.test:443", env), "http://127.0.0.1:8083");
  assert.equal(adminOrigin("pulse.example.test", env), null);
  assert.equal(adminOrigin("evil-pulse-admin.example.test", env), null);
  assert.equal(adminOrigin(null, env), null);
  assert.equal(adminOrigin("pulse-admin.example.test", { ...env, PULSE_ADMIN_ORIGIN: "http://127.0.0.1:9999" }), "http://127.0.0.1:9999");
});

test("Pulse links to the admin site's configured address", () => {
  assert.equal(adminUrl({ PULSE_PUBLIC_URL: "https://pulse.example.test" }), "https://pulse-admin.example.test");
  assert.equal(adminUrl({ PULSE_ADMIN_URL: "https://admin.new.example.test/" }), "https://admin.new.example.test");
  assert.equal(adminUrl({ PULSE_ADMIN_URL: "javascript:alert(1)" }), null);
});
