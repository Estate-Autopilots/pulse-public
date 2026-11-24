// DEMO-PULSE-2: the demo company's fixture is safe to show (made-up, nobody reachable, no money taken) and fits the API.
// node --test tools/qa/vitals/demo-org.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { demoFixture } from "./demo-org.mjs";

test("nobody can be reached and no money can be taken: no phone, no e-mail, plainly made-up bank details", () => {
  const f = demoFixture();
  const all = JSON.stringify(f);
  assert.ok(!/\b[6-9]\d{4}\s?\d{5}\b|\+91/.test(all), "no Indian mobile number anywhere");
  assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(all), "no e-mail address anywhere");
  assert.ok(!f.settings.company.email && !f.settings.company.phone && !f.settings.company.gstin, "no company e-mail, phone or GSTIN");
  const b = f.template.design.bank;
  assert.match(b.bankName, /demo/i);
  assert.match(b.accountNumber, /demo/i);
  assert.equal(b.upi, "");
  assert.match(f.template.design.footer, /not a real business/i);
  assert.match(f.settings.company.legalName, /\(Demo\)$/);
});

test("the catalogue, customers and quotations fit together and the API's limits", () => {
  const f = demoFixture();
  const codes = new Set(f.items.map((i) => i.code));
  assert.equal(codes.size, f.items.length);
  for (const i of f.items) {
    assert.ok(["service", "product", "consumable", "package"].includes(i.kind), i.code);
    assert.ok(Number.isInteger(i.price) && i.price > 0, i.code);
    assert.match(i.sac, /^\d{4,8}$/);
    assert.ok([5, 12, 18, 28].includes(i.gstRate), i.code);
  }
  const keys = new Set(f.clients.map((c) => c.key));
  assert.equal(keys.size, f.clients.length);
  for (const q of f.quotes) {
    assert.ok(keys.has(q.client), q.client);
    for (const [code, qty] of q.lines) assert.ok(codes.has(code) && qty > 0, code);
  }
  assert.equal(new Set(f.quotes.map((q) => q.client)).size, f.quotes.length, "one quotation per customer (a run again finds it by its customer)");
  assert.ok(f.quotes.filter((q) => q.stage === "invoice").length === 2 && f.quotes.some((q) => q.stage === "proforma"));
  // The live demo makes these itself: they must not be seeded.
  assert.ok(!f.clients.some((c) => /Rifob Mifos/.test(c.displayName || "")));
  assert.ok(f.clients.some((c) => /^Sunrise Apartments/.test(c.companyName || "")) && !f.quotes.some((q) => q.client === "sunrise"));
  // ₹10 lakh: a 40 kW plant for the society is over it, a 5 kW home system under it.
  const price = (code) => f.items.find((i) => i.code === code).price;
  assert.equal(f.settings.quoteAutoLimit, 1_000_000 * 100);
  assert.ok(price("SS-COM-KW") * 40 > f.settings.quoteAutoLimit && price("SS-OG-5") < f.settings.quoteAutoLimit);
  for (const [title, who] of f.tasks) assert.ok(title.length <= 120 && ["owner", "seller", "sales_head", "finance", "admin", "hr"].includes(who), title);
});
