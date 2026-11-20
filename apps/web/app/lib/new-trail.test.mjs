// NEW-DOTS-2: the dot trail (rail → page → menu or tab → the thing), its counts, the tour's steps, and that the anchor
// registry (lib/new-anchors.json) is the code's: every data-new-anchor id in the app is listed, every listed one is in
// the code, and the ids fit the API's and the database's rule (synthetic values only).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { dotsFrom, entryCount, entryIsNew } from "../../../../packages/ui-shell/src/new-dots.ts";
import { ANCHOR_RE } from "../../../../services/api/src/new-dots-access.ts";
import { anchorEntry, dotDestination, pageDots, PAGE_CAP, pathOf, shellDetail, shortOf, stepOf, stepsOn, trailWords, travelFrom, TRAVEL_MS } from "./new-trail.mjs";

const registry = JSON.parse(readFileSync(new URL("./new-anchors.json", import.meta.url), "utf8"));
const item = (note, route, anchor = "", opened = false, text = `Synthetic ${note} ${route} ${anchor}`) => ({ note, route, anchor, opened, text, headline: `Release ${note}`, releasedAt: "2099-01-01" });

test("the shell lights the way in to what is not opened yet, with how many new things each page holds", () => {
  const d = shellDetail({ on: true, count: 5, items: [
    item(3, "/tasks", "work.new-task"), item(3, "/tasks", "work.more.pool"), item(2, "/tasks", "work.new-task"),
    item(3, "/settings", "settings.notifications.dots", true), item(3, "/chats")] });
  assert.deepEqual(d.routes, ["/tasks", "/chats"], "Settings was opened: its way in is dark, its thing still new on the page");
  assert.deepEqual(d.counts, { "/tasks": 2, "/chats": 1 }, "one per thing, however many releases changed it");
  assert.equal(d.count, 5, "What's new counts every new thing (the API's count)");
  assert.equal(shellDetail({ on: true, items: [item(1, "/tasks", "a"), item(1, "/tasks", "a")] }).count, 1);
  assert.deepEqual(shellDetail(null), { on: false, count: 0, routes: [], counts: {}, notes: {} });
});

test("HR-PEOPLE: each lit page carries what is new there, so its dot can say it on hover", () => {
  const d = shellDetail({ on: true, items: [item(3, "/people/pay", "", false, "Pay policy is now five questions"), item(2, "/people/pay", "", false, "Pay policy is now five questions"),
    item(2, "/people/pay", "pay.setup", false, "Set up pay walks one person at a time"), item(1, "/hr", "", true, "Opened already")] });
  assert.deepEqual(d.notes, { "/people/pay": ["Pay policy is now five questions", "Set up pay walks one person at a time"] }, "each line once; an opened page says nothing");
});

test("every level counts what waits below it: rail section, page, sub-place", () => {
  const dots = dotsFrom({ on: true, count: 4, routes: ["/tasks", "/my-day", "/erp/documents"], counts: { "/tasks": 2, "/erp/documents": 1, "/nope": 9 } });
  assert.deepEqual(dots.counts, { "/tasks": 2, "/erp/documents": 1 }, "only for lit pages");
  assert.equal(entryCount(dots, ["/tasks", "/my-week", "/my-day"]), 3, "Work: 2 on Tasks + My day (no number given: one)");
  assert.equal(entryCount(dots, ["/erp"]), 1, "Billing holds Documents");
  assert.equal(entryCount(dots, ["/erp/documents"]), 1);
  assert.equal(entryCount(dots, ["/chats"]), 0);
  assert.equal(entryCount(dots, ["/"]), 0, "the root never counts");
  assert.equal(entryCount({ ...dots, on: false }, ["/tasks"]), 0, "dots switched off");
  assert.equal(entryIsNew(dots, ["/tasks"]), entryCount(dots, ["/tasks"]) > 0);
  assert.equal(dotsFrom({ on: true, routes: ["/tasks"], counts: { "/tasks": 1e9 } }).counts["/tasks"], 99);
  assert.equal(dotsFrom({ on: true, routes: ["/tasks"], counts: "x" }).counts["/tasks"], undefined);
});

test("the tour on a page: its new things the registry knows, newest first, one each, with the way to each", () => {
  const items = [item(4, "/tasks", "work.more.pool"), item(4, "/tasks", "work.new-task"), item(3, "/tasks", "work.more.pool"),
    item(4, "/tasks", "not.in.registry"), item(4, "/tasks"), item(4, "/goals", "work.new-task"), item(4, "/settings", "settings.notifications.dots")];
  const steps = stepsOn(items, "/tasks?view=all", registry);
  assert.deepEqual(steps.map((s) => [s.anchor, s.via.join(">")]), [["work.more.pool", "work.more"], ["work.new-task", ""]]);
  assert.equal(steps[0].label, "The pool");
  assert.equal(steps[0].text, "Synthetic 4 /tasks work.more.pool", "the newest release's words");
  assert.deepEqual(stepsOn(items, "/goals", registry), [], "an anchor on another page than its own is not followed");
  assert.equal(stepsOn(items, "/settings", registry)[0].href, "/settings?tab=notifications", "a tab of the page opens on the way");
  assert.deepEqual(stepsOn(null, "/tasks", registry), []);
  assert.equal(stepOf(0, 3), "1 of 3");
});

test("the page's dots: the menu on the way says how many wait inside until it is open; the things keep theirs; capped", () => {
  const steps = [{ anchor: "work.more.pool", via: ["work.more"] }, { anchor: "work.more.reviews", via: ["work.more"] }, { anchor: "work.new-task", via: [] }];
  assert.deepEqual(pageDots(steps), [{ anchor: "work.more", count: 2, way: true }, { anchor: "work.more.pool", count: 1, way: false },
    { anchor: "work.more.reviews", count: 1, way: false }, { anchor: "work.new-task", count: 1, way: false }]);
  assert.deepEqual(pageDots(steps, (id) => id === "work.more").map((d) => d.anchor), ["work.more.pool", "work.more.reviews", "work.new-task"], "opened: its own dot goes");
  const many = Array.from({ length: 9 }, (_, i) => ({ anchor: `x.${i}`, via: [] }));
  assert.equal(pageDots(many).length, PAGE_CAP);
});

test("What's new says where the thing is", () => {
  assert.deepEqual(trailWords(registry, "work.more.pool"), ["More in Work", "The pool"]);
  assert.deepEqual(trailWords(registry, "work.new-task", "Work"), ["Work", "New task"]);
  assert.deepEqual(trailWords(registry, "nope"), []);
});

test("take me there: kept for a short while, for one page", () => {
  const now = Date.parse("2099-01-01T10:00:00Z");
  assert.deepEqual(travelFrom({ route: "/tasks?view=all", anchor: "work.new-task", at: now - 1000 }, now), { route: "/tasks", anchor: "work.new-task", at: now - 1000 });
  assert.equal(travelFrom({ route: "/tasks", at: now - TRAVEL_MS - 1 }, now), null, "too old");
  for (const bad of [null, "x", { route: "https://example.invalid", at: now }, { route: "/tasks" }, { route: "/tasks", at: now + 60_000 }]) assert.equal(travelFrom(bad, now), null);
  assert.equal(pathOf("/tasks/?x=1#y"), "/tasks");
});

/** Every data-new-anchor id written in the app's and the shared packages' sources (literal strings only). */
function anchorsInCode() {
  const roots = [new URL("../", import.meta.url).pathname, new URL("../../../../packages/", import.meta.url).pathname];
  const found = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|mjs)$/.test(name) && !name.endsWith(".test.mjs")) {
        const src = readFileSync(p, "utf8");
        // data-new-anchor="x" (never a template, `${…}`), or an `anchor: "area.thing"` / newAnchor="area.thing" prop (an id
        // always has a dot; other components' `anchor` props, a popover's "middle", do not).
        for (const m of src.matchAll(/data-new-anchor=["']([^"'$]+)["']|\b(?:anchor|newAnchor)[=:] ?["']([a-z0-9-]+\.[a-z0-9.-]+)["']/g)) { const id = m[1] ?? m[2]; if (!found.has(id)) found.set(id, p); }
      }
    }
  };
  for (const r of roots) walk(r);
  return found;
}

test("the anchor registry is the code's own: same ids both ways, each a valid id on a real page, its way known", () => {
  const code = anchorsInCode();
  const listed = Object.keys(registry.anchors);
  for (const [id, file] of code) assert.ok(listed.includes(id), `${id} (${file}) is not in lib/new-anchors.json`);
  for (const id of listed) {
    assert.ok(code.has(id), `${id} is listed but no element carries it`);
    assert.match(id, ANCHOR_RE, `${id}: lowercase words joined by dots or dashes (the API's and the database's rule)`);
    assert.ok(id.includes("."), `${id}: "area.thing" (the area first, then the thing)`);
    const e = anchorEntry(registry, id);
    assert.ok(e && e.route.startsWith("/") && e.label.trim(), id);
    assert.equal(pathOf(e.href), e.route, `${id}: its href opens its own page`);
    for (const v of e.via) assert.ok(anchorEntry(registry, v)?.route === e.route, `${id}: the way (${v}) is on the same page`);
  }
});

test("a change's short title for a phone's top bar", () => {
  assert.equal(shortOf("Start a task from a template: tap New, then pick one."), "Start a task from a template");
  assert.equal(shortOf("The pool now sorts by due date. Open More to see it."), "The pool now sorts by due date");
  assert.equal(shortOf("Chats open faster."), "Chats open faster");
  assert.equal(shortOf("A very long change line without any stop that goes on and on"), "A very long change line without any stop…");
  assert.equal(shortOf(""), "");
});

test("HR-PEOPLE: a dot lit by a page inside its entry opens that page, not the entry's own", () => {
  const items = [item(3, "/people/pay"), item(2, "/hr", "", true), item(1, "/tasks", "work.new-task")];
  assert.equal(dotDestination("/people", items), "/people/pay", "Team's dot came from People & pay");
  assert.equal(dotDestination("/people/pay", items), null, "the changed page itself opens as usual");
  assert.equal(dotDestination("/tasks?view=all", items), null);
  assert.equal(dotDestination("/hr", items), null, "an opened change leads nowhere new");
  assert.equal(dotDestination("/", items), null, "home never jumps");
  assert.equal(dotDestination("/people", []), null);
});
