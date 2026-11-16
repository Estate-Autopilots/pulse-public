// NEW-DOTS: which changed pages light a red dot for whom, and what opening a page clears (synthetic values only).
import assert from "node:assert/strict";
import test from "node:test";
import { anchorOf, clearedBy, itemsOf, pageOpen, placeCount, reachedBy, routeOf, seenKey, thingCount, unseenOf, WINDOW_DAYS } from "../dist/new-dots-access.js";

const NOW = Date.parse("2099-01-10T10:00:00Z");
const note = (id, items, pleaseCheck = [], releasedAt = "2099-01-09T10:00:00Z") => ({ id, headline: `Synthetic release ${id}`, releasedAt, items, pleaseCheck });
const member = { role: "person", side: "staff" };

test("a note's link becomes a page address; anything else is no dot", () => {
  assert.equal(routeOf("/contracts"), "/contracts");
  assert.equal(routeOf("/erp/documents?tab=open#top"), "/erp/documents");
  assert.equal(routeOf("/settings/"), "/settings");
  for (const bad of [null, 7, "", "/", "https://example.invalid/x", "//evil.invalid", "/a b", "/x<y>", "javascript:alert(1)", "/whats-new", "/login", "/accept/abc"])
    assert.equal(routeOf(bad), null, String(bad));
});

test("each changed page once per release, the person's audiences first and then what to check, newest release first", () => {
  const items = itemsOf([
    note(2, { owner: [{ text: "Synthetic: contracts list", href: "/contracts" }], everyone: [{ text: "Synthetic: faster tasks", href: "/tasks" }, { text: "No link", href: null }] },
      [{ text: "Synthetic: open Tasks", href: "/tasks" }, { text: "Synthetic: open Billing", href: "/erp" }]),
    note(1, { everyone: [{ text: "  Synthetic:\n  tasks again ", href: "/tasks" }] }),
  ]);
  assert.deepEqual(items.map((i) => `${i.note} ${i.route} ${i.text}`), [
    "2 /contracts Synthetic: contracts list", "2 /tasks Synthetic: faster tasks", "2 /erp Synthetic: open Billing", "1 /tasks Synthetic: tasks again"]);
  assert.equal(items[0].headline, "Synthetic release 2");
  assert.equal(placeCount(items), 3, "three places, however many releases changed them");
});

test("a member never gets a dot for a page only leaders, HR, Finance or admins open", () => {
  for (const route of ["/contracts", "/finance", "/erp", "/leadership", "/insights", "/audit", "/telemetry", "/admin", "/hr", "/review-data", "/network"])
    assert.equal(pageOpen(route, member), false, route);
  for (const route of ["/tasks", "/chats", "/settings", "/me", "/people", "/docs", "/clients", "/product-map"]) assert.equal(pageOpen(route, member), true, route);
});

test("each role opens what its rail has", () => {
  const admin = { role: "admin" }, lead = { role: "leadership" }, hr = { role: "hr" }, hrLead = { role: "hr", lead: true }, fin = { role: "finance" };
  assert.ok(["/contracts", "/finance", "/erp", "/audit", "/hr", "/review-data"].every((r) => pageOpen(r, admin)));
  assert.equal(pageOpen("/admin", admin), false, "the admin console is for Pulse's platform admins");
  assert.equal(pageOpen("/admin", { ...admin, platformAdmin: true }), true);
  assert.ok(["/contracts", "/finance", "/erp", "/leadership", "/hr"].every((r) => pageOpen(r, lead)));
  assert.ok(["/audit", "/review-data"].every((r) => !pageOpen(r, lead)));
  assert.ok(["/hr", "/review-data", "/people", "/tasks", "/settings"].every((r) => pageOpen(r, hr)));
  assert.ok(["/clients", "/contracts", "/erp", "/finance", "/leadership", "/docs", "/processes"].every((r) => !pageOpen(r, hr)), "HR alone: never clients, money or admin");
  assert.ok(["/clients", "/leadership", "/hr"].every((r) => pageOpen(r, hrLead)));
  assert.ok(pageOpen("/erp", fin) && pageOpen("/contracts", fin) && !pageOpen("/finance", fin));
  assert.ok(pageOpen("/erp", { ...member, salesSeat: true }) && !pageOpen("/contracts", { ...member, salesSeat: true }));
  const acc = { role: "accountant" };
  assert.ok(pageOpen("/finance/desk", acc) && pageOpen("/erp/documents", acc) && !pageOpen("/finance", acc) && !pageOpen("/tasks", acc));
});

test("a client or freelancer seat only gets their own space, shared work and chats", () => {
  for (const side of ["client", "channel_partner", "guest", "freelancer"]) {
    const seat = { role: "admin", side };
    assert.ok(["/client", "/tasks", "/chats", "/settings"].every((r) => pageOpen(r, seat)), side);
    assert.ok(["/dashboard", "/people", "/clients", "/erp", "/contracts", "/hr", "/me"].every((r) => !pageOpen(r, seat)), side);
  }
});

test("hidden screens, switched-off modules, the company's own switches and a personal workspace close pages", () => {
  assert.equal(pageOpen("/clients/abc", { ...member, hidden: ["/clients"] }), false);
  assert.equal(pageOpen("/chats/import", { ...member, modulesOff: ["chat_import"] }), false);
  assert.equal(pageOpen("/chats", { ...member, modulesOff: ["chat_import"] }), true);
  assert.equal(pageOpen("/erp", { role: "admin", modulesOff: ["money"] }), false);
  assert.equal(pageOpen("/tasks", { ...member, company: { tasks: false } }), false);
  assert.equal(pageOpen("/finance", { role: "admin", company: { finance: false } }), false);
  assert.equal(pageOpen("/people", { role: "admin", personal: true }), false);
  assert.equal(pageOpen("/goals", { role: "admin", personal: true }), true);
});

test("unseen: not seen yet, a page they can open, a release of the last 30 days", () => {
  const items = itemsOf([
    note(3, { owner: [{ text: "Synthetic: contracts", href: "/contracts" }], everyone: [{ text: "Synthetic: tasks", href: "/tasks" }, { text: "Synthetic: chats", href: "/chats" }] }),
    note(1, { everyone: [{ text: "Synthetic: old", href: "/docs" }] }, [], new Date(NOW - (WINDOW_DAYS + 1) * 86400000).toISOString()),
  ]);
  const left = unseenOf(items, new Set(["3 /chats"]), member, NOW);
  assert.deepEqual(left.map((i) => i.route), ["/tasks"]);
  assert.deepEqual(unseenOf(items, new Set(), { role: "admin" }, NOW).map((i) => i.route), ["/contracts", "/tasks", "/chats"]);
});

test("opening a page clears its change and a change to a page that holds it, never a deeper one", () => {
  const items = itemsOf([note(5, { everyone: [{ text: "a", href: "/erp" }, { text: "b", href: "/erp/documents" }, { text: "c", href: "/tasks" }] })]);
  assert.deepEqual(clearedBy(items, "/erp/documents/12").map((i) => i.route), ["/erp", "/erp/documents"]);
  assert.deepEqual(clearedBy(items, "/erp").map((i) => i.route), ["/erp"]);
  assert.deepEqual(clearedBy(items, "/tasks-old").map((i) => i.route), []);
});

// NEW-DOTS-2 (owner, 10 Nov 2026): a line may name the thing on its page that changed (its anchor).
test("a line's anchor is kept when it is a plain id; anything else is a change to the page as a whole", () => {
  assert.equal(anchorOf("work.new-task"), "work.new-task");
  for (const bad of [null, 7, "", "Work.New", "nav:/pr", "a b", "-x", "x".repeat(81), "<b>", "work/new"]) assert.equal(anchorOf(bad), "", String(bad));
  const items = itemsOf([note(7, { everyone: [
    { text: "Synthetic: templates in New task", href: "/tasks", anchor: "work.new-task" },
    { text: "Synthetic: the pool sorts by due date", href: "/tasks", anchor: "work.more.pool" },
    { text: "Synthetic: tasks load faster", href: "/tasks" },
    { text: "Synthetic: same thing again", href: "/tasks", anchor: "work.new-task" },
    { text: "Synthetic: a bad anchor", href: "/chats", anchor: "nav:/chats" }] })]);
  assert.deepEqual(items.map((i) => [i.route, i.anchor, i.opened]), [["/tasks", "work.new-task", false], ["/tasks", "work.more.pool", false], ["/tasks", "", false], ["/chats", "", false]]);
  assert.equal(placeCount(items), 2, "two pages");
  assert.equal(thingCount(items), 4, "four new things: two on Tasks' page, Tasks itself, Chats");
  assert.equal(seenKey(7, "/tasks"), "7 /tasks");
  assert.equal(seenKey(7, "/tasks", "work.new-task"), "7 /tasks work.new-task");
});

test("opening the page clears the way there; the thing stays new until it is reached", () => {
  const items = itemsOf([note(8, { everyone: [{ text: "Synthetic: templates", href: "/tasks", anchor: "work.new-task" }, { text: "Synthetic: page", href: "/tasks" }] })]);
  const fresh = unseenOf(items, new Set(), member, NOW);
  assert.deepEqual(fresh.map((i) => [i.anchor, i.opened]), [["work.new-task", false], ["", false]]);
  // A visit to /tasks writes "8 /tasks": the page change is seen, the thing on it is opened (its page's dots go).
  const visited = unseenOf(items, new Set([seenKey(8, "/tasks")]), member, NOW);
  assert.deepEqual(visited.map((i) => [i.anchor, i.opened]), [["work.new-task", true]]);
  assert.equal(thingCount(visited), 1, "What's new still counts it");
  // Reaching it writes "8 /tasks work.new-task": nothing left.
  assert.deepEqual(unseenOf(items, new Set([seenKey(8, "/tasks"), seenKey(8, "/tasks", "work.new-task")]), member, NOW), []);
  // Reached without the visit row (another device's Got it): gone too.
  assert.deepEqual(unseenOf(items, new Set([seenKey(8, "/tasks", "work.new-task")]), member, NOW).map((i) => i.anchor), [""]);
});

test("reaching a thing clears only that thing on that page", () => {
  const items = itemsOf([note(9, { everyone: [{ text: "a", href: "/tasks", anchor: "work.new-task" }, { text: "b", href: "/tasks", anchor: "work.more.pool" }, { text: "c", href: "/goals", anchor: "work.new-task" }] })]);
  assert.deepEqual(reachedBy(items, "/tasks", "work.new-task").map((i) => `${i.route} ${i.anchor}`), ["/tasks work.new-task"]);
  assert.deepEqual(reachedBy(items, "/tasks", ""), [], "no anchor: nothing reached");
  assert.deepEqual(reachedBy(items, "/chats", "work.new-task"), []);
});

test("no dot for a thing on a page the person cannot open, whatever its anchor", () => {
  const items = itemsOf([note(10, { owner: [{ text: "Synthetic: new filter", href: "/contracts", anchor: "contracts.filter" }], everyone: [{ text: "Synthetic: New task", href: "/tasks", anchor: "work.new-task" }] })]);
  assert.deepEqual(unseenOf(items, new Set(), member, NOW).map((i) => i.route), ["/tasks"]);
  assert.deepEqual(unseenOf(items, new Set(), { role: "admin" }, NOW).map((i) => i.route), ["/contracts", "/tasks"]);
  assert.deepEqual(unseenOf(items, new Set(), { ...member, company: { tasks: false } }, NOW), [], "Work switched off for the company");
  assert.deepEqual(unseenOf(items, new Set(), { role: "admin", side: "client" }, NOW).map((i) => i.route), ["/tasks"], "a client seat: shared work only");
});
