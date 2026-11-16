// SPEED-NET: the shell's start-up reads in one round trip. Which addresses the boot may read, how the web server answers
// them (as the person, in the tab's company, JSON only), and how the page hands them out: once fresh, never after a save,
// never a "tab closed" answer, the same ask shared, everything else untouched.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { BOOT_MAX, BOOT_SHIM, bootAnswer, bootKey, bootKeys, railKey, shellBootKeys } from "./boot.mjs";
import { createApiProxy, v0ProxyOptions } from "../api/proxy.mjs";

const A = "11111111-1111-4111-8111-111111111111";
const TOKEN = "s".repeat(43);
const context = (path) => ({ params: Promise.resolve({ path }) });

test("the boot reads the shell's start-up addresses only, and the rail's read in the rail's own spelling", () => {
  for (const k of ["whats-new/unseen", "companion", "companion?visible=0", "presence?touch=1", "agreements/policies?due=1", "companion/updates", "mailbox"]) assert.equal(bootKey(k), k);
  for (const k of ["", "notices/read-all", "companion/updates?since=x", "tasks", "../me", "companion?visible=1", "auth/sign-out", "telemetry", "boot", null, 5]) assert.equal(bootKey(k), null, String(k));
  const rail = railKey("/me/approvals", "?tab=work");
  assert.equal(rail, "intelligence?path=%2Fme%2Fapprovals&tab=work");
  assert.equal(bootKey(rail), rail);
  assert.equal(railKey("/tasks", "?task=abc"), "intelligence?path=%2Ftasks&tab=&subject=abc");
  assert.equal(bootKey(railKey("/tasks", "?task=abc")), railKey("/tasks", "?task=abc"));
  assert.equal(bootKey("intelligence?tab=&path=%2Fx"), null, "another order is not the rail's ask");
  assert.equal(bootKey("intelligence?path=%2Fx&tab=&evil=1"), null);
  assert.equal(bootKey("intelligence?path=x&tab="), null);
  assert.equal(bootKey("intelligence?path=%2Fx&tab=&tab=y"), null);
  const many = new URLSearchParams();
  for (const k of ["mailbox", "mailbox", "nope", ...Array.from({ length: 30 }, (_, i) => railKey(`/p${i}`, ""))]) many.append("k", k);
  const keys = bootKeys(many);
  assert.equal(keys.length, BOOT_MAX);
  assert.equal(keys.filter((k) => k === "mailbox").length, 1);
});

test("the shell's keys follow what layout.tsx draws for the person", () => {
  const member = shellBootKeys({ staff: true });
  for (const k of ["companion", "presence?touch=1", "freshness", "companion/updates", "work/companion", "agreements/policies?due=1", "tasks/reviews/count"]) assert.ok(member.includes(k), k);
  assert.ok(!member.includes("mailbox"));
  assert.ok(shellBootKeys({ staff: true, admin: true }).includes("mailbox"));
  const client = shellBootKeys({ staff: false });
  assert.deepEqual(client, ["whats-new/unseen", "companion/notification-settings", "telemetry/settings", "tasks/reviews/count"]);
  const off = shellBootKeys({ staff: true, off: ["tasks", "hr"] });
  assert.ok(!off.includes("work/companion") && !off.includes("tasks/reviews/count") && !off.includes("agreements/policies?due=1"));
  for (const k of shellBootKeys({ staff: true, admin: true })) assert.equal(bootKey(k), k, `${k} is readable by the boot`);
});

test("the answer carries each JSON part as the API gave it; failures and other types are left for the page to ask", async () => {
  const answer = await bootAnswer(["a", "b", "c", "d", "e"], async (k) => {
    if (k === "a") return new Response('{"n":1}', { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    if (k === "b") return new Response('{"error":"Use your individual Pulse account"}', { status: 403, headers: { "content-type": "application/json" } });
    if (k === "c") return new Response("<html>", { status: 502, headers: { "content-type": "text/html" } });
    if (k === "d") throw new Error("refused");
    return new Response('{"error":"Not found"}', { status: 404, headers: { "content-type": "application/json", "x-pulse-tab": "closed" } });
  });
  assert.deepEqual(answer, { v: 1, r: { a: { s: 200, b: '{"n":1}' }, b: { s: 403, b: '{"error":"Use your individual Pulse account"}' }, e: { s: 404, b: '{"error":"Not found"}', t: "closed" } } });
});

test("a boot asks the API for at most five parts at once (its pool is shared with everyone's calls)", async () => {
  let now = 0, most = 0;
  const keys = Array.from({ length: 12 }, (_, i) => `k${i}`);
  const answer = await bootAnswer(keys, async (k) => { now++; most = Math.max(most, now); await new Promise((r) => setTimeout(r, 5)); now--; return json({ k }); });
  assert.equal(most, 5);
  assert.equal(Object.keys(answer.r).length, 12);
});

test("GET /api/v0/boot asks the API for each allowed part as this person in this tab's company, and nothing else", async () => {
  const seen = [];
  const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn: "password", own: false }),
    fetchImpl: async (url, options) => { seen.push({ url, method: options.method, headers: options.headers }); return Response.json({ at: url }); } });
  const q = new URLSearchParams();
  for (const k of ["whats-new/unseen", "presence?touch=1", "notices/read-all", "../../me"]) q.append("k", k);
  const r = await proxy(new Request(`https://pulse.test/api/v0/boot?${q}`, { headers: { cookie: `pulse_session=${TOKEN}`, "x-pulse-org": A, "cf-connecting-ip": "203.0.113.9" } }), context(["boot"]));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.match(r.headers.get("server-timing") ?? "", /^app;dur=\d+$/);
  assert.deepEqual(seen.map((s) => s.url).sort(), ["http://127.0.0.1:8081/api/v0/presence?touch=1", "http://127.0.0.1:8081/api/v0/whats-new/unseen"]);
  for (const s of seen) {
    assert.equal(s.method, "GET");
    assert.equal(s.headers["x-pulse-session"], TOKEN);
    assert.equal(s.headers["x-pulse-org"], A);
    assert.equal(s.headers["x-pulse-client-ip"], "203.0.113.9");
  }
  const body = await r.json();
  assert.deepEqual(Object.keys(body.r).sort(), ["presence?touch=1", "whats-new/unseen"]);
  assert.equal(JSON.parse(body.r["whats-new/unseen"].b).at, "http://127.0.0.1:8081/api/v0/whats-new/unseen");
  // Signed out: refused like any call, and the API is never asked.
  const before = seen.length;
  const out = await proxy(new Request(`https://pulse.test/api/v0/boot?${q}`), context(["boot"]));
  assert.equal(out.status, 401);
  assert.equal(seen.length, before);
  // A POST is no boot (and fails the origin check like any POST from elsewhere).
  const post = await proxy(new Request(`https://pulse.test/api/v0/boot?${q}`, { method: "POST", headers: { cookie: `pulse_session=${TOKEN}`, origin: "https://evil.test" }, body: "{}" }), context(["boot"]));
  assert.equal(post.status, 403);
});

test("every proxied JSON answer says how long the server took (Server-Timing app;dur)", async () => {
  const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn: "password", own: false }), fetchImpl: async () => Response.json({ ok: true }) });
  const r = await proxy(new Request("https://pulse.test/api/v0/tasks/reviews/count", { headers: { cookie: `pulse_session=${TOKEN}` } }), context(["tasks", "reviews", "count"]));
  assert.match(r.headers.get("server-timing") ?? "", /^app;dur=\d+$/);
  assert.deepEqual(await r.json(), { ok: true });
});

/** The page's script in a fake window: `network(url, init)` answers the calls that leave the page. */
function page({ keys, rail = false, search = "", path = "/me/approvals", hidden = false, network, settings = null, reloading = false, webdriver = false, force = null }) {
  const calls = [];
  let clock = 1_000_000;
  const timers = [];
  const window = {
    navigator: { webdriver },
    fetch: async (u, init) => { calls.push({ url: String(u), method: init?.method ?? "GET" }); return network(String(u), init); },
  };
  const sandbox = {
    window, Response, Headers, URL, URLSearchParams, Promise, JSON, Date: { now: () => clock },
    performance: { now: () => clock },
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; },
    location: { href: `https://pulse.test${path}${search}`, origin: "https://pulse.test", pathname: path, search },
    sessionStorage: { getItem: (k) => (k === "pulse.telemetry.settings" && settings ? JSON.stringify(settings) : null) },
    localStorage: { getItem: (k) => (k === "pulse.boot" ? force : null) },
    document: { documentElement: { style: { visibility: reloading ? "hidden" : "" } }, visibilityState: hidden ? "hidden" : "visible", currentScript: { getAttribute: (n) => (n === "data-keys" ? JSON.stringify(keys) : n === "data-rail" ? (rail ? "1" : null) : null) } },
  };
  vm.runInNewContext(BOOT_SHIM, sandbox);
  return { fetch: (u, init) => window.fetch(u, init), calls, boot: window.__pulseBoot,
    tick: (ms) => { clock += ms; for (const t of timers.splice(0)) if (t.at <= clock) t.fn(); else timers.push(t); } };
}
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });
const bootOf = (r) => json({ v: 1, r: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { s: v.s ?? 200, b: JSON.stringify(v.b ?? {}), ...(v.t ? { t: v.t } : {}) }])) });

test("the page asks once for the shell's start-up reads and hands each one out without a round trip", async () => {
  const p = page({ keys: ["whats-new/unseen", "companion", "freshness"], rail: true, search: "?tab=work",
    network: async (u) => u.startsWith("/api/v0/boot?") ? bootOf({ "whats-new/unseen": { b: { n: 3 } }, companion: { b: { day: 1 } }, [railKey("/me/approvals", "?tab=work")]: { b: { cards: [] } } }) : json({ net: u }) });
  assert.equal(p.calls.length, 1);
  const asked = new URL(p.calls[0].url, "https://pulse.test").searchParams.getAll("k");
  assert.deepEqual(asked, ["whats-new/unseen", "companion", "freshness", "intelligence?path=%2Fme%2Fapprovals&tab=work"]);
  const a = await p.fetch("/api/v0/whats-new/unseen", { cache: "no-store" });
  assert.equal(a.headers.get("x-pulse-boot"), "1");
  assert.deepEqual(await a.json(), { n: 3 });
  const rail = await p.fetch("/api/v0/intelligence?path=%2Fme%2Fapprovals&tab=work", { cache: "no-store" });
  assert.deepEqual(await rail.json(), { cards: [] });
  // Asked twice at once (two parts of the shell): both from the boot.
  const [c1, c2] = await Promise.all([p.fetch("/api/v0/companion"), p.fetch("/api/v0/companion")]);
  assert.deepEqual([await c1.json(), await c2.json()], [{ day: 1 }, { day: 1 }]);
  // Not in the boot's answer (the API failed it): the page asks the network.
  const f = await p.fetch("/api/v0/freshness");
  assert.deepEqual(await f.json(), { net: "/api/v0/freshness" });
  // Not a start-up read: untouched.
  await p.fetch("/api/v0/tasks/home");
  assert.deepEqual(p.calls.map((c) => c.url).slice(1), ["/api/v0/freshness", "/api/v0/tasks/home"]);
  assert.equal(p.boot.served, 4);
});

test("the boot's answers are handed out only while fresh, and never after something was saved", async () => {
  const p = page({ keys: ["whats-new/unseen", "presence?touch=1", "mailbox"], network: async (u, init) => u.startsWith("/api/v0/boot?")
    ? bootOf({ "whats-new/unseen": { b: { n: 3 } }, "presence?touch=1": { b: { p: 1 } }, mailbox: { b: { m: 1 } } }) : json({ net: u, m: init?.method ?? "GET" }) });
  await (await p.fetch("/api/v0/whats-new/unseen")).json();
  p.tick(11000);
  assert.deepEqual(await (await p.fetch("/api/v0/presence?touch=1")).json(), { net: "/api/v0/presence?touch=1", m: "GET" }, "older than 10 s: the network");
  const q = page({ keys: ["whats-new/unseen"], network: async (u, init) => u.startsWith("/api/v0/boot?") ? bootOf({ "whats-new/unseen": { b: { n: 3 } } }) : json({ net: u, m: init?.method ?? "GET" }) });
  await q.fetch("/api/v0/whats-new/seen", { method: "POST", body: "{}" });
  assert.deepEqual(await (await q.fetch("/api/v0/whats-new/unseen")).json(), { net: "/api/v0/whats-new/unseen", m: "GET" }, "after a save: the network");
  // The collector's own batches and the push subscription are no save of the page's data.
  const t = page({ keys: ["whats-new/unseen"], network: async (u) => u.startsWith("/api/v0/boot?") ? bootOf({ "whats-new/unseen": { b: { n: 3 } } }) : json({ net: u }) });
  await t.fetch("/api/v0/telemetry", { method: "POST", body: "{}" });
  await t.fetch("/api/v0/companion/web-push", { method: "POST", body: "{}" });
  assert.deepEqual(await (await t.fetch("/api/v0/whats-new/unseen")).json(), { n: 3 });
});

test("a closed tab's company, a server error or a failed boot: the page asks the network and sees the real answer", async () => {
  const p = page({ keys: ["companion", "freshness", "mailbox"], network: async (u) => u.startsWith("/api/v0/boot?")
    ? bootOf({ companion: { s: 404, b: { error: "Not found" }, t: "closed" }, freshness: { s: 503, b: {} }, mailbox: { s: 403, b: { error: "Admins only" } } }) : json({ net: u }) });
  assert.deepEqual(await (await p.fetch("/api/v0/companion")).json(), { net: "/api/v0/companion" });
  assert.deepEqual(await (await p.fetch("/api/v0/freshness")).json(), { net: "/api/v0/freshness" });
  const refused = await p.fetch("/api/v0/mailbox");
  assert.equal(refused.status, 403, "a refusal is the API's answer, handed out as it is");
  const down = page({ keys: ["companion"], network: async (u) => { if (u.startsWith("/api/v0/boot?")) throw new TypeError("offline"); return json({ net: u }); } });
  assert.deepEqual(await (await down.fetch("/api/v0/companion")).json(), { net: "/api/v0/companion" });
  // The boot never answers: after 5 s the page stops waiting for it.
  let hang;
  const stuck = page({ keys: ["companion"], network: async (u) => u.startsWith("/api/v0/boot?") ? new Promise((r) => { hang = r; }) : json({ net: u }) });
  const waiting = stuck.fetch("/api/v0/companion");
  stuck.tick(5000);
  assert.deepEqual(await (await waiting).json(), { net: "/api/v0/companion" });
  assert.equal(stuck.boot.late, true);
  hang(json({ v: 1, r: {} }));
});

test("a hidden tab asks as the parts would (no office check, no 'I am here'); fresh telemetry settings are not asked again", () => {
  const p = page({ keys: ["companion", "presence?touch=1", "telemetry/settings"], hidden: true, settings: { at: 1_000_000 - 1000, s: {} }, network: async () => json({ v: 1, r: {} }) });
  assert.deepEqual(new URL(p.calls[0].url, "https://pulse.test").searchParams.getAll("k"), ["companion?visible=0", "presence"]);
  const none = page({ keys: [], network: async () => json({}) });
  assert.equal(none.calls.length, 0, "nothing to read: no boot call");
  // ORG-PER-TAB hid the page to open it again in the tab's own company: no boot for a page that is going away.
  const leaving = page({ keys: ["companion"], reloading: true, network: async () => json({}) });
  assert.equal(leaving.calls.length, 0);
  assert.equal(leaving.boot, undefined);
});

test("the same shell read asked twice at once is one request; a moment later it is still the same answer; a save forgets it", async () => {
  let n = 0;
  const p = page({ keys: [], network: async (u) => json({ n: ++n, u }, 200, { "server-timing": "app;dur=12" }) });
  const [a, b] = await Promise.all([p.fetch("/api/v0/whats-new/unseen"), p.fetch("/api/v0/whats-new/unseen")]);
  assert.deepEqual([(await a.json()).n, (await b.json()).n], [1, 1]);
  assert.equal(a.headers.get("server-timing"), "app;dur=12", "the first asker keeps the server's timing");
  assert.equal(b.headers.get("x-pulse-shared"), "1");
  p.tick(1000);
  assert.equal((await (await p.fetch("/api/v0/whats-new/unseen")).json()).n, 1);
  p.tick(1500);
  assert.equal((await (await p.fetch("/api/v0/whats-new/unseen")).json()).n, 2, "after 2 s: asked again");
  await p.fetch("/api/v0/whats-new/seen", { method: "POST", body: "{}" });
  assert.equal((await (await p.fetch("/api/v0/whats-new/unseen")).json()).n, 4, "after a save: asked again");
  // Not a shell read, with a body, a signal or headers of its own: never shared.
  await Promise.all([p.fetch("/api/v0/tasks/home"), p.fetch("/api/v0/tasks/home")]);
  await Promise.all([p.fetch("/api/v0/notices", { signal: { aborted: false } }), p.fetch("/api/v0/notices", { signal: { aborted: false } })]);
  await Promise.all([p.fetch("/api/v0/notices", { headers: { range: "bytes=0-1" } }), p.fetch("/api/v0/notices", { headers: { range: "bytes=0-1" } })]);
  assert.equal(n, 10);
});

test("a call with its own signal takes the boot's answer (not once it gave up) but is never shared", async () => {
  const p = page({ keys: ["companion"], rail: true, network: async (u) => u.startsWith("/api/v0/boot?") ? bootOf({ companion: { b: { day: 1 } }, [railKey("/me/approvals", "")]: { b: { cards: [1] } } }) : json({ net: u }) });
  const rail = await p.fetch(railKey("/me/approvals", "").replace(/^/, "/api/v0/"), { cache: "no-store", signal: { aborted: false } });
  assert.equal(rail.headers.get("x-pulse-boot"), "1");
  assert.deepEqual(await rail.json(), { cards: [1] });
  assert.deepEqual(await (await p.fetch("/api/v0/companion", { signal: { aborted: true } })).json(), { net: "/api/v0/companion" });
});

test("a browser driven by tests keeps single addresses (specs stand in for them) unless the boot is asked for; 'off' on one device", async () => {
  const net = async (u) => u.startsWith("/api/v0/boot?") ? bootOf({ companion: { b: { day: 1 } } }) : json({ net: u });
  const spec = page({ keys: ["companion"], webdriver: true, network: net });
  assert.equal(spec.calls.length, 0);
  assert.equal(spec.boot, undefined);
  assert.deepEqual(await (await spec.fetch("/api/v0/companion")).json(), { net: "/api/v0/companion" });
  const lab = page({ keys: ["companion"], webdriver: true, force: "on", network: net });
  assert.deepEqual(await (await lab.fetch("/api/v0/companion")).json(), { day: 1 });
  const off = page({ keys: ["companion"], force: "off", network: net });
  assert.equal(off.calls.length, 0);
  assert.equal(off.boot, undefined);
});

test("calls elsewhere and requests that are not plain strings pass through untouched", async () => {
  const p = page({ keys: ["companion"], network: async (u) => u.startsWith("/api/v0/boot?") ? bootOf({ companion: { b: { day: 1 } } }) : json({ net: u }) });
  await p.fetch("https://other.test/api/v0/companion");
  await p.fetch("/_next/static/x.js");
  await p.fetch("/cdn-cgi/trace");
  assert.deepEqual(p.calls.map((c) => c.url).slice(1), ["https://other.test/api/v0/companion", "/_next/static/x.js", "/cdn-cgi/trace"]);
});
