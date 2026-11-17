// QUOTE-STRUCT (Kazuk's build guide, 16 Nov 2026): a package opened phase by phase on a quotation. Invented names only.
import assert from "node:assert/strict";
import test from "node:test";
import { changes, groupLines, opensIntoParts, packageLabel, packageLines, packageTotal, phaseOf, swapOptions, swapTo } from "./quote-phases.mjs";

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
  assert.equal(lux.rate, 6125000); assert.equal(lux.qty, 2); assert.equal(lux.phase, "Phase 2: Make"); assert.deepEqual(changes(lux), ["swapped", "price changed"]);
  assert.equal(swapTo(video, { id: "x", kind: "service", name: "Priced later", price: 0 }).role, "to_quote");
  assert.deepEqual(phaseOf(PHASES, { phase: "make", phaseGroup: "Nope" }), { phase: "Phase 2: Make", phaseOrder: 1, phaseGroup: null });
});
