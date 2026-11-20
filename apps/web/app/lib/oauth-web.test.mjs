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

// AI-CONNECT (owner, 8 Nov 2026): Claude and ChatGPT ask for every scope; the person sees six plain tick boxes.
test("the consent screen groups an app's scopes into tick boxes inside the form, with the brand of the address", async () => {
  const { consentPage, brandFor } = await import("./oauth-web.mjs");
  const all = OAUTH_SCOPES.map((key) => ({ key, label: `words for ${key}` }));
  const page = await consentPage({ app: { name: "Claude", verified: false }, returnsTo: "claude.ai", person: "Asha", company: "Synthetic", scopes: all },
    new URLSearchParams({ client_id: "pcl_1", redirect_uri: "https://claude.ai/api/mcp/auth_callback", state: "s" }), { brand: "Vitals" }).text();
  assert.match(page, /Claude wants to use Vitals as you/);
  const form = page.slice(page.indexOf("<form"), page.indexOf("</form>"));
  assert.equal([...form.matchAll(/type="checkbox" name="grant"/g)].length, 6);
  assert.match(form, /name="choose" value="1"/);
  assert.match(form, /value="contracts" checked/);
  assert.match(form, /<li>words for docs\.write<\/li>/); // the exact lines under "What this covers"
  assert.ok(!page.includes("<script"));
  assert.equal(brandFor(new Headers({ host: "app.vitalsos.ai" })), "Vitals");
  assert.equal(brandFor(new Headers({ host: "pulse.example.test" })), "Pulse");
  const again = await consentPage({ app: { name: "Claude", verified: false }, returnsTo: "claude.ai", person: "Asha", company: "Synthetic", scopes: all },
    new URLSearchParams({ client_id: "pcl_1" }), { note: "Tick at least one thing it may do, or press Cancel." }).text();
  assert.match(again, /role="alert">Tick at least one thing/);
});
test("Allow grants only the ticked groups' scopes the app asked for; none ticked asks again; Cancel passes through", async () => {
  const { consentBody } = await import("./oauth-web.mjs");
  const form = (pairs) => new URLSearchParams(pairs);
  const base = [["client_id", "pcl_1"], ["redirect_uri", "https://claude.ai/api/mcp/auth_callback"], ["code_challenge", "x".repeat(43)], ["code_challenge_method", "S256"], ["response_type", "code"], ["choose", "1"]];
  let r = consentBody(form([...base, ["grant", "read"], ["grant", "contracts"], ["decision", "approve"]]));
  assert.equal(r.none, false); assert.equal(r.body.approve, true);
  assert.deepEqual(r.body.scope.split(" ").sort(), ["contracts.read", "contracts.write", "docs.read", "people.read", "projects.read", "search.read", "tasks.read"]);
  r = consentBody(form([...base, ["scope", "docs.read docs.write openid"], ["grant", "read"], ["grant", "write"], ["decision", "approve"]]));
  assert.equal(r.body.scope, "docs.read docs.write");
  r = consentBody(form([...base, ["grant", "made-up"], ["decision", "approve"]]));
  assert.equal(r.none, true);
  r = consentBody(form([...base, ["decision", "deny"]]));
  assert.equal(r.none, false); assert.equal(r.body.approve, false);
  assert.equal(consentBody(form([["client_id", "c"], ["scope", "docs.read"], ["decision", "approve"]])).body.scope, "docs.read"); // an old form, unchanged
});

// PULSE-BUGS (Vitals Technology bug #1, 19 Nov 2026): Kazuk is staff in two companies; the connector always connected the
// first. The screen says which company it connects, links the others (?_o= opens the screen there, this tab only) and
// posts Allow back with the same company. One company, or no company id: the screen is as before.
test("someone in several companies sees which one connects and can open the screen in another", async () => {
  const EA = "6f000000-0000-4000-8000-000000000001", VT = "6f000000-0000-4000-8000-000000000002";
  const query = new URLSearchParams({ client_id: "pcl_1", redirect_uri: "https://claude.ai/api/mcp/auth_callback", state: "s", scope: "people.read", unknown: "x" });
  const info = { app: { name: "Claude", verified: false }, returnsTo: "claude.ai", person: "Asha", company: "Synthetic One", scopes: [{ key: "people.read", label: "See people" }],
    orgId: EA, orgs: [{ id: EA, name: "Synthetic One" }, { id: VT, name: "Synthetic <Two>" }] };
  const page = await consentPage(info, query).text();
  assert.match(page, /It will work in <strong>Synthetic One<\/strong> only/);
  assert.match(page, new RegExp(`<a href="/oauth/mcp/authorize\\?client_id=pcl_1&amp;redirect_uri=[^"]*&amp;scope=people.read&amp;state=s&amp;_o=${VT}">Synthetic &lt;Two&gt;</a>`));
  assert.doesNotMatch(page, new RegExp(`<a href="[^"]*_o=${EA}"`), "the company it is in is not offered again");
  assert.ok(!page.includes("unknown=x"), "only the OAuth fields travel");
  assert.match(page, new RegExp(`<form method="post" action="/oauth/mcp/authorize\\?_o=${EA}">`));
  assert.ok(!page.includes("<script"));
  const single = await consentPage({ ...info, orgs: [{ id: EA, name: "Synthetic One" }] }, query).text();
  assert.doesNotMatch(single, /It will work in/);
  assert.match(single, new RegExp(`action="/oauth/mcp/authorize\\?_o=${EA}"`));
  const old = await consentPage({ ...info, orgId: "not-an-id" }, query).text();
  assert.match(old, /<form method="post" action="\/oauth\/mcp\/authorize">/);
  assert.doesNotMatch(old, /It will work in/);
});
