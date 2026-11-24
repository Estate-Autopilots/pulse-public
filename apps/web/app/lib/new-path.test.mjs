// NAV-CONNECT (owner, 17 Nov 2026: "The new-update pop-up highlights the wrong thing, just one thing at the top, and
// doesn't take you to the specific item arrow by arrow"): the path from What's new to the change, step by step, and the
// rule that it never points at a guess. Lines here are synthetic, written like the real release lines of 16–17 Nov.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LAND_MS, PATH_MS, inferAnchor, opensFirst, pathFrom, pathGo, pathPlan, stepWords } from "./new-path.mjs";

const registry = JSON.parse(readFileSync(new URL("./new-anchors.json", import.meta.url), "utf8"));
const MONEY = { group: "money", groupLabel: "Money", href: "/erp", label: "Billing" };
const CHAT = { group: "chat", groupLabel: "Messages", href: "/chats", label: "Chats" };

test("from another page: the rail's group, then the page in its list, then the thing", () => {
  assert.deepEqual(pathPlan({ route: "/chats", anchor: "chats.search", here: "/dashboard", spot: CHAT, rail: true }), [
    { kind: "rail", group: "chat", label: "Messages" },
    { kind: "menu", group: "chat", href: "/chats", label: "Chats" },
    { kind: "thing", anchor: "chats.search" },
  ]);
  assert.equal(stepWords(0, 3), "Step 1 of 3");
  assert.equal(stepWords(0, 1), "", "a one-step path says no count");
});

test("a change to a page as a whole ends on the page's own entry (Open it), never on a guessed thing or its title", () => {
  const steps = pathPlan({ route: "/erp/documents", here: "/whats-new", spot: MONEY, rail: true });
  assert.deepEqual(steps, [{ kind: "rail", group: "money", label: "Money" }, { kind: "menu", group: "money", href: "/erp", label: "Billing" }, { kind: "note", label: "Billing" }]);
});

test("already on the page, or on a phone (no rail lists), the path is the last step only", () => {
  assert.deepEqual(pathPlan({ route: "/chats", anchor: "chats.search", here: "/chats", spot: CHAT, rail: true }), [{ kind: "thing", anchor: "chats.search" }]);
  assert.deepEqual(pathPlan({ route: "/chats", here: "/dashboard", spot: CHAT, rail: false }), [{ kind: "page", label: "Chats" }]);
  assert.deepEqual(pathPlan({ route: "/nowhere", here: "/dashboard", spot: null, rail: true }), [{ kind: "page", label: "This page" }], "a page no menu entry holds");
});

test("a change to the whole app (route /) stays where the person is", () => {
  assert.deepEqual(pathPlan({ route: "/", anchor: "shell.rail", here: "/tasks", spot: null, rail: true }), [{ kind: "thing", anchor: "shell.rail" }]);
  assert.deepEqual(pathPlan({ route: "/", here: "/tasks", spot: null, rail: true }), [{ kind: "page", label: "Everywhere in Pulse" }]);
});

test("a line without an anchor finds its thing only when exactly one thing on its page matches", () => {
  const line = (route, text, anchor = "") => ({ route, text, anchor });
  // Lines like the real ones of 16–17 Nov:
  assert.equal(inferAnchor(line("/chats", "Chats search now ignores accents, so a name is found however you type it."), registry), "chats.search");
  assert.equal(inferAnchor(line("/contacts", "The contact book now has People, Companies and Clients tabs, each with its count."), registry), "contacts.tabs");
  assert.equal(inferAnchor(line("/", "Rest your mouse on a side menu group, like Sales or Money, and it opens beside it."), registry), "shell.rail");
  assert.equal(inferAnchor(line("/tasks", "Tap New task, then pick a template."), registry), "work.new-task");
  // Behaviour, not a thing: the page itself.
  assert.equal(inferAnchor(line("/chats", "Voice notes now hear words like kilowatt correctly."), registry), "");
  assert.equal(inferAnchor(line("/erp/documents", "Your online shop can now get the PDF of an issued invoice."), registry), "");
  // Two things named: no guess.
  assert.equal(inferAnchor(line("/tasks", "The pool and Reviews are tidier."), registry), "");
  // A thing on another page is never taken.
  assert.equal(inferAnchor(line("/docs", "Search chats from the doc."), registry), "");
  // A line's own anchor wins when the registry knows it; an unknown one is dropped.
  assert.equal(inferAnchor(line("/tasks", "Anything", "work.more.pool"), registry), "work.more.pool");
  assert.equal(inferAnchor(line("/tasks", "Anything", "work.nope"), registry), "");
  assert.equal(inferAnchor(null, registry), "");
});

test("a stored path is checked before it is followed", () => {
  const now = 1_800_000_000_000;
  const good = { route: "/chats", href: "/chats", text: "Search", anchor: "chats.search", inferred: true, steps: [{ kind: "rail" }, { kind: "menu" }, { kind: "thing" }], i: 1, at: now - 1000 };
  assert.equal(pathFrom(good, now)?.i, 1);
  assert.equal(pathFrom({ ...good, at: now - PATH_MS - 1 }, now), null, "too old");
  for (const bad of [null, "x", { ...good, route: "//evil.example" }, { ...good, href: "https://evil.example" }, { ...good, i: 3 }, { ...good, steps: [] }, { ...good, steps: [{ kind: "jump" }] }])
    assert.equal(pathFrom(bad, now), null, JSON.stringify(bad));
});

// PROJECTS-FLICKER (owner, 22 Nov 2026, P0: "the project page … is flickering like crazy, it does not open"). Show me on
// a change to Projects stored a path to /projects, which sends an agency on to /tasks?view=projects. Off its page, the
// path opened /projects again, landed on /tasks again, and so on, ~8 times a second on production.
const PROJECTS = { route: "/projects", href: "/projects", text: "Projects is one list of colour cards", anchor: "", inferred: false, steps: [{ kind: "page", label: "Projects" }], i: 0, at: 1_800_000_000_000 };
/** Plays the path the way new-path.tsx does: each address the browser shows (usePathname) is handed to pathGo, and an
 *  "open" is answered by the app: /projects shows for a moment, then the server's redirect lands on /tasks. */
function drive(path, start, redirect, laps = 20) {
  let p = path, opened = null, here = start, now = p.at + 500;
  const opens = [], seen = [here];
  for (let n = 0; n < laps; n++, now += 120) {
    const go = pathGo({ path: p, here, opened, now });
    if (!go) break;
    if (go.go === "there") { opened = { ...opened, there: true }; here = redirect[here] ?? here; seen.push(here); continue; }
    if (go.go === "open") { opened = go.opened; opens.push(go.href); here = go.href; seen.push(here); continue; }
    if (go.go === "here") { p = { ...p, route: go.route }; continue; }
    if (go.go === "end") { p = null; break; }
  }
  return { opens, seen, path: p };
}

test("a path to a page that sends the person on opens it once and carries on where it landed (no loop)", () => {
  const r = drive(PROJECTS, "/whats-new", { "/projects": "/tasks" });
  assert.deepEqual(r.opens, ["/projects"], `opened ${r.opens.length} times: ${r.seen.join(" → ")}`);
  assert.deepEqual(r.seen, ["/whats-new", "/projects", "/tasks"]);
  assert.equal(r.path?.route, "/tasks", "the path now belongs to the page it landed on");
  assert.equal(pathGo({ path: r.path, here: "/tasks?view=projects", opened: { step: `${PROJECTS.at}:0`, from: "/whats-new", at: PROJECTS.at + 500, there: true }, now: PROJECTS.at + 900 }), null,
    "on the landed page the path stays (its card shows there)");
});

test("a reload on the landed page: the path opens its page once more at most, then carries on there", () => {
  // The owner reloaded Work → Projects with the path still stored: it opened /projects from /tasks and landed on /tasks.
  const r = drive(PROJECTS, "/tasks", { "/projects": "/tasks" });
  assert.deepEqual(r.opens, ["/projects"]);
  assert.equal(r.path?.route, "/tasks");
});

test("the path opens its page once per step, waits while it opens, and ends when the person goes elsewhere later", () => {
  const at = PROJECTS.at, step = `${at}:0`;
  assert.deepEqual(pathGo({ path: PROJECTS, here: "/whats-new", opened: null, now: at + 1 }), { go: "open", href: "/projects", opened: { step, from: "/whats-new", at: at + 1, there: false } });
  // Still on the page it was opened from: the page is on its way; nothing more.
  assert.equal(pathGo({ path: PROJECTS, here: "/whats-new", opened: { step, from: "/whats-new", at: at + 1, there: false }, now: at + 400 }), null);
  // On its page: once marked there, nothing to do.
  assert.deepEqual(pathGo({ path: PROJECTS, here: "/projects", opened: { step, from: "/whats-new", at: at + 1, there: false }, now: at + 500 }), { go: "there" });
  assert.equal(pathGo({ path: PROJECTS, here: "/projects", opened: { step, from: "/whats-new", at: at + 1, there: true }, now: at + 500 }), null);
  // Landed elsewhere straight after the opening (a redirect): the path carries on there, even when the change's own
  // address showed first, or never did.
  assert.deepEqual(pathGo({ path: PROJECTS, here: "/tasks", opened: { step, from: "/whats-new", at: at + 1, there: true }, now: at + 900 }), { go: "here", route: "/tasks" });
  assert.deepEqual(pathGo({ path: PROJECTS, here: "/tasks", opened: { step, from: "/whats-new", at: at + 1, there: false }, now: at + 900 }), { go: "here", route: "/tasks" });
  // Long after the opening, somewhere else: the path ends too.
  assert.deepEqual(pathGo({ path: PROJECTS, here: "/chats", opened: { step, from: "/whats-new", at: at + 1, there: false }, now: at + 2 + LAND_MS }), { go: "end" });
  // A new step (Next) is a new opening.
  assert.equal(pathGo({ path: { ...PROJECTS, at: at + 5000 }, here: "/chats", opened: { step, from: "/whats-new", at: at + 1, there: true }, now: at + 5001 })?.go, "open");
  // The rail and list steps, a change to the whole app, and no path: the path opens nothing.
  assert.equal(pathGo({ path: { ...PROJECTS, steps: [{ kind: "rail", group: "work", label: "Work" }, { kind: "page", label: "Projects" }] }, here: "/chats", opened: null, now: at }), null);
  assert.equal(pathGo({ path: { ...PROJECTS, route: "/" }, here: "/chats", opened: null, now: at }), null);
  assert.equal(pathGo({ path: null, here: "/chats", opened: null, now: at }), null);
});

test("VITALS-SWEEP: a Show me whose first step opens another page says so the moment it is pressed", () => {
  // Owner, EA, 23 Nov 2026 19:49 UTC: Show me on a Projects line (an agency's /projects, not in its menu) went straight to
  // opening the page; nothing on screen changed for over a second (ui.dead) and the page came ~4 s later on a slow line,
  // so the owner opened it in a new tab instead. The line now shows "Opening…" whenever the path starts by opening a page.
  const opens = (route, here, spot, anchor = "", rail = true) => opensFirst({ route, here, steps: pathPlan({ route, anchor, here, spot, rail }) });
  assert.equal(opens("/projects", "/whats-new", null), true, "no menu entry: the path opens the page first");
  assert.equal(opens("/projects?view=board", "/whats-new", null), true);
  assert.equal(opens("/erp", "/whats-new", MONEY), false, "a menu entry: the first step (the rail's arrow) shows at once");
  assert.equal(opens("/erp", "/whats-new", MONEY, "erp.send"), false);
  assert.equal(opens("/erp", "/whats-new", MONEY, "", false), true, "no rail on screen: the path opens the page first");
  assert.equal(opens("/erp", "/erp", MONEY), false, "already on the page: nothing to open");
  assert.equal(opens("/", "/whats-new", null), false, "a change everywhere: nothing to open");
  assert.equal(opensFirst({ route: "/erp", here: "/whats-new", steps: [] }), false);
});
