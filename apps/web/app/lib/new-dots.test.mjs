// NEW-DOTS: where the shell puts red dots, what a visit clears, the What's new list, and that the API's copy of who can
// open which page stays in step with the shell's own lists (synthetic values only).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { countText, dotsFrom, dotTip, entryIsNew, entryNotes, NO_DOTS, subIsNew, visitClears } from "../../../../packages/ui-shell/src/new-dots.ts";
import { MODULE_PATHS } from "../../../../packages/ui-shell/src/modules.ts";
import { GATED, MODULE_PAGES, pageOpen } from "../../../../services/api/src/new-dots-access.ts";
import { unseenHeading, unseenLines } from "./new-dots.mjs";

const dots = (routes) => ({ on: true, routes, count: new Set(routes).size });

test("an entry lights for its page, the pages it also covers, and pages inside them", () => {
  const d = dots(["/contracts", "/my-day", "/erp/documents"]);
  assert.equal(entryIsNew(d, ["/contracts"]), true);
  assert.equal(entryIsNew(d, ["/tasks", "/my-week", "/my-day"]), true, "Work covers My day");
  assert.equal(entryIsNew(d, ["/erp"]), true, "Billing holds Documents");
  assert.equal(entryIsNew(d, ["/erp/catalog"]), false);
  assert.equal(entryIsNew(d, ["/contract"]), false, "not a prefix of the word");
  assert.equal(entryIsNew(d, ["/"]), false, "the root never lights");
  assert.equal(entryIsNew(d, ["/tasks?view=projects"]), false);
  assert.equal(entryIsNew({ ...d, on: false }, ["/contracts"]), false, "dots switched off");
  assert.equal(entryIsNew(NO_DOTS, ["/contracts"]), false);
});

test("a sub-place lights for its own page, never as a tab of its page", () => {
  const d = dots(["/settings", "/erp/documents"]);
  assert.equal(subIsNew(d, "/erp/documents"), true);
  assert.equal(subIsNew(d, "/settings?tab=account"), false, "a release names pages, not tabs");
  assert.equal(entryIsNew(d, ["/settings", "/companies"]), true, "Settings itself lights");
});

test("opening a page clears its change, and one inside it does too; a wider page does not", () => {
  assert.equal(visitClears("/contracts", "/contracts"), true);
  assert.equal(visitClears("/contracts/abc", "/contracts"), true);
  assert.equal(visitClears("/contracts/", "/contracts"), true);
  assert.equal(visitClears("/erp", "/erp/documents"), false);
  assert.equal(visitClears("/contracts-old", "/contracts"), false);
});

test("the count reads up to 9, then 9+; a malformed event is no dots", () => {
  assert.equal(countText(3), "3");
  assert.equal(countText(12), "9+");
  assert.deepEqual(dotsFrom({ on: true, routes: ["/tasks", 5, "x"], count: 1 }), { on: true, routes: ["/tasks"], count: 1, counts: {}, notes: {} });
  assert.deepEqual(dotsFrom({ on: false, routes: ["/tasks"] }), NO_DOTS);
  assert.deepEqual(dotsFrom(null), NO_DOTS);
});

test("What's new lists each changed page once, with how many updates changed it", () => {
  const lines = unseenLines([
    { note: 3, route: "/tasks", text: "Synthetic: tasks load faster", headline: "Release 3", releasedAt: "2099-01-03" },
    { note: 3, route: "/chats", text: "Synthetic: chats", headline: "Release 3", releasedAt: "2099-01-03" },
    { note: 2, route: "/tasks", text: "Synthetic: older words", headline: "Release 2", releasedAt: "2099-01-02" },
    null,
  ]);
  assert.deepEqual(lines.map((l) => [l.route, l.text, l.releases]), [["/tasks", "Synthetic: tasks load faster", 2], ["/chats", "Synthetic: chats", 1]]);
  assert.equal(unseenHeading(1), "1 new thing for you");
  assert.equal(unseenHeading(4), "4 new things for you");
});

test("the API's module pages are the shell's (packages/ui-shell/src/modules.ts)", () => {
  assert.deepEqual(MODULE_PAGES, Object.fromEntries(Object.entries(MODULE_PATHS).map(([k, v]) => [k, [...v]])));
});

// The shell's rail lists (shell.tsx), read as text: the pages it gives only to some roles, and HR's own pages.
const shell = readFileSync(new URL("../../../../packages/ui-shell/src/shell.tsx", import.meta.url), "utf8");
const entries = [...shell.matchAll(/\{ label: "[^"]+",(?: short: "[^"]*",)? href: "([^"?]+)"[^}]*?access: "(all|work|hr|admin)" \}/g)].map((m) => ({ href: m[1], access: m[2] }));

test("every page the shell gives only to some roles has a rule in the API, and a member never opens it", () => {
  const open = new Set(entries.filter((e) => e.access === "all" || e.access === "work").map((e) => e.href));
  const gated = [...new Set(entries.filter((e) => (e.access === "admin" || e.access === "hr") && !open.has(e.href)).map((e) => e.href))];
  assert.ok(gated.length >= 10, `found the shell's gated pages (${gated.join(", ")})`);
  const ruled = GATED.flatMap((g) => g.bases);
  for (const href of gated) {
    assert.ok(ruled.includes(href), `${href} has a rule in services/api/src/new-dots-access.ts GATED`);
    assert.equal(pageOpen(href, { role: "person", side: "staff" }), false, `a member gets no dot for ${href}`);
  }
});

test("an HR-only seat opens every page on HR's rail", () => {
  const list = /const HR_PAGES = \[([^\]]+)\]/.exec(shell)?.[1];
  assert.ok(list, "HR_PAGES found in shell.tsx");
  for (const href of list.match(/"\/[^"]*"/g).map((s) => s.slice(1, -1))) assert.equal(pageOpen(href, { role: "hr" }), true, href);
});

test("HR-PEOPLE: a dot says on hover how many new things wait under it and what they are", () => {
  const dots = dotsFrom({ on: true, count: 3, routes: ["/people/pay", "/hr"], counts: { "/people/pay": 2 },
    notes: { "/people/pay": ["Pay policy is now five questions.", "Set up pay walks one person at a time", 7], "/hr": ["Approvals say who acts next"], "/nope": ["x"] } });
  assert.deepEqual(entryNotes(dots, ["/people/pay"]), ["Pay policy is now five questions.", "Set up pay walks one person at a time"]);
  assert.deepEqual(entryNotes(dots, ["/people", "/hr"]), ["Pay policy is now five questions.", "Set up pay walks one person at a time", "Approvals say who acts next"], "a group holds its pages' lines");
  assert.equal(dotTip("People & pay", 1, entryNotes(dots, ["/people/pay"])), "New in People & pay: Pay policy is now five questions; Set up pay walks one person at a time. Click to see them.");
  assert.equal(dotTip("Team", 1, []), "Team · 1 new. Click to see it.", "an old line without words still says what a click does");
  assert.match(dotTip("People", 5, ["a", "b", "c", "d", "e"]), /; and 2 more\. Click to see them\.$/);
  assert.deepEqual(entryNotes(NO_DOTS, ["/people"]), []);
});
