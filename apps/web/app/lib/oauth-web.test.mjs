// EST-2811: discovery documents, the 401 challenge and the OAuth forwarder (no API needed).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { OAUTH_SCOPES, authorizationServer, challenge, consentPage, forwardOAuth, oauthAddresses, protectedResource, publicOrigin, returnPage } from "./oauth-web.mjs";

test("scopes match the API's consent list", async () => {
  const api = await readFile(new URL("../../../../services/api/src/oauth.ts", import.meta.url), "utf8");
  const block = api.slice(api.indexOf("OAUTH_SCOPES"), api.indexOf("export const DEFAULT_SCOPES"));
  assert.deepEqual([...block.matchAll(/'([a-z]+\.(?:read|write))'/g)].map((m) => m[1]), OAUTH_SCOPES);
});
test("discovery documents name this address", () => {
  const origin = publicOrigin(new Headers({ host: "pulse.example.test" }));
  assert.equal(origin, "https://pulse.example.test");
  assert.equal(publicOrigin(new Headers({ host: "127.0.0.1:3100" })), "http://127.0.0.1:3100");
  assert.equal(protectedResource(origin).resource, "https://pulse.example.test/mcp");
  const as = authorizationServer(origin);
  assert.equal(as.issuer, origin); assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.registration_endpoint, origin + "/oauth/mcp/register");
  assert.match(challenge(origin), /^Bearer realm="pulse", resource_metadata="https:\/\/pulse\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(challenge(origin, true), /error="invalid_token"$/);
});
test("token forms become JSON with Basic credentials; other headers stay behind", async () => {
  let seen;
  const response = await forwardOAuth(new Request("https://pulse.example.test/oauth/token", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic YTpi", cookie: "pulse_session=x", host: "pulse.example.test" },
    body: "grant_type=authorization_code&code=poc_x&code_verifier=v" }), "token", async (url, init) => { seen = { url, init }; return Response.json({ access_token: "pat_x" }); });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(seen.url, /\/api\/v0\/oauth\/token$/);
  assert.deepEqual(JSON.parse(seen.init.body), { grant_type: "authorization_code", code: "poc_x", code_verifier: "v" });
  assert.equal(seen.init.headers.authorization, "Basic YTpi"); assert.equal(seen.init.headers.cookie, undefined);
  assert.equal((await forwardOAuth(new Request("https://x.test/oauth/token", { method: "POST", body: "[1]" }), "token")).status, 400);
  assert.equal((await forwardOAuth(new Request("https://x.test/oauth/token"), "token")).status, 405);
});
test("consent and return pages escape what an app says about itself", async () => {
  const page = await consentPage({ app: { name: "<script>x</script>", verified: false }, returnsTo: "claude.ai", person: "Asha", company: "Synthetic",
    scopes: [{ key: "people.read", label: "See people" }] }, new URLSearchParams({ client_id: "pcl_1", state: '"><b>' })).text();
  assert.ok(!page.includes("<script>x")); assert.ok(page.includes("&lt;script&gt;")); assert.ok(page.includes('value="&quot;&gt;&lt;b&gt;"'));
  assert.ok(!page.includes("<script")); // no script at all on the consent screen
  const back = await returnPage("https://claude.ai/api/mcp/auth_callback?code=poc_1&state=s").text();
  assert.match(back, /http-equiv="refresh" content="0;url=https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=poc_1&amp;state=s"/);
});

test("OAuth pages send their own origin on the consent POST but no referrer to other sites", async () => {
  const page = await consentPage({ app: { name: "Synthetic app", verified: false }, returnsTo: "app.example.test", person: "Asha", company: "Synthetic",
    scopes: [{ label: "Read people" }] }, new URLSearchParams({ client_id: "c", redirect_uri: "https://app.example.test/cb", state: "s" })).text();
  assert.match(page, /<meta name="referrer" content="same-origin">/);
  assert.doesNotMatch(page, /content="no-referrer"/);
  assert.match(page, /<form method="post" action="\/oauth\/mcp\/authorize">/);
});

// VITALS-HOSTS (owner, 4 Nov 2026): on a platform family, MCP and its sign-in name one issuer (id.), whichever host is asked.
test("a platform family's discovery names its MCP host and its one issuer", () => {
  const env = { PULSE_PUBLIC_URL: "https://pulse.legacy.test",
    PULSE_HOST_FAMILIES: JSON.stringify([{ name: "vitals", app: "app.vitals.test", api: "api.vitals.test", mcp: "mcp.vitals.test", id: "id.vitals.test" }]) };
  const at = (host) => oauthAddresses(new Headers({ host }), env);
  assert.deepEqual(at("mcp.vitals.test"), { issuer: "https://id.vitals.test", mcp: "https://mcp.vitals.test", docs: "https://app.vitals.test/developers" });
  assert.deepEqual(at("id.vitals.test"), { issuer: "https://id.vitals.test", mcp: "https://mcp.vitals.test", docs: "https://app.vitals.test/developers" });
  // The app host serves /mcp itself, so its resource is its own; the issuer is still the family's.
  assert.deepEqual(at("app.vitals.test"), { issuer: "https://id.vitals.test", mcp: "https://app.vitals.test", docs: "https://app.vitals.test/developers" });
  const prm = protectedResource(at("mcp.vitals.test").mcp, at("mcp.vitals.test").issuer, at("mcp.vitals.test").docs);
  assert.equal(prm.resource, "https://mcp.vitals.test/mcp");
  assert.deepEqual(prm.authorization_servers, ["https://id.vitals.test"]);
  const as = authorizationServer(at("mcp.vitals.test").issuer, at("mcp.vitals.test").docs);
  assert.equal(as.issuer, "https://id.vitals.test");
  assert.equal(as.authorization_endpoint, "https://id.vitals.test/oauth/mcp/authorize");
  assert.equal(as.registration_endpoint, "https://id.vitals.test/oauth/mcp/register");
  assert.match(challenge(at("mcp.vitals.test").mcp), /resource_metadata="https:\/\/mcp\.vitals\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  // The install's own address and a company's address keep being their own issuer (existing MCP connections).
  assert.deepEqual(at("pulse.legacy.test"), { issuer: "https://pulse.legacy.test", mcp: "https://pulse.legacy.test", docs: "https://pulse.legacy.test/developers" });
  assert.deepEqual(at("acme.example.test"), { issuer: "https://acme.example.test", mcp: "https://acme.example.test", docs: "https://acme.example.test/developers" });
  assert.deepEqual(protectedResource("https://acme.example.test"), protectedResource("https://acme.example.test", "https://acme.example.test", "https://acme.example.test/developers"));
});
