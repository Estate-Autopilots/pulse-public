import assert from "node:assert/strict";
import test from "node:test";
import { companyCard, handleOf, inviteBody, limitOf, personCard, queryOf, SEARCHES_PER_MINUTE } from "../dist/directory.js";

// COMPANY-SEARCH (1891): what the directory API answers. Synthetic values only (the leak gate's reviewed GSTIN).
const row = { id: "00000000-0000-0000-0000-0000000000aa", handle: "lotusinteriors", name: "Lotus Interiors", legal_name: null, city: "Pune",
  industry: null, website: null, logo_version: 3, verified_by: "gstin", ids: [{ kind: "gstin", label: "GSTIN", value: "27AABCS5678K1ZS" }], match: "id", score: 100 };

test("a company card has exactly the contract's fields (no score, nothing else)", () => {
  const c = companyCard(row);
  assert.deepEqual(Object.keys(c).sort(), ["city", "id", "ids", "industry", "legalName", "logo", "match", "name", "verified", "verifiedBy", "website", "handle"].sort());
  assert.equal(c.logo, "/api/v0/directory/companies/lotusinteriors/logo?v=3");
  assert.equal(c.verified, true);
  assert.equal(companyCard({ ...row, logo_version: null, verified_by: null }).logo, null);
  assert.equal(companyCard({ ...row, verified_by: null }).verified, false);
  assert.equal("match" in companyCard(row, false), false);
  // A column the database might add later never reaches the answer.
  assert.equal("secret" in companyCard({ ...row, secret: "x" }), false);
});

test("a person card shows e-mail and phone only as the database gave them", () => {
  const p = personCard({ handle: "fakeperson", name: "Fake Person", headline: null, photo_version: null, company_handle: "lotusinteriors",
    company_name: "Lotus Interiors", email: null, phone: null, match: "handle", account_id: "hidden" });
  assert.deepEqual(p, { handle: "fakeperson", name: "Fake Person", headline: null, photo: null, company: { handle: "lotusinteriors", name: "Lotus Interiors" },
    email: null, phone: null, match: "handle" });
});

test("inputs: limit, query, handle", () => {
  assert.equal(limitOf("5"), 5);
  assert.equal(limitOf("500"), 8);
  assert.equal(limitOf("x"), 8);
  assert.equal(queryOf("  vitals  "), "vitals");
  assert.equal(queryOf(["a"]), "");
  assert.equal(queryOf("x".repeat(500)).length, 120);
  assert.equal(handleOf("@LotusInteriors"), "lotusinteriors");
  assert.throws(() => handleOf("../etc"), /could not find/);
  assert.ok(SEARCHES_PER_MINUTE >= 60 && SEARCHES_PER_MINUTE <= 600);
});

test("an invite needs a company name and an e-mail or a phone", () => {
  assert.deepEqual(inviteBody({ companyName: " Lotus ", email: "owner@lotus.example", purpose: "contract" }),
    { companyName: "Lotus", email: "owner@lotus.example", phone: null, purpose: "contract", note: null });
  assert.equal(inviteBody({ companyName: "Lotus", phone: "9000012345", purpose: "anything" }).purpose, "general");
  assert.throws(() => inviteBody({ companyName: "Lotus" }), /e-mail or a phone/);
  assert.throws(() => inviteBody({ email: "owner@lotus.example" }), /company's name/);
  assert.throws(() => inviteBody([]), /company name/);
});
