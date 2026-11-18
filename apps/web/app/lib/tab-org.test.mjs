// ORG-PER-TAB: a company per browser tab. Which company a request is for (proxy.ts), what the API proxy forwards, the
// `_o` hint never reaching the API, a forged company passed on only as the API's question (it answers "Not found"), and
// sign-out keeping or ending the browser's sign-in.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createApiProxy, forwardSearch, v0ProxyOptions } from "../api/proxy.mjs";
import { renderedOrg, TAB_SHIM, tabCookies, tabOrgFor } from "./tab-org.mjs";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const TOKEN = "s".repeat(43);
const jar = (o) => ({ get: (k) => (k in o ? { value: o[k] } : undefined) });
const context = (path) => ({ params: Promise.resolve({ path }) });

test("the tab's own header wins; 'none' means the browser's sign-in; then the address hint, the navigation cookie, the last page", () => {
  const h = (o) => new Headers(o), q = (s = "") => new URLSearchParams(s);
  assert.deepEqual(tabOrgFor(h({ "x-pulse-tab-org": A }), q(`_o=${B}`), jar({ pulse_view: B })), { org: A, from: "header", doc: false, nav: false });
  assert.equal(tabOrgFor(h({ "x-pulse-tab-org": "none" }), q(), jar({ pulse_view: B })).org, null);
  assert.equal(tabOrgFor(h({ "x-pulse-tab-org": "not-a-company" }), q(), jar({ pulse_view: B })).org, null);
  assert.equal(tabOrgFor(h({}), q(`_o=${B}`), jar({ pulse_view: A })).org, B);
  assert.equal(tabOrgFor(h({}), q("_o=../../x"), jar({})).org, null);
  // The navigation cookie counts for a page load only (never for a picture or a call).
  assert.deepEqual(tabOrgFor(h({ "sec-fetch-dest": "document" }), q(), jar({ pulse_nav: B, pulse_view: A })), { org: B, from: "nav", doc: true, nav: true });
  assert.equal(tabOrgFor(h({ "sec-fetch-dest": "image" }), q(), jar({ pulse_nav: B, pulse_view: A })).org, A);
  assert.equal(tabOrgFor(h({}), q(), jar({})).org, null);
});

test("a page load uses the navigation cookie once and remembers the company it was drawn in", () => {
  const tab = tabOrgFor(new Headers({ "sec-fetch-mode": "navigate" }), new URLSearchParams(), jar({ pulse_nav: B }));
  const cookies = tabCookies(tab, true);
  assert.ok(cookies.some((c) => /^pulse_nav=; .*Max-Age=0/.test(c)));
  assert.ok(cookies.some((c) => c.startsWith(`pulse_view=${B}; `) && c.includes("HttpOnly") && c.includes("SameSite=Lax")));
  assert.deepEqual(tabCookies(tabOrgFor(new Headers({}), new URLSearchParams(), jar({ pulse_view: A })), true), []);
  assert.equal(renderedOrg([{ id: A, current: false }, { id: B, current: true }]), B);
  assert.equal(renderedOrg([{ id: "x", current: true }]), null);
});

test("the API gets the tab's company with the session and never the `_o` hint", async () => {
  assert.equal(forwardSearch(`https://pulse.test/api/v0/chats/events?after=5&_o=${A}`), "?after=5");
  assert.equal(forwardSearch("https://pulse.test/api/v0/tasks?x=1"), "?x=1");
  const seen = [];
  const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn: "password", own: false }),
    fetchImpl: async (url, options) => { seen.push({ url, headers: options.headers }); return Response.json({ ok: true }); } });
  await proxy(new Request(`https://pulse.test/api/v0/docs/x?_o=${A}`, { headers: { cookie: `pulse_session=${TOKEN}`, "x-pulse-org": A } }), context(["docs", "x"]));
  assert.equal(seen[0].headers["x-pulse-org"], A);
  assert.equal(seen[0].headers["x-pulse-session"], TOKEN);
  assert.ok(!String(seen[0].url).includes("_o="));
  // Signed out, nothing is asked for any company; a value that is no company id is never passed on.
  await proxy(new Request("https://pulse.test/api/v0/auth/branding", { headers: { "x-pulse-org": A } }), context(["auth", "branding"]));
  assert.equal(seen[1].headers["x-pulse-org"], undefined);
  await proxy(new Request("https://pulse.test/api/v0/me", { headers: { cookie: `pulse_session=${TOKEN}`, "x-pulse-org": "' or 1=1" } }), context(["me"]));
  assert.equal(seen[2].headers["x-pulse-org"], undefined);
});

test("a company the account is not in: the API's Not found reaches the tab, marked so the tab forgets it, with no data", async () => {
  const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn: "password", own: false }),
    fetchImpl: async () => new Response(JSON.stringify({ error: "Not found", code: "tab_org_unavailable" }), { status: 404, headers: { "content-type": "application/json", "x-pulse-tab": "closed" } }) });
  const r = await proxy(new Request("https://pulse.test/api/v0/docs/x", { headers: { cookie: `pulse_session=${TOKEN}`, "x-pulse-org": B } }), context(["docs", "x"]));
  assert.equal(r.status, 404);
  assert.equal(r.headers.get("x-pulse-tab"), "closed");
  assert.deepEqual(await r.json(), { error: "Not found", code: "tab_org_unavailable" });
});

test("sign-out of one company keeps the sign-in cookie; sign-out of all ends it and the last page's company", async () => {
  const run = async (answer) => {
    const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn: "password", own: false }), fetchImpl: async () => Response.json(answer) });
    const r = await proxy(new Request("https://pulse.test/api/v0/auth/sign-out", { method: "POST", headers: { cookie: `pulse_session=${TOKEN}`, origin: "https://pulse.test", host: "pulse.test", "x-pulse-org": B }, body: "{}" }), context(["auth", "sign-out"]));
    return r.headers.getSetCookie();
  };
  assert.deepEqual(await run({ ok: true, signedOut: false, closed: B }), []);
  const all = await run({ ok: true, signedOut: true });
  assert.ok(all.some((c) => c.startsWith("pulse_session=; ") && c.includes("Max-Age=0")));
  assert.ok(all.some((c) => c.startsWith("pulse_view=; ") && c.includes("Max-Age=0")));
});

test("the tab script keeps the tab's company and marks its calls, pictures and streams", async () => {
  const store = new Map(), calls = [], cookies = [];
  let replaced = false;
  class FakeES { constructor(u) { this.url = u; } }
  class El { setAttribute(n, v) { this[n] = v; } }
  const sandbox = { URL, Headers, Date, String, Object, Array, Promise,
    location: { href: "https://pulse.test/docs", origin: "https://pulse.test", pathname: "/docs", protocol: "https:", replace() { replaced = true; }, reload() {} },
    document: { currentScript: { getAttribute: () => A }, documentElement: { style: {} }, set cookie(v) { cookies.push(v); }, addEventListener() {} },
    XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} }, Element: El, EventSource: FakeES,
    addEventListener() {} };
  sandbox.window = sandbox;
  sandbox.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  sandbox.fetch = async (i, init) => { calls.push({ i, init }); return { status: 200, headers: new Headers() }; };
  vm.runInNewContext(TAB_SHIM, sandbox);
  assert.equal(store.get("pulse.tab.org"), A);                       // the page's company is this tab's now
  await sandbox.fetch("/api/v0/me");
  assert.equal(calls[0].init.headers.get("x-pulse-tab-org"), A);
  await sandbox.fetch("https://elsewhere.example/x");
  assert.equal(calls[1].init, undefined);                             // never told to other sites
  await sandbox.fetch("/api/v0/account/tab-open", { headers: { "x-pulse-tab-org": "none" } });
  assert.equal(new Headers(calls[2].init.headers).get("x-pulse-tab-org"), "none");
  assert.equal(new sandbox.EventSource("/api/v0/chats/events").url, `/api/v0/chats/events?_o=${A}`);
  const img = new El(); img.setAttribute("src", "/photo/abc?v=1");
  assert.equal(img.src, `/photo/abc?v=1&_o=${A}`);
  const other = new El(); other.setAttribute("src", "/icons/a.png");
  assert.equal(other.src, "/icons/a.png");
  // A page drawn in another company than the tab's: the tab asks for its own once (navigation cookie, reload).
  sandbox.document.currentScript = { getAttribute: () => B };
  vm.runInNewContext(TAB_SHIM, sandbox);
  assert.equal(replaced, true);
  assert.ok(cookies.some((c) => c.startsWith(`pulse_nav=${A}; `)));
  assert.equal(store.get("pulse.tab.org"), A);
});
