// PULSE-ADMIN: the admin site's brand, company and addresses come from configuration only; changes come from its own pages.
import assert from "node:assert/strict";
import test from "node:test";
import { adminConfig } from "./config.ts";
import { sameOrigin } from "./guard.ts";

test("brand, company, support and sites are configuration", () => {
  assert.deepEqual(adminConfig({ NODE_ENV: "production" }), { product: "Pulse", company: null, supportEmail: null, environment: "production", sites: [], appUrl: null, hosts: [] });
  const c = adminConfig({ PULSE_PLATFORM_NAME: "Pulse", PULSE_PLATFORM_COMPANY: "Synthetic Pulse LLP", PULSE_SUPPORT_EMAIL: "help@pulse.example.test", PULSE_ADMIN_ENV: "development",
    PULSE_ADMIN_PRODUCTION_URL: "https://pulse-admin.example.test/x", PULSE_ADMIN_DEV_URL: "https://pulse-admin-dev.example.test", PULSE_APP_URL: "https://pulse.example.test" });
  assert.equal(c.company, "Synthetic Pulse LLP");
  assert.equal(c.environment, "development");
  assert.deepEqual(c.sites.map((s) => s.url), ["https://pulse-admin.example.test", "https://pulse-admin-dev.example.test"]);
  assert.equal(c.appUrl, "https://pulse.example.test");
  assert.equal(adminConfig({ PULSE_SUPPORT_EMAIL: "nope", PULSE_ADMIN_PRODUCTION_URL: "javascript:alert(1)" }).supportEmail, null);
  assert.deepEqual(adminConfig({ PULSE_ADMIN_PRODUCTION_URL: "http://evil.example.test" }).sites, [], "only https sites");
  const derived = adminConfig({ PULSE_PUBLIC_URL: "https://pulse.example.test" });
  assert.deepEqual(derived.hosts, ["pulse-admin.example.test", "pulse-admin-dev.example.test"], "the sites follow Pulse's own domain");
  assert.equal(derived.appUrl, "https://pulse.example.test");
});

test("a change must come from the admin site's own pages", () => {
  const request = (headers) => ({ headers: new Headers(headers) });
  assert.equal(sameOrigin(request({ origin: "https://pulse-admin.example.test", host: "pulse-admin.example.test" })), true);
  assert.equal(sameOrigin(request({ origin: "https://pulse-admin.example.test", host: "127.0.0.1:8083", "x-forwarded-host": "pulse-admin.example.test" })), true);
  assert.equal(sameOrigin(request({ origin: "https://evil.example.test", host: "pulse-admin.example.test" })), false);
  assert.equal(sameOrigin(request({ host: "pulse-admin.example.test" })), false, "no Origin, no change");
});
