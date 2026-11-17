import test from "node:test";
import assert from "node:assert/strict";
import { companiesText, groupWorkWith, isPractice, isRealCompany, practiceLine, practiceWord, switcherOrder, workWithLine } from "./companies.mjs";

const orgs = [
  { id: "t", name: "Synthetic Sales Test", purpose: "test" },
  { id: "a", name: "Alpha Works", purpose: "work" },
  { id: "me", name: "Asha Rao", orgKind: "personal", mine: true, purpose: "work" },
  { id: "d", name: "Synthetic Demo", purpose: "demo" },
  { id: "b", name: "Beta Studio" },
];

test("test and demo companies are never counted as companies you're in", () => {
  assert.deepEqual(orgs.filter(isRealCompany).map((o) => o.id), ["a", "b"]);
  assert.equal(isPractice(orgs[0]), true);
  assert.equal(isPractice(orgs[4]), false);
  assert.equal(companiesText(orgs.filter(isRealCompany).length), "2 companies");
  assert.equal(companiesText(1), "1 company");
  assert.equal(companiesText(0), "No companies yet");
});

test("the switcher lists my space, then real companies in their order, then test and demo", () => {
  assert.deepEqual(switcherOrder(orgs).map((o) => o.id), ["me", "a", "b", "t", "d"]);
  assert.deepEqual(switcherOrder(null), []);
  assert.equal(practiceWord("demo"), "Demo");
  assert.equal(practiceWord("work"), "");
});

test("work-with lines say who does the work for whom, and group the same company", () => {
  const via = { org: "a", name: "Alpha Works" };
  assert.equal(workWithLine({ key: "1", name: "Gamma", org: "g", handle: null, individual: false, kind: "client", role: null, weServe: true, since: null, via }), "Client of Alpha Works");
  assert.equal(workWithLine({ key: "2", name: "Delta", org: "d", handle: null, individual: false, kind: "vendor", role: "Printing", weServe: false, since: null, via }), "Vendor to Alpha Works · Printing");
  assert.equal(workWithLine({ key: "4", name: "Diya", org: null, handle: null, individual: true, kind: "freelancer", role: "Designer", weServe: false, since: null, via: { org: "p", name: "Asha HQ", personal: true } }), "Freelancer for you · Designer");
  assert.equal(workWithLine({ key: "3", name: "Eta", org: null, handle: null, individual: true, kind: "partner", role: "Referrals", weServe: true, since: null, via }), "Partner of Alpha Works · Referrals");
  const g = groupWorkWith([
    { key: "a:1", name: "Gamma", org: "g", handle: null, individual: false, kind: "client", role: null, weServe: true, since: null, via },
    { key: "b:1", name: "Gamma", org: "g", handle: null, individual: false, kind: "vendor", role: null, weServe: false, since: null, via: { org: "b", name: "Beta Studio" } },
  ]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].lines, ["Client of Alpha Works", "Vendor to Beta Studio"]);
});

test("test and demo companies are named once, in plain words", () => {
  assert.equal(practiceLine([{ name: "Kite Studio", purpose: "demo" }]), "Kite Studio is a demo company, so it is not counted.");
  assert.equal(practiceLine([{ name: "A", purpose: "test" }, { name: "B", purpose: "demo" }]), "A and B are test or demo companies, so they are not counted.");
  assert.equal(practiceLine([]), "");
});
