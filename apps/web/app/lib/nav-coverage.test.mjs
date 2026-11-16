// IA-NAV (owner, 10 Nov 2026: "I don't even see where PR Studio is"): every page a person uses has a way in from the
// menu (the rail's groups and the sidebar), All apps (each page's own places) or Ctrl+K, so no live feature is an
// orphan again. A new page must be added to the menu (packages/ui-shell/src/shell.tsx allPages or SUBPLACES), to Ctrl+K
// (PLACES, or the destinations registry), or listed below as not a destination, with the reason.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ABOUT, GROUP_KEYS, NAV_GROUPS, defaultsFor, findApps, groupOpen, groupOrder, hiddenOf, moveGroup, pinsOf, prefsFrom, toggleHidden, togglePin } from "../../../../packages/ui-shell/src/nav-catalog.ts";
import { DESTINATIONS } from "../destinations/registry.mjs";

const APP = fileURLToPath(new URL("..", import.meta.url));
const shell = readFileSync(new URL("../../../../packages/ui-shell/src/shell.tsx", import.meta.url), "utf8");
const base = (href) => href.split(/[?#]/)[0];
const block = (start, end) => { const i = shell.indexOf(start); assert.ok(i >= 0, `${start} in shell.tsx`); return shell.slice(i, shell.indexOf(end, i + start.length)); };
const hrefsIn = (text) => [...text.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
const rail = [...block("const allPages", "\n];").matchAll(/\{ label: "([^"]+)",(?: short: "[^"]*",)? href: "([^"]+)", Icon: \w+, group: "(\w+)"/g)].map((m) => ({ label: m[1], href: m[2], group: m[3] }));
const sub = hrefsIn(block("const SUBPLACES", "\n};"));
/** Older addresses a menu entry also covers (they open inside it, or lead to it): /inbox → Chats, /portal → Tasks. */
const also = [...block("const allPages", "\n];").matchAll(/also: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
const places = [...hrefsIn(block("const PLACES", "\n];")), ...hrefsIn(block("const ELSEWHERE", "\n];"))];
const registry = DESTINATIONS.map((d) => d.href);

/** Routes that are not a place people go to from a menu, and why. Everything else in app/ must have a way in. */
const NOT_A_DESTINATION = {
  "/people/add": "FIX-PEOPLE-MONEY: only redirects to Team with the Add people panel open (/people?add=…), which the menu links to",
  "/operator": "AGENT-OPERATOR: watching one AI employee work; opened from the Watch button in that AI employee's chat (/operator?channel=…), not a place of its own",
  "/review-data/whatsapp-names": "SETTINGS-APPLE: the old address; it opens Review data's WhatsApp names type (/review-data?type=whatsapp-names), a chip of its one queue",
  "/": "sends a person to their home",
  "/home": "the calm home's address; Home → Dashboard is the entry",
  "/hidden": "the 'not part of your access' notice",
  "/cover": "reached from the cover request's notification too; listed under My desk",
  "/kit": "the UI kit's own sheet for designers (Ctrl+K finds Pulse controls)",
  "/insights-demo": "a sales demo with synthetic data",
  "/developers": "the public API reference",
  "/login": "sign-in", "/signup": "sign-up", "/start": "starting a company", "/join": "an invitation link", "/invited": "a client's invitation link",
  "/team-setup": "first-run team setup", "/welcome": "the first-run profile gate",
  "/portal/login": "the client portal's sign-in", "/portal/set-password": "the client portal's sign-in", "/portal/confirm-email": "the client portal's sign-in",
  "/portal/account": "the client portal's own header links it", "/portal/acquisition": "the client portal's lead form",
  "/settings/connectors/callback": "an OAuth return address", "/settings/mailbox/google": "an OAuth return address", "/settings/calendar/google": "an OAuth return address", "/apps/sales-xray/callback": "an OAuth return address",
  "/apps/get": "the account menu's Get the app", "/erp/new": "Billing's New invoice button (Ctrl+K: New invoice)",
  "/erp/catalog/import": "the Catalogue page's Import button", "/processes/new": "the Processes page's New button", "/sops/new": "the Processes page's New button",
"/meetings/new": "Meetings' Add button and its three sub-places (Add a transcript, Record a meeting, Narrate a problem); Ctrl+K: Start a meeting, Narrate a problem",
  "/contracts/new": "Agreements' New button (listed under Agreements)", "/tasks/projects": "Projects open at Tasks → Projects", "/start/ready": "starting a company", "/start/space": "starting a company", "/start/team": "starting a company",
  "/login/account-confirm": "sign-in", "/login/account-link": "sign-in", "/login/account-reset": "sign-in", "/login/confirm-email": "sign-in", "/login/device": "sign-in", "/login/how": "sign-in", "/login/link": "sign-in", "/login/set-password": "sign-in",
  "/oauth/authorize": "Sign in with Pulse's consent screen", "/orgs/new": "the organisation menu's New organisation", "/orgs/profile": "the organisation menu's profile",
  "/money": "Billing → Import statement", "/hr-history": "HR desk → HR history",
};

const walk = (dir, out = []) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) { if (n !== "api" || dir !== APP) walk(p, out); } else if (n === "page.tsx") out.push(p); } return out; };
const routes = walk(APP).map((f) => "/" + relative(APP, f).replace(/\/?page\.tsx$/, "")).map((r) => r === "/" ? "/" : r.replace(/\/$/, ""))
  .filter((r) => !r.includes("["));

test("every page people use has a way in: the menu, All apps or Ctrl+K", () => {
  assert.ok(routes.length > 100, `found the app's pages (${routes.length})`);
  const missing = routes.filter((r) => !NOT_A_DESTINATION[r]).filter((r) => {
    const way = (list) => list.some((h) => base(h) === r);
    return !(way(rail.map((p) => p.href)) || way(also) || way(sub) || way(places) || way(registry));
  });
  assert.deepEqual(missing, [], `pages without a way in (add them to the menu, Ctrl+K, or NOT_A_DESTINATION with a reason): ${missing.join(", ")}`);
});

test("the list of non-destinations names only pages that exist", () => {
  const gone = Object.keys(NOT_A_DESTINATION).filter((r) => !routes.includes(r));
  assert.deepEqual(gone, [], `remove these from NOT_A_DESTINATION: ${gone.join(", ")}`);
});

test("PR Studio, Goals, AI employees, Meetings and Find companies are on the menu, in their groups", () => {
  const at = (href) => rail.find((p) => p.href === href)?.group;
  assert.equal(at("/pr"), "growth");
  assert.equal(at("/directory"), "growth");
  assert.equal(at("/goals"), "money");
  assert.equal(at("/people/ai"), "ai");
  assert.equal(at("/settings?tab=connect-ai"), "ai");
  assert.equal(at("/meetings"), "work");
  assert.equal(at("/contracts"), "sales");
  assert.equal(at("/erp/documents?view=quotation"), "sales");
  assert.equal(at("/my-day"), "home");
  for (const p of rail) assert.ok(GROUP_KEYS.includes(p.group), `${p.href}: a known group (${p.group})`);
  for (const g of NAV_GROUPS.filter((g) => g.key !== "settings")) assert.ok(rail.some((p) => p.group === g.key), `${g.label} has pages`);
});

test("every menu page has a short plain line for All apps", () => {
  const without = rail.filter((p) => !["/client"].includes(p.href) && !ABOUT[p.href]).map((p) => p.href);
  assert.deepEqual(without, []);
  for (const [href, { blurb }] of Object.entries(ABOUT)) assert.ok(blurb.length <= 48, `${href}: "${blurb}" is short (${blurb.length})`);
});

const entries = rail.map((p) => ({ label: p.label, href: p.href, group: p.group, blurb: ABOUT[p.href]?.blurb, words: ABOUT[p.href]?.words }));
for (const [query, href] of [["PR", "/pr"], ["posts", "/pr"], ["content calendar", "/pr"], ["linkedin", "/pr"], ["invoice", "/erp"], ["quote", "/erp/documents?view=quotation"],
  ["okr", "/goals"], ["leads", "/acquisition"], ["check in", "/me"], ["ai employees", "/people/ai"], ["claude", "/settings?tab=connect-ai"], ["minutes", "/meetings"], ["gstin", "/directory"]])
  test(`"${query}" finds ${href} first`, () => assert.equal(findApps(entries, query)[0]?.href, href, findApps(entries, query).slice(0, 3).map((e) => e.href).join(", ")));

test("search needs every word, and an empty search keeps the order", () => {
  assert.equal(findApps(entries, "").length, entries.length);
  assert.equal(findApps(entries, "pr zzz").length, 0);
});

test("the person's menu: pins, hidden pages, group order and open groups", () => {
  assert.deepEqual(prefsFrom({ pins: ["/pr", 4, "javascript:x"], hide: "no", order: ["money", "bogus", "home"], open: { work: false, nope: true, home: "yes" } }),
    { pins: ["/pr"], hide: undefined, order: ["money", "home"], open: { work: false } });
  assert.deepEqual(prefsFrom(null), { pins: undefined, hide: undefined, order: undefined, open: undefined });
  const order = groupOrder({ order: ["settings", "money", "money"] });
  assert.equal(order[0], "money"); assert.equal(order.at(-1), "settings"); assert.equal(new Set(order).size, GROUP_KEYS.length);
  assert.equal(groupOrder(moveGroup({}, "work", -1))[0], "work");
  assert.deepEqual(moveGroup({}, "home", -1), {}, "the first group stays first");
  assert.equal(groupOrder(moveGroup({}, "ai", 1)).at(-1), "settings", "Settings stays last");
  // Role defaults: a salesperson starts with their sales pages pinned and the process pages out of the way.
  assert.ok(pinsOf({}, "Sales").includes("/clients"));
  assert.ok(hiddenOf({}, "Sales").includes("/runs"));
  assert.deepEqual(pinsOf({}, "Organisation owner/admin"), []);
  assert.deepEqual(togglePin({}, "Sales", "/clients").pins, ["/sales", "/erp/documents?view=quotation"]);
  assert.deepEqual(toggleHidden({}, "Sales", "/runs").hide, ["/product-map", "/processes", "/creative", "/map"]);
  assert.equal(groupOpen({}, "Sales", "sales", false), true);
  assert.equal(groupOpen({}, "Sales", "money", true), true, "the group of the page you are on opens");
  assert.equal(groupOpen({ open: { sales: false } }, "Sales", "sales", false), false);
  assert.equal(groupOpen({}, "Sales", "sales", false, false), false, "away from Home only the current group opens");
  assert.deepEqual(defaultsFor("Someone new"), defaultsFor("Member"));
});
