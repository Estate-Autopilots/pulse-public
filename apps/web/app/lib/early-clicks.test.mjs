// DOREVE-FIX: clicks made before the app's code starts are noted (never their text), answered with "Pulse is starting…",
// and reported once by the collector as `ui.early`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { EARLY_MAX, EARLY_SHIM, earlyReport } from "./early-clicks.mjs";

/** A small stand-in page: elements with closest(), a click listener list and performance.now(). */
function page() {
  let now = 400;
  const listeners = [];
  const appended = [];
  const docEl = { style: { cursor: "" }, appendChild: (n) => { appended.push(n); n.parentNode = docEl; }, removeChild: (n) => { appended.splice(appended.indexOf(n), 1); n.parentNode = null; } };
  const document = { documentElement: docEl, body: docEl, createElement: () => ({ style: {}, setAttribute() {}, textContent: "" }) };
  const el = (tagName, attrs = {}, interactive = true) => ({ tagName, getAttribute: (k) => attrs[k] ?? null, closest: () => (interactive ? el(tagName, attrs, interactive)._self : null), _self: null });
  const make = (tagName, attrs = {}, interactive = true) => { const e = el(tagName, attrs, interactive); e._self = interactive ? e : null; e.closest = () => e._self; return e; };
  const window = { addEventListener: (t, fn) => listeners.push(fn), removeEventListener: (t, fn) => listeners.splice(listeners.indexOf(fn), 1) };
  const ctx = vm.createContext({ window, document, performance: { now: () => now }, String, Math });
  vm.runInContext(EARLY_SHIM, ctx);
  return { window, docEl, appended, listeners, click: (target, at) => { now = at; for (const fn of [...listeners]) fn({ target }); }, make };
}

test("a click on a button before the app starts is noted (time, tag, rail id; no text) and answered", () => {
  const p = page();
  p.click(p.make("BUTTON", { "data-nav-id": "rail:work" }), 900);
  p.click(p.make("DIV", {}, false), 950);
  p.click(p.make("A", { href: "/tasks" }), 1200);
  const q = p.window.__pulseEarly;
  assert.deepEqual(JSON.parse(JSON.stringify(q.t)), [[900, "button", "rail:work"], [1200, "a", ""]], "a plain area is not a click on anything");
  assert.equal(p.appended.length, 1, "one 'Pulse is starting' line, shown once");
  assert.equal(p.docEl.style.cursor, "progress");
  q.off();
  assert.equal(p.appended.length, 0, "the app took over: the line is gone");
  assert.equal(p.docEl.style.cursor, "");
  assert.equal(p.listeners.length, 0, "and it stops listening");
  p.click(p.make("BUTTON"), 5000);
  assert.equal(q.t.length, 2, "nothing is noted after the app started");
});

test("at most EARLY_MAX clicks are kept", () => {
  const p = page();
  for (let i = 0; i < EARLY_MAX + 15; i++) p.click(p.make("BUTTON"), 500 + i);
  assert.equal(p.window.__pulseEarly.t.length, EARLY_MAX);
});

test("the report says how long the first click waited for the app", () => {
  assert.equal(earlyReport(null, 5000), null);
  assert.equal(earlyReport({ t: [] }, 5000), null);
  assert.deepEqual(earlyReport({ t: [[900, "button", "rail:work"], [1500, "a", ""], [21000, "button", ""]] }, 23000.4),
    { d: 22100, v: 3, x: { first: 900, last: 21000, ready: 23000, buttons: 2, nav: "rail:work" } });
});

test("the collector reports early clicks once, when it starts, and the root layout loads the probe first in <body>", () => {
  const collector = readFileSync(new URL("./telemetry.mjs", import.meta.url), "utf8");
  assert.match(collector, /import \{ earlyReport \} from "\.\/early-clicks\.mjs"/);
  assert.match(collector, /q\.off\?\.\(\); const r = earlyReport\(q, perf\.now\(\)\); if \(r\) emit\("ui\.early"/);
  const layout = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<body data-viewer=\{[^}]+\}>\{me\?\.person && process\.env\.PULSE_TELEMETRY !== "0" \? <EarlyClicks \/> : null\}/);
});
