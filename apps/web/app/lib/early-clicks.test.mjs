// DOREVE-FIX: clicks made before the app's code starts are noted (never their text), answered with "Pulse is starting…",
// and reported once by the collector as `ui.early`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { EARLY_FALLBACK_MS, EARLY_MAX, EARLY_REPLAY_MS, EARLY_SHIM, earlyReport } from "./early-clicks.mjs";

/** A small stand-in page: elements with closest(), a click listener list, performance.now(), timers run by hand and an
 *  address (on /chats). */
function page() {
  let now = 400;
  const listeners = [];
  const appended = [];
  const timers = [];
  const assigned = [];
  const docEl = { style: { cursor: "" }, appendChild: (n) => { appended.push(n); n.parentNode = docEl; }, removeChild: (n) => { appended.splice(appended.indexOf(n), 1); n.parentNode = null; } };
  const document = { documentElement: docEl, body: docEl, createElement: () => ({ style: {}, setAttribute() {}, textContent: "" }) };
  const el = (tagName, attrs = {}, interactive = true) => ({ tagName, getAttribute: (k) => attrs[k] ?? null, closest: () => (interactive ? el(tagName, attrs, interactive)._self : null), _self: null });
  const make = (tagName, attrs = {}, interactive = true) => { const e = el(tagName, attrs, interactive); e._self = interactive ? e : null; e.closest = () => e._self; e.isConnected = true; e.pressed = 0; e.click = () => { e.pressed++; }; return e; };
  const location = { href: "https://app.example/chats", origin: "https://app.example", pathname: "/chats", search: "", assign: (u) => assigned.push(u) };
  const window = { location, addEventListener: (t, fn) => listeners.push(fn), removeEventListener: (t, fn) => listeners.splice(listeners.indexOf(fn), 1) };
  const setTimeout = (fn, ms) => { timers.push({ fn, at: now + ms, done: false }); return timers.length; };
  const clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].done = true; };
  const ctx = vm.createContext({ window, document, performance: { now: () => now }, String, Math, URL, setTimeout, clearTimeout });
  vm.runInContext(EARLY_SHIM, ctx);
  /** Runs the timers due by `at` (the clock moves there). */
  const run = (at = now) => { now = Math.max(now, at); for (const t of timers) if (!t.done && t.at <= now) { t.done = true; t.fn(); } };
  const click = (target, at, over = {}) => { now = at; const e = { target, button: 0, prevented: false, preventDefault() { e.prevented = true; }, ...over }; for (const fn of [...listeners]) fn(e); return e; };
  return { window, docEl, appended, listeners, assigned, click, make, run, at: (t) => { now = t; } };
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

test("REPLAY-FIXES #2: a tap on a link to another page waits for the app, then the same link is pressed for real", () => {
  const p = page();
  const home = p.make("A", { href: "/dashboard", "data-nav-id": "rail:home" });
  const e = p.click(home, 600);
  assert.equal(e.prevented, true, "no full page load that the app's start could lose");
  assert.equal(p.appended.length, 1, "'Pulse is starting…' says the tap was taken");
  p.at(1200); p.window.__pulseEarly.off();
  assert.equal(home.pressed, 0, "pressed once the app has drawn (next tick), not inside off()");
  p.run(1200);
  assert.equal(home.pressed, 1, "the tap runs once the app is up");
  p.run(1200 + EARLY_FALLBACK_MS + 1);
  assert.deepEqual(p.assigned, [], "the browser's own fallback was called off");
  p.window.__pulseEarly.off(); p.run(99999);
  assert.equal(home.pressed, 1, "a second off() presses nothing again");
});

test("REPLAY-FIXES #2: if the app does not start, the browser opens the tapped link itself after a while", () => {
  const p = page();
  p.click(p.make("A", { href: "/tasks?view=mine" }), 700);
  p.run(700 + EARLY_FALLBACK_MS - 1);
  assert.deepEqual(p.assigned, []);
  p.run(700 + EARLY_FALLBACK_MS);
  assert.deepEqual(p.assigned, ["https://app.example/tasks?view=mine"]);
});

test("REPLAY-FIXES #2: a new tab, a modified click, another site, a download or this same page is left to the browser", () => {
  const p = page();
  for (const [attrs, over] of [[{ href: "/tasks", target: "_blank" }, {}], [{ href: "/tasks" }, { ctrlKey: true }], [{ href: "/tasks" }, { button: 1 }],
    [{ href: "https://example.com/" }, {}], [{ href: "/files/x.pdf", download: "" }, {}], [{ href: "/chats#m1" }, {}]]) {
    const e = p.click(p.make("A", attrs), 800, over);
    assert.equal(e.prevented, false, JSON.stringify([attrs, over]));
  }
  assert.equal(p.appended.length, 0, "no 'starting' line for links the browser handles");
});

test("REPLAY-FIXES #2: a button tapped before the app starts is pressed once it starts; a field is not; a late or gone one is not", () => {
  const p = page();
  const save = p.make("BUTTON");
  p.click(save, 500);
  p.at(900); p.window.__pulseEarly.off(); p.run(900);
  assert.equal(save.pressed, 1);

  const q = page();
  const field = q.make("INPUT");
  q.click(field, 500); q.window.__pulseEarly.off(); q.run(600);
  assert.equal(field.pressed, 0, "focusing a field later is the person's own move");

  const r = page();
  const old = r.make("BUTTON");
  r.click(old, 500); r.at(500 + EARLY_REPLAY_MS + 1); r.window.__pulseEarly.off(); r.run();
  assert.equal(old.pressed, 0, "too long ago: not pressed");

  const s = page();
  const gone = s.make("BUTTON");
  s.click(gone, 500); gone.isConnected = false; s.window.__pulseEarly.off(); s.run(600);
  assert.equal(gone.pressed, 0, "no longer on the page");
});

test("the collector reports early clicks once, when it starts, and the root layout loads the probe first in <body>", () => {
  const collector = readFileSync(new URL("./telemetry.mjs", import.meta.url), "utf8");
  assert.match(collector, /import \{ earlyReport \} from "\.\/early-clicks\.mjs"/);
  assert.match(collector, /q\.off\?\.\(\); const r = earlyReport\(q, perf\.now\(\)\); if \(r\) emit\("ui\.early"/);
  const layout = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<body data-viewer=\{[^}]+\}>\{me\?\.person && process\.env\.PULSE_TELEMETRY !== "0" \? <EarlyClicks \/> : null\}/);
});
