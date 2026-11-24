// QUOTE-STRUCT (Kazuk's build guide, 16 Nov 2026): a package opened phase by phase on a quotation. Invented names only.
import assert from "node:assert/strict";
import test from "node:test";
import { autoPercent, changes, offered, startDims, withDims, groupLines, opensIntoParts, packageLabel, packageLines, packageMonths, packageTotal, phaseOf, swapOptions, swapTo } from "./quote-phases.mjs";

const PHASES = [{ key: "plan", name: "Phase 1: Plan", groups: [] }, { key: "make", name: "Phase 2: Make", groups: ["Attention", "Trust"] }, { key: "run", name: "Phase 3: Run", groups: [] }];
const pkg = { id: "pkg-1", name: "Bundle Two", description: "your team and your ad spend stay yours", sac: "998361", gstRate: 18 };
const part = (o) => ({ position: 0, itemId: null, label: "Part", quantity: 1, unit: null, price: null, itemPrice: null, itemName: null, sac: null, itemUnit: null, gstRate: 18, phase: null, phaseGroup: null, included: false, ...o });
const PARTS = [
  part({ itemId: "i-study", label: "Market study", price: 420000, itemPrice: 420000, phase: "plan" }),
  part({ itemId: "i-video", label: "Video ad (standard)", quantity: 2, price: 3350550, itemPrice: 3350550, phase: "make", phaseGroup: "Attention" }),
  part({ itemId: "i-test", label: "First test", price: null, itemPrice: 0, phase: "make", phaseGroup: "Attention", included: true }),
  part({ itemId: "i-ads", label: "Ads and nurturing", quantity: 4, unit: "month", price: null, itemPrice: 700000, phase: "run" }),
  part({ itemId: "i-kit", label: "Partner kit", price: 0, itemPrice: 1000000 }),
  part({ label: "Coaching", price: null }),
];

test("a package opens into one line per part, under its item's phase, priced per unit from the package or the item", () => {
  const lines = packageLines(pkg, PARTS, PHASES);
  assert.deepEqual(lines.map((l) => [l.description, l.qty, l.rate, l.role, l.phase, l.phaseGroup]), [
    ["Market study", 1, 420000, null, "Phase 1: Plan", null],
    ["Video ad (standard)", 2, 3350550, null, "Phase 2: Make", "Attention"],
    ["First test", 1, 0, "included", "Phase 2: Make", "Attention"],
    ["Ads and nurturing", 4, 700000, null, "Phase 3: Run", null],
    ["Partner kit", 1, 0, "bonus", null, null],
    ["Coaching", 1, 0, "to_quote", null, null],
  ]);
  assert.ok(lines.every((l) => l.packageId === "pkg-1" && l.packageLabel === "Bundle Two · your team and your ad spend stay yours"));
  assert.equal(lines[4].listRate, 1000000);
  assert.deepEqual(lines[1].packageDefault, { qty: 2, rate: 3350550, itemId: "i-video" });
  // The package's total is its kept, priced lines: 4,200 + 2 × 33,505.50 + 4 × 7,000.
  assert.equal(packageTotal(lines, "pkg-1"), 420000 + 6701100 + 2800000);
});

test("a package sold at nothing gives its parts as bonuses, priced or not", () => {
  const lines = packageLines({ ...pkg, price: 0 }, [part({ label: "Kit", price: null }), part({ itemId: "i-v", label: "Film", price: 0, itemPrice: 759375 })], PHASES);
  assert.deepEqual(lines.map((l) => [l.role, l.listRate]), [["bonus", null], ["bonus", 759375]]);
});

test("a package of unpriced deliverables stays one line; labels skip long or Includes descriptions", () => {
  assert.equal(opensIntoParts([part({ label: "Script" }), part({ label: "Edit" })]), false);
  assert.equal(opensIntoParts(PARTS), true);
  assert.equal(packageLabel({ name: "Plain", description: "Includes: a, b" }), "Plain");
  assert.equal(packageLabel({ name: "Long", description: "x".repeat(200) }), "Long");
});

test("changes from the package's default: added, removed, quantity, price, swapped", () => {
  const [study, video] = packageLines(pkg, PARTS, PHASES);
  assert.deepEqual(changes(study), []);
  assert.deepEqual(changes({ ...video, qty: 3 }), ["+1"]);
  assert.deepEqual(changes({ ...video, qty: 1, rate: 3000000 }), ["−1", "price changed"]);
  assert.deepEqual(changes({ ...video, notNeeded: true }), ["removed"]);
  assert.deepEqual(changes({ ...study, packageDefault: null }), ["added"]);
  assert.deepEqual(changes({ ...video, itemId: "i-lux" }), ["swapped"]);
  assert.deepEqual(changes({ description: "loose", qty: 1, rate: 1 }), []);
});

test("lines group by phase in order, sub-groups kept, loose lines under Other items, bonuses last", () => {
  const lines = [{ description: "Own line", qty: 1, rate: 1 }, ...packageLines(pkg, PARTS, PHASES)];
  const g = groupLines(lines);
  assert.deepEqual(g.map((x) => [x.name, x.lines.map((l) => l.description)]), [
    ["Phase 1: Plan", ["Market study"]], ["Phase 2: Make", ["Video ad (standard)", "First test"]], ["Phase 3: Run", ["Ads and nurturing"]],
    ["Other items", ["Own line", "Coaching"]], ["Bonuses included", ["Partner kit"]],
  ]);
  assert.deepEqual(g[1].subGroups, ["Attention"]);
  // A quotation with no phases at all is one unnamed group.
  assert.deepEqual(groupLines([{ description: "a", qty: 1, rate: 1 }]).map((x) => x.name), [null]);
});

test("a part swaps for a variant in the same phase and sub-group; quantity, phase and package stay", () => {
  const items = [{ id: "i-video", kind: "service", name: "Video ad (standard)", price: 3350550, phase: "make", phaseGroup: "Attention" },
    { id: "i-lux", kind: "service", name: "Video ad (luxury)", price: 6125000, phase: "make", phaseGroup: "Attention", gstRate: 18 },
    { id: "i-page", kind: "service", name: "Landing page", price: 1, phase: "make", phaseGroup: "Trust" }, { id: "i-old", kind: "service", name: "Old", price: 1, phase: "make", phaseGroup: "Attention", status: "archived" }];
  const video = packageLines(pkg, PARTS, PHASES)[1];
  assert.deepEqual(swapOptions(video, items).map((i) => i.id), ["i-lux"]);
  const lux = swapTo(video, items[1]);
  assert.equal(lux.rate, 6125000); assert.equal(lux.qty, 2); assert.equal(lux.phase, "Phase 2: Make");
  // QUOTE-BUILDER-4 (Kazuk, 19 Nov): a swap at the new item's catalogue price is a swap, not a price change.
  assert.deepEqual(changes(lux), ["swapped"]);
  assert.deepEqual(changes({ ...lux, rate: 6000000 }), ["swapped", "price changed"]);
  assert.equal(swapTo(video, { id: "x", kind: "service", name: "Priced later", price: 0 }).role, "to_quote");
  assert.deepEqual(phaseOf(PHASES, { phase: "make", phaseGroup: "Nope" }), { phase: "Phase 2: Make", phaseOrder: 1, phaseGroup: null });
});

// QUOTE-BUILDER-4 (Kazuk's 19 Nov test, VTI task 1514f831): Neeti, sold per user per month, opens in two numbers.
const NEETI_TIERS = [{ months: 2, percent: 0 }, { months: 3, percent: 5 }, { months: 6, percent: 10 }, { months: 12, percent: 15 }];
const growth = { id: "pkg-g", name: "Growth Package", description: "4-month term. Two creative sets and the sales system", gstRate: 18 };
const P4 = [{ key: "sales", name: "Phase 4: Sales system", groups: [] }];
const neetiPart = part({ itemId: "i-pro", label: "Seats (pro)", quantity: 20, price: 113905, itemPrice: 119900, itemUnit: "user/month", phase: "sales" });

test("a part sold per user per month opens as users × months, at the item's price less the prepaid discount", () => {
  assert.equal(packageMonths(growth, []), 4);
  assert.equal(packageMonths({ name: "Bundle" }, [part({ unit: "month", quantity: 6 })]), 6);
  assert.equal(packageMonths({ name: "Bundle" }, []), null);
  const [l] = packageLines(growth, [neetiPart], P4, (id) => (id === "i-pro" ? NEETI_TIERS : []));
  assert.deepEqual(l.qtyDims, [{ n: 5, unit: "user" }, { n: 4, unit: "month" }]);
  assert.equal(l.qty, 20);
  assert.equal(l.rate, 119900, "the item's own price per user per month");
  assert.equal(l.discountPercent, 5, "4 months prepaid: 5 %");
  assert.equal(l.phase, "Phase 4: Sales system", "in its phase, not Other items");
  assert.equal(packageTotal([l], "pkg-g"), 2278100, "₹22,781 = 20 × ₹1,139.05, the package's own price for it");
  assert.deepEqual(changes(l, NEETI_TIERS), []);
  // 6 users × 6 months: two numbers changed, the discount follows the months (10 %): no "price changed".
  const six = { ...l, qty: 36, qtyDims: [{ n: 6, unit: "user" }, { n: 6, unit: "month" }], discountPercent: 10 };
  assert.deepEqual(changes(six, NEETI_TIERS), ["+1 user", "+2 months"]);
  assert.equal(autoPercent(six, NEETI_TIERS), 10);
  // The seller's own percent off is a price change.
  assert.deepEqual(changes({ ...six, discountPercent: 12 }, NEETI_TIERS), ["+1 user", "+2 months", "price changed"]);
  // Without tiers the package's price stays as it is, still in two numbers.
  const [plain] = packageLines(growth, [neetiPart], P4);
  assert.equal(plain.rate, 113905); assert.equal(plain.discountPercent, null); assert.equal(plain.qtyDims.length, 2);
  // A quantity that does not split into whole users over the months stays one number.
  assert.equal(packageLines(growth, [{ ...neetiPart, quantity: 7 }], P4)[0].qtyDims, undefined);
});

test("swapping Neeti Professional for AI keeps the users, months and prepaid discount", () => {
  const [l] = packageLines(growth, [neetiPart], P4, () => NEETI_TIERS);
  const ai = swapTo(l, { id: "i-ai", kind: "service", name: "Seats (AI)", price: 189900, unit: "user/month", phase: "sales" });
  assert.deepEqual(ai.qtyDims, l.qtyDims); assert.equal(ai.discountPercent, 5); assert.equal(ai.rate, 189900);
  assert.deepEqual(changes(ai, NEETI_TIERS), ["swapped"]);
  const flat = swapTo(l, { id: "i-flat", kind: "service", name: "Flat fee", price: 500000, unit: "nos", phase: "sales" });
  assert.equal(flat.qtyDims, null); assert.equal(flat.discountPercent, null);
});

test("users and months change on a line: the quantity and the prepaid discount follow, a typed percent stays", () => {
  assert.deepEqual(startDims("user/month", 4), [{ n: 1, unit: "user" }, { n: 4, unit: "month" }]);
  assert.equal(startDims("nos"), null);
  const line = { qty: 20, qtyDims: [{ n: 5, unit: "user" }, { n: 4, unit: "month" }], discountPercent: 5 };
  assert.deepEqual(withDims(line, [{ n: 6, unit: "user" }, { n: 6, unit: "month" }], NEETI_TIERS), { qtyDims: [{ n: 6, unit: "user" }, { n: 6, unit: "month" }], qty: 36, discountPercent: 10, discount: 0 });
  assert.equal(withDims(line, [{ n: 5, unit: "user" }, { n: 12, unit: "month" }], NEETI_TIERS).discountPercent, 15);
  assert.equal(withDims(line, [{ n: 5, unit: "user" }, { n: 1, unit: "month" }], NEETI_TIERS).discountPercent, null);
  const typed = withDims({ ...line, discountPercent: 8 }, [{ n: 6, unit: "user" }, { n: 6, unit: "month" }], NEETI_TIERS);
  assert.equal(typed.qty, 36); assert.equal("discountPercent" in typed, false, "the seller's own 8 % stays");
});

test("only active catalogue items are offered: never a draft or an archived one", () => {
  assert.ok(offered({ status: "active" })); assert.ok(offered({}));
  assert.ok(!offered({ status: "draft" })); assert.ok(!offered({ status: "archived" }));
  const items = [{ id: "a", kind: "service", phase: "sales", status: "active" }, { id: "b", kind: "service", phase: "sales", status: "draft" }, { id: "c", kind: "service", phase: "sales", status: "active" }];
  assert.deepEqual(swapOptions({ itemId: "a" }, items).map((i) => i.id), ["c"]);
});
