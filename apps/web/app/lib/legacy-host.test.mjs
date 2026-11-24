// DOMAIN (owner, 22 Nov 2026): old addresses lead to the brand's (legacy-host.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { legacyRedirect } from "./legacy-host.mjs";

const env = { PULSE_LEGACY_HOSTS: "pulse.estateautopilots.com, pulse-staging.estateautopilots.com", PULSE_LEGACY_TO: "https://app.vitalsos.ai" };

test("a page on an old address goes to the brand's, path and query kept", () => {
  assert.equal(legacyRedirect("pulse.estateautopilots.com", "/accept/abc", "", "GET", env), "https://app.vitalsos.ai/accept/abc");
  assert.equal(legacyRedirect("Pulse.EstateAutopilots.com:443", "/erp/documents/1", "?view=quotation", "HEAD", env), "https://app.vitalsos.ai/erp/documents/1?view=quotation");
  assert.equal(legacyRedirect("pulse-staging.estateautopilots.com", "/", "", "GET", env), "https://app.vitalsos.ai/");
});

test("API calls, OAuth, discovery, writes, other hosts and an unset switch stay", () => {
  for (const path of ["/api/v1/billing/quotations", "/api/app-updates", "/oauth/token", "/.well-known/openid-configuration", "/_next/static/x.js"])
    assert.equal(legacyRedirect("pulse.estateautopilots.com", path, "", "GET", env), null, path);
  assert.equal(legacyRedirect("pulse.estateautopilots.com", "/accept/abc", "", "POST", env), null);
  assert.equal(legacyRedirect("app.vitalsos.ai", "/", "", "GET", env), null);
  assert.equal(legacyRedirect("pulse.wiselifee.com", "/", "", "GET", env), null);
  assert.equal(legacyRedirect("pulse.estateautopilots.com", "/", "", "GET", {}), null);
  assert.equal(legacyRedirect("pulse.estateautopilots.com", "/", "", "GET", { ...env, PULSE_LEGACY_TO: "http://app.vitalsos.ai" }), null);
});
