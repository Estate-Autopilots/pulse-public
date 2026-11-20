// READABILITY GATE (QA-1): every rule fires on a page made to break it, and a clean page passes. Synthetic pages only.
//   ea-heavy node --test tests/e2e/readability-gate.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { CORNERS, auditScreen, axePath, consoleKind, fingerprint, gateContext, isLiveStream, stateOf } from "./readability-gate.mjs";
import { LAND_STATES, changedRoutes, knownTo, pageRoutes, runGate, screenKey, statesOf } from "./readability-run.mjs";

const page = (body, extra = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Fixture</title><style>body{margin:0;font:16px/1.4 sans-serif;color:#111;background:#fff} main{padding:16px}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee} button{background:#2a2a2a;color:#fff;border:1px solid #888} a{color:#9cf}}</style>${extra}</head>
<body><main><h1>Fixture screen</h1>${body}</main></body></html>`;
const PAGES = {
  "/good": page(`<p>Plain words a person can read.</p><button style="min-width:48px;min-height:48px">Save</button>
    <a href="/good">Back to the list</a>`),
  "/bad": page(`<div style="width:1700px">This row is wider than the window.</div>
    <p style="font-size:9px">tiny words here</p>
    <p>Total: undefined</p><p>tasks.list.empty</p><p>Due Invalid Date</p>
    <div><button style="width:14px;height:14px;padding:0;border:0">a</button><button style="width:14px;height:14px;padding:0;border:0">b</button></div>
    <p style="color:#c8c8c8">faint words on white</p>
    <div style="background:linear-gradient(90deg,#ffffff,#f4f4f4);padding:8px"><span style="color:#e6e6e6">pale words over a gradient</span></div>
    <script>console.error("boom from the fixture")</script>`),
  "/dark": page(`<p style="color:#1c1c1c;background:#141414">words as dark as the page</p>
    <div style="background:#ffffff;width:240px;height:80px;color:#000">a white card</div>`, "<style>body{background:#111;color:#eee}</style>"),
  "/white": page(`<p>Words on a page that never turns dark.</p>`, "<style>body{background:#fff !important;color:#111 !important}</style>"),
  "/modal": page(`<p>Words above a long page.</p><div style="height:2400px"></div><p>The end of the page.</p>
    <button aria-haspopup="dialog" aria-expanded="false" style="position:fixed;top:8px;right:8px;min-width:48px;min-height:48px"
      onclick="document.getElementById('d').hidden=false;document.body.style.overflow='hidden';this.setAttribute('aria-expanded','true')">Alerts</button>
    <div id="d" role="dialog" aria-label="Alerts" hidden style="position:fixed;inset:0;background:#fff;padding:16px">Nothing new.</div>`),
  "/menu": page(`<p>Some words under the menu.</p>
    <button aria-haspopup="menu" aria-expanded="false" onclick="document.getElementById('m').hidden=false;this.setAttribute('aria-expanded','true')">Open menu</button>
    <div id="m" role="menu" hidden style="position:fixed;left:0;right:0;top:120px;height:2000px;overflow:hidden;background:#eee">
      <a href="/menu">First</a><div style="height:1900px"></div><a href="/menu">Last item nobody can reach</a></div>`),
  // The machine's network changing under the browser, and React's dev-only attribute notice: not the screen's fault.
  "/noise": page(`<p>Words on a page whose machine changed its network.</p>
    <script>console.error("Failed to load resource: net::ERR_NETWORK_CHANGED");
    console.error("A tree hydrated but some attributes of the server rendered HTML didn't match the client properties. This won't be patched up.");
    console.error("boom from the fixture")</script>`),
  "/hydrate": page(`<p>Words on a page that hydrated with other attributes.</p>
    <script>console.error("A tree hydrated but some attributes of the server rendered HTML didn't match the client properties. This won't be patched up.")</script>`),
  // A "new" dot that pulses 7 rounds of 2 s, and a live stream (the server never answers it: the gate must).
  "/live": page(`<p>Words beside a pulsing dot.</p><span class="dot" aria-hidden="true"></span>
    <script>new EventSource("/chats/events")</script>`, "<style>.dot{display:inline-block;width:8px;height:8px;border-radius:4px;background:#c00;animation:pulse 2s ease-in-out 7}@keyframes pulse{50%{opacity:.2}}</style>"),
};
let server, base, browser, streamHits = 0;
before(async () => {
  server = createServer((req, res) => { if (req.url.endsWith("/events")) { streamHits++; return; } // a stream that never answers
    const body = PAGES[new URL(req.url, "http://x").pathname]; res.writeHead(body ? 200 : 404, { "content-type": "text/html" }); res.end(body ?? "no"); });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
});
after(async () => { await browser?.close(); server?.close(); });

const run = async (path, stateName) => {
  const state = stateOf(stateName);
  const ctx = await gateContext(browser, { base, state });
  try { return await auditScreen(ctx, base + path, { state }); } finally { await ctx.close(); }
};
const rules = (r) => new Set(r.findings.filter((f) => f.kind === "certain").map((f) => f.rule));

test("axe-core is found in the workspace", () => { assert.ok(axePath()?.endsWith("axe.min.js")); });

test("a clean page has no certain finding, in either theme and at 130% text", async () => {
  for (const s of ["363-light", "1440-dark", "363-dark-130"]) {
    const r = await run("/good", s);
    assert.deepEqual(r.findings.filter((f) => f.kind === "certain"), [], `${s}: ${JSON.stringify(r.findings, null, 1)}`);
    assert.deepEqual(r.errors, []);
  }
});

test("each broken thing is caught by its rule", async () => {
  const r = await run("/bad", "363-light");
  const got = rules(r);
  for (const want of ["R1", "R4", "R5", "R6", "R7", "R10", "R11"]) assert.ok(got.has(want), `${want} missing; got ${[...got]}: ${JSON.stringify(r.findings.map((f) => `${f.rule} ${f.detail}`), null, 1)}`);
  const junk = r.findings.filter((f) => f.rule === "R10").map((f) => f.detail).join(" ");
  assert.match(junk, /undefined/); assert.match(junk, /raw message key/); assert.match(junk, /Invalid Date/);
  assert.ok(r.findings.some((f) => f.rule === "R11" && /boom from the fixture/.test(f.detail)));
  // At 130% text, tiny text is no longer judged by the 12 px rule (it is bigger by design), the rest still is.
  const big = rules(await run("/bad", "363-light-130"));
  assert.ok(big.has("R1") && big.has("R10"));
});

test("dark mode: text the colour of its background and a white box (R13)", async () => {
  const r = await run("/dark", "1440-dark");
  const r13 = r.findings.filter((f) => f.rule === "R13").map((f) => f.detail).join(" | ");
  assert.match(r13, /colour of its background/); assert.match(r13, /light box/);
  assert.ok(!rules(await run("/dark", "1440-light")).has("R13"));
  // A page left white in dark mode.
  const white = await run("/white", "363-dark");
  assert.ok(white.findings.some((f) => f.rule === "R13" && f.where.startsWith("body")), JSON.stringify(white.findings, null, 1));
});

test("an open menu whose last item cannot be reached (R15)", async () => {
  const r = await run("/menu", "1440-light");
  assert.ok(r.findings.some((f) => f.rule === "R15" && /Open menu/.test(f.detail)), JSON.stringify(r.findings, null, 1));
});

test("a modal that locks the page's scroll flags nothing behind it", async () => {
  const r = await run("/modal", "363-light");
  assert.deepEqual(r.findings.filter((f) => f.rule === "R15"), []);
});

test("states, fingerprints and the screens a diff touches", () => {
  assert.equal(CORNERS.length, 5);
  assert.deepEqual(stateOf("363-dark-130"), { name: "363-dark-130", width: 363, height: 800, theme: "dark", text: 1.3 });
  assert.deepEqual(stateOf("1440x700-light"), { name: "1440x700-light", width: 1440, height: 700, theme: "light", text: 1 });
  assert.throws(() => stateOf("big-dark"));
  assert.equal(fingerprint("/people/0b0e6a52-1f43-4c5e-9a8e-0e7f7d1a2b3c", "363-light", { rule: "R7", where: 'p "12 tasks"' }), '/people/:id | 363-light | R7 | p "# tasks"');
  assert.equal(fingerprint("/tasks", "363-light", { rule: "R7", where: 'span "Due 19 Nov, Tue"' }), fingerprint("/tasks", "363-light", { rule: "R7", where: 'span "Due 2 Dec, Wed"' }));
  assert.equal(fingerprint("/tasks", "363-light", { rule: "R7", where: 'i "New: 9+"' }), fingerprint("/tasks", "363-light", { rule: "R7", where: 'i "New: 3"' }));
  assert.equal(fingerprint("/tasks", "363-light", { rule: "R7", where: 'i "Updated today"' }), "/tasks | 363-light | R7 | i \"Updated <date>\"");
  assert.equal(fingerprint("/tasks", "363-light", { rule: "R4", where: ".work3-module__okylgG__lenses > button:nth-child(2) > span" }), "/tasks | 363-light | R4 | .work#-module__lenses > button:nth-child(#) > span");
  assert.deepEqual(changedRoutes(["apps/web/app/tasks/page.tsx", "apps/web/app/(app)/people/[id]/tab.tsx", "apps/web/app/settings/roles/x.test.mjs", "db/x.sql"]), ["/tasks", "/people"]);
  assert.deepEqual(changedRoutes(["apps/web/app/components/Card.tsx"]), ["/dashboard", "/tasks", "/people", "/chats", "/settings"]);
  assert.deepEqual(changedRoutes(["apps/web/app/api/x/route.ts"]), []);
  // A folder with no page of its own maps to the nearest page above it; none at all: nothing to open.
  assert.deepEqual(changedRoutes(["apps/web/app/tasks/views/Board.tsx", "apps/web/app/kit/parts/x.tsx", "apps/web/app/settings/roles/x.tsx"], 8, new Set(["/tasks", "/settings/roles"])), ["/tasks", "/settings/roles"]);
});

test("motion ends at once and a live stream is answered empty: no wait, no false R11", async () => {
  const t = Date.now();
  const r = await run("/live", "363-light");
  assert.ok(Date.now() - t < 12_000, `took ${Date.now() - t} ms`);
  assert.deepEqual(r.findings.filter((f) => f.kind === "certain"), [], JSON.stringify(r.findings, null, 1));
  assert.equal(streamHits, 0, "the live stream reached the server");
  assert.ok(isLiveStream("http://x/api/v0/chats/events") && isLiveStream("http://x/a", { accept: "text/event-stream" }) && !isLiveStream("http://x/api/v0/tasks"));
});

test("the machine's network changing and React's dev-only attribute notice are warnings, not certain (QA-1F)", async () => {
  // Network changed: every R11 of that screen-state is a warning and the state is marked not judged.
  const r = await run("/noise", "363-light");
  assert.deepEqual(r.findings.filter((f) => f.kind === "certain"), [], JSON.stringify(r.findings, null, 1));
  assert.ok(r.findings.some((f) => f.rule === "R11" && f.kind === "warn" && /ERR_NETWORK_CHANGED/.test(f.detail)));
  assert.ok(r.findings.some((f) => f.rule === "R11" && f.kind === "warn" && /boom from the fixture/.test(f.detail)));
  assert.ok(r.errors.some((e) => /network changed/.test(e)), JSON.stringify(r.errors));
  // The hydration notice alone: a warning, the screen-state judged as usual.
  const h = await run("/hydrate", "363-light");
  assert.deepEqual(h.findings.filter((f) => f.kind === "certain"), [], JSON.stringify(h.findings, null, 1));
  assert.ok(h.findings.some((f) => f.rule === "R11" && f.kind === "warn") && h.errors.length === 0, JSON.stringify(h));
  // Any other console error stays certain (the /bad page's "boom" is checked in "each broken thing").
  assert.equal(consoleKind("Failed to load resource: the server responded with a status of 500 (Internal Server Error)"), "certain");
  assert.equal(consoleKind("Failed to load resource: net::ERR_INTERNET_DISCONNECTED"), "warn");
  assert.equal(consoleKind("Hydration failed because the server rendered text didn't match the client."), "certain");
});

test("land states, page routes and baseline screens", () => {
  assert.deepEqual(LAND_STATES.map((s) => s.name), ["363-light", "363-dark", "1440-light", "1440-dark"]);
  assert.equal(statesOf("land"), LAND_STATES); assert.equal(statesOf("corners"), CORNERS);
  assert.deepEqual([...pageRoutes(["apps/web/app/(app)/tasks/page.tsx", "apps/web/app/people/[id]/page.tsx", "apps/web/app/people/list.tsx", "apps/web/app/page.tsx"])], ["/tasks", "/people", "/"]);
  assert.equal(screenKey("/people/0b0e6a52-1f43-4c5e-9a8e-0e7f7d1a2b3c", "363-dark"), "/people/:id | 363-dark");
  // Known: the exact finding, or the same screen, rule and element in another state; not another screen's or rule's.
  const known = knownTo({ findings: { '/tasks | 1440-light | R7 | i "New: #"': {} } });
  assert.ok(known('/tasks | 1440-light | R7 | i "New: #"') && known('/tasks | 363-dark | R7 | i "New: #"'));
  assert.ok(!known('/people | 1440-light | R7 | i "New: #"') && !known('/tasks | 1440-light | R4 | i "New: #"'));
  // On two screens: the shell, known on every screen.
  const shell = knownTo({ findings: { '/tasks | 363-dark | R4 | i[aria-label="New: #"]': {}, '/settings | 363-dark | R4 | i[aria-label="New: #"]': {} } });
  assert.ok(shell('/people | 363-light | R4 | i[aria-label="New: #"]') && !shell('/people | 363-light | R7 | i[aria-label="New: #"]'));
});

test("runGate: the baseline, a screen it never looked at, a new page, and the time budget", async () => {
  const state = [stateOf("363-light")], quiet = () => {};
  const opts = { base, routes: ["/bad"], states: state, axe: false, open: false, log: quiet };
  const first = await runGate(browser, opts);
  assert.ok(first.fresh.length > 0);
  const known = Object.fromEntries(first.fresh.map((f) => [f.fp, { rule: f.rule }]));
  // Every finding known: nothing new.
  assert.equal((await runGate(browser, { ...opts, baseline: { screens: [screenKey("/bad", "363-light")], findings: known } })).fresh.length, 0);
  // The baseline never looked at /bad: an old page is reported, not blocking; a new page blocks.
  const old = await runGate(browser, { ...opts, baseline: { screens: ["/good | 363-light"], findings: {} }, existed: () => true });
  assert.equal(old.fresh.length, 0); assert.equal(old.unbaselined.length, first.fresh.length);
  const fresh = await runGate(browser, { ...opts, baseline: { screens: ["/good | 363-light"], findings: {} }, existed: () => false });
  assert.equal(fresh.fresh.length, first.fresh.length);
  // Out of time: listed, never checked, never failed.
  const late = await runGate(browser, { ...opts, deadline: Date.now() - 1 });
  assert.deepEqual([late.records.length, late.fresh.length, late.skipped], [0, 0, ["/bad @ 363-light"]]);
});
