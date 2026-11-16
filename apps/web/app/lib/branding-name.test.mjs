import assert from "node:assert/strict";
import test from "node:test";
import { organizationDisplayName } from "./branding-name.ts";

test("treats the neutral Pulse branding fallback as no company name", () => {
  assert.equal(organizationDisplayName("Pulse"), undefined);
  assert.equal(organizationDisplayName("  Pulse  "), undefined);
  assert.equal(organizationDisplayName("  "), undefined);
});

test("keeps a configured organisation name", () => {
  assert.equal(organizationDisplayName(" Northwind Studio "), "Northwind Studio");
});
