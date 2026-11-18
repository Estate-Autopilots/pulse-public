// AI-CONNECT: the six plain groups on the consent screen and in Settings → Connect your AI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OAUTH_SCOPES } from "./oauth-web.mjs";
import { SCOPE_GROUPS, groupsOf, narrowScopes, scopeSummary } from "./oauth-scope-groups.mjs";

test("every OAuth scope is in exactly one group, and every grouped scope exists", () => {
  const grouped = SCOPE_GROUPS.flatMap((g) => g.scopes);
  assert.deepEqual([...grouped].sort(), [...OAUTH_SCOPES].sort());
  assert.equal(new Set(grouped).size, grouped.length);
});
test("the brief's areas are their own groups: read docs/tasks, write docs/tasks, contracts, quotes", () => {
  const of = (k) => SCOPE_GROUPS.find((g) => g.key === k).scopes;
  for (const s of ["docs.read", "tasks.read", "projects.read", "search.read"]) assert.ok(of("read").includes(s), s);
  for (const s of ["docs.write", "tasks.write", "projects.write"]) assert.ok(of("write").includes(s), s);
  assert.deepEqual(of("contracts"), ["contracts.read", "contracts.write"]);
  assert.ok(of("quotes").includes("billing.read") && of("quotes").includes("billing.write"));
  // Plain words: short sentences without the scope codes.
  for (const g of SCOPE_GROUPS) { assert.doesNotMatch(g.label, /\.(read|write)\b/); assert.ok(g.label.split(" ").length <= 20, g.key); }
});
test("only the scopes asked for, in the groups ticked, are granted", () => {
  assert.deepEqual(narrowScopes(OAUTH_SCOPES, ["read"]).sort(), ["docs.read", "people.read", "projects.read", "search.read", "tasks.read"]);
  assert.deepEqual(narrowScopes(["docs.read", "docs.write"], ["read", "contracts"]), ["docs.read"]);
  assert.deepEqual(narrowScopes(["docs.read"], []), []);
  assert.deepEqual(narrowScopes(["docs.read", "made.up"], ["read", "more"]), ["docs.read"]);
});
test("groupsOf keeps only what was asked; the summary is one short line", () => {
  assert.deepEqual(groupsOf(["contracts.read", "tasks.write"]).map((g) => [g.key, g.scopes]), [["write", ["tasks.write"]], ["contracts", ["contracts.read"]]]);
  assert.equal(scopeSummary(["docs.read", "docs.write", "contracts.read"]), "sees docs, tasks and projects · writes docs, tasks and projects · contracts");
  assert.equal(scopeSummary([]), "nothing yet");
});
