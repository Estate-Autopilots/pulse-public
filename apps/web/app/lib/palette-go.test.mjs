import assert from "node:assert/strict";
import test from "node:test";
import { pathSwitchedOff } from "../../../../packages/ui-shell/src/modules.ts";
import { destination } from "../destinations/registry.mjs";
import { paletteGoItems } from "./palette-go.mjs";
import { prepare, rank } from "./search-rank.mjs";

// The Leadership menu's routes; labels can be renamed independently of the registry.
const pages = [
  ["Dashboard", "/dashboard"], ["Work", "/tasks"], ["Chats", "/chats"], ["Clients", "/clients"],
  ["Acquisition", "/acquisition"], ["Contacts", "/contacts"], ["Map", "/map"], ["SOPs", "/sops"],
  ["Creative Strategy", "/creative"], ["Network", "/network"], ["Team", "/people"], ["My desk", "/me"],
  ["HR desk", "/hr"], ["Leadership", "/leadership"], ["Finance", "/finance"], ["Billing", "/erp"],
].map(([label, href]) => ({ label, href }));
const build = (options = {}) => {
  const modulesOff = options.modulesOff ?? [];
  return paletteGoItems({ pages, role: "Leadership", ...options, isSwitchedOff: (href) => pathSwitchedOff(href, modulesOff) });
};
const hits = (items, query) => rank(items.map(prepare), query, { min: 0.3 }).slice(0, 4).map(({ item }) => item);
const billing = (items) => items.filter((item) => /^\/erp(?:[/?#]|$)/.test(item.href));

for (const query of ["erp", "invoices", "billing"]) test(`${query} finds Billing in Go to`, () => {
  const found = hits(build(), query);
  assert.ok(found.some((item) => item.label === "Billing" && item.href === "/erp" && item.group === "go"));
  if (query === "invoices") assert.equal(found[0].href, "/erp");
});

test("Billing settings is offered for billing and erp with the spotlight link", () => {
  for (const query of ["billing", "erp"]) {
    assert.ok(hits(build(), query).some((item) => item.label === "Billing settings" && item.href === "/erp/settings?go=erp.settings"));
  }
  assert.deepEqual(billing(build()).map((item) => item.href), ["/erp", "/erp/new?go=erp.new", "/erp/catalog?go=erp.catalog", "/erp/templates?go=erp.templates", "/erp/settings?go=erp.settings"]);
});

test("menu label and href survive renaming while path and synonyms come from the registry", () => {
  const renamed = build({ pages: [{ label: "Customer billing", href: "/erp?from=menu#top" }] });
  const page = renamed.find((item) => item.key.startsWith("page:"));
  assert.equal(page.label, "Customer billing");
  assert.equal(page.href, "/erp?from=menu#top");
  assert.deepEqual(page.path, destination("erp").path);
  assert.deepEqual(page.synonyms, destination("erp").synonyms);
  assert.ok(hits(renamed, "invoices").some((item) => item.key === page.key));
  assert.equal(renamed.filter((item) => item.href.split(/[?#]/)[0] === "/erp").length, 1);
});

test("a role without the Billing menu has no Billing destinations", () => {
  const without = pages.filter((page) => page.href !== "/erp");
  for (const role of ["Leadership", "Employee", "HR"]) assert.deepEqual(billing(build({ pages: without, role })), []);
  // A shared URL prefix is not a parent route.
  assert.deepEqual(billing(build({ pages: [{ label: "Other", href: "/er" }] })), []);
});

test("hidden screens and disabled modules suppress Billing and all descendants", () => {
  assert.deepEqual(billing(build({ hidden: ["/erp"] })), []);
  assert.deepEqual(billing(build({ modulesOff: ["money"] })), []);
  const childHidden = billing(build({ hidden: ["/erp/settings"] }));
  assert.ok(childHidden.some((item) => item.href === "/erp"));
  assert.ok(!childHidden.some((item) => item.href.startsWith("/erp/settings")));
});

test("canSee and finance-only restrictions remain in place", () => {
  const employee = build({ role: "Employee", pages: [{ label: "Work", href: "/tasks" }] });
  assert.ok(!employee.some((item) => item.destination?.access === "admin" || item.destination?.access === "hr"));
  const accountant = build({ role: "Accountant", financeOnly: true, pages: [{ label: "Finance", href: "/finance/desk" }, { label: "Billing", href: "/erp" }], places: [{ label: "Account", href: "/account" }] });
  assert.deepEqual(accountant.map((item) => item.href), ["/finance/desk", "/erp"]);
  assert.equal(hits(accountant, "invoices")[0].href, "/erp");
});

test("a Settings tab in places does not suppress the main Settings destination", () => {
  const items = build({ places: [{ label: "Who can do what", href: "/settings?tab=work-rules" }] });
  assert.ok(items.some((item) => item.href === "/settings?tab=work-rules"));
  assert.ok(items.some((item) => item.key === "dest:settings"));
});
