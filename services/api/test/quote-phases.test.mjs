import assert from "node:assert/strict";
import test from "node:test";
import { cleanPhases, phaseKey, phaseOfItem } from "../dist/quote-phases.js";
import { cleanLines, copyLine, documentInput, soldLines } from "../dist/erp-model.js";
import { cleanCard, hiddenCard, partPrice } from "../dist/rate-card-model.js";

// QUOTE-STRUCT (Kazuk's build guide, 16 Nov 2026; migration 2252): phases, phase-wise quotation lines and rate cards as a
// seat that does not see cost reads them. Invented names and figures only.
const PKG = "0f4c2d6e-aaaa-4bbb-8ccc-000000000001", ITEM = "0f4c2d6e-aaaa-4bbb-8ccc-000000000002";

test("phases: named once, in order, keys kept when renamed and made from names otherwise", () => {
  const p = cleanPhases([{ name: " Phase 1: Plan™ ", groups: ["Attention", "attention", " Trust "] }, { key: "make", name: "Phase 2: Make" }, { name: "2nd wave" }]);
  assert.deepEqual(p, [{ key: "phase-1-plan", name: "Phase 1: Plan™", groups: ["Attention", "Trust"] }, { key: "make", name: "Phase 2: Make", groups: [] }, { key: "p2nd-wave", name: "2nd wave", groups: [] }]);
  assert.throws(() => cleanPhases([{ name: "A" }, { name: "a" }]), /Two phases/);
  assert.throws(() => cleanPhases([{ name: "" }]), /name it/);
  assert.throws(() => cleanPhases(Array.from({ length: 21 }, (_, i) => ({ name: `P${i}` }))), /up to 20/);
  assert.deepEqual(cleanPhases("nonsense", { lenient: true }), []);
  assert.equal(phaseKey("Plan", new Set(["plan"])), "plan-2");
  assert.deepEqual(phaseOfItem(p, { phase: "make" }), { phase: "Phase 2: Make", phaseOrder: 1, phaseGroup: null });
  assert.deepEqual(phaseOfItem(p, { phase: "phase-1-plan", phaseGroup: "Trust" }), { phase: "Phase 1: Plan™", phaseOrder: 0, phaseGroup: "Trust" });
  assert.deepEqual(phaseOfItem(p, { phase: "gone" }), { phase: null, phaseOrder: null, phaseGroup: null });
});

test("a part line keeps its phase, package and default; a free role is priced at nothing", () => {
  const [l, inc, bonus] = cleanLines([
    { description: "Video ad", qty: 3, rate: 3350550, phase: "Phase 2: Make", phaseOrder: 1, phaseGroup: "Attention", packageId: PKG, packageLabel: "Bundle", packageDefault: { qty: 2, rate: 3350550, itemId: ITEM } },
    { description: "First test", rate: 0, role: "included", open: true, phase: "Phase 2: Make", phaseOrder: 1 },
    { description: "Partner kit", rate: 0, role: "bonus", listRate: 1000000 },
  ]);
  assert.equal(l.phase, "Phase 2: Make"); assert.equal(l.phaseGroup, "Attention"); assert.equal(l.packageId, PKG);
  assert.deepEqual(l.packageDefault, { qty: 2, rate: 3350550, itemId: ITEM });
  assert.equal(inc.role, "included"); assert.equal(inc.open, false);
  assert.equal(bonus.listRate, 1000000);
  assert.throws(() => cleanLines([{ description: "x", rate: 100, role: "included" }]), /priced at nothing/);
  assert.throws(() => cleanLines([{ description: "x", rate: 0, role: "free" }]), /included, to be quoted or bonus/);
  assert.throws(() => cleanLines([{ description: "x", rate: 0, phase: "P", phaseOrder: 100 }]), /0 to 99/);
  // An older client sends none of it and gets a plain line.
  const [plain] = cleanLines([{ description: "Plain", rate: 100 }]);
  assert.equal(plain.phase, null); assert.equal(plain.role, null); assert.equal(plain.packageId, null); assert.equal(plain.packageLabel, null);
  // A package label or default without the package is not kept.
  const [loose] = cleanLines([{ description: "x", rate: 1, packageLabel: "Bundle", packageDefault: { qty: 1, rate: 1 } }]);
  assert.equal(loose.packageLabel, null); assert.equal(loose.packageDefault, null);
});

test("stored lines print their phases, and a to-be-quoted line is left off a proforma or invoice", () => {
  const stored = [
    { description: "Plan", qty: 1, rate: 420000, gst_rate: 18, discount: 0, phase: "Phase 1", phase_order: 0, package_id: PKG, package_label: "Bundle", parent_position: null },
    { description: "Coaching", qty: 1, rate: 0, gst_rate: 18, discount: 0, line_role: "to_quote", phase: "Phase 5", phase_order: 4, parent_position: null },
    { description: "Ads", qty: 4, rate: 700000, gst_rate: 18, discount: 0, unit: "month", phase: "Phase 3", phase_order: 2, parent_position: null },
    { description: "Ads add-on", qty: 1, rate: 1000, gst_rate: 18, discount: 0, parent_position: 2 },
    { description: "Kit", qty: 1, rate: 0, gst_rate: 18, discount: 0, line_role: "bonus", list_rate: 1000000, parent_position: null, not_needed: true },
  ];
  const input = documentInput({ doc_type: "quotation", status: "draft", issue_date: "2026-11-17" }, stored);
  assert.deepEqual(input.lines.map((l) => [l.description, l.phase ?? null, l.role ?? null, l.packageLabel ?? null]), [["Plan", "Phase 1", null, "Bundle"], ["Coaching", "Phase 5", "to_quote", null], ["Ads", "Phase 3", null, null], ["Ads add-on", null, null, null]]);
  assert.equal("phase" in input.lines[3], false);
  const sold = soldLines(stored);
  assert.deepEqual(sold.map((l) => [l.description, l.parentIndex]), [["Plan", null], ["Ads", null], ["Ads add-on", 1], ["Kit", null]]);
  assert.equal(copyLine(stored[0]).packageId, PKG);
  assert.equal(copyLine(stored[4], { withNotNeeded: true }).notNeeded, true);
});

test("a seat that does not see cost reads no base or factors, and prices every X the same", () => {
  const card = { id: "c", ...cleanCard({ itemId: ITEM, name: "Synthetic CRM", base: 20000, xLabel: "Users", xMin: 1, xMax: 50,
    talents: [{ label: "Basic", factor: 2.995 }, { label: "Pro", factor: 5.995 }], periods: [{ label: "3 months", months: 3, factor: 0.95 }, { label: "12 months", months: 12, factor: 0.85 }] }) };
  const hidden = hiddenCard(card);
  assert.equal(hidden.base, null);
  assert.ok(hidden.talents.every((t) => t.factor === null) && hidden.periods.every((p) => p.factor === null));
  assert.ok(!JSON.stringify(hidden).includes("2.995") && !JSON.stringify(hidden).includes("20000,"));
  for (const t of ["basic", "pro"]) for (const p of ["x3-months", "x12-months"]) for (const x of [1, 5, 7.5, 50]) {
    const exact = partPrice(card, { part: "base", x, talent: t, period: p });
    const viaUnits = Number((BigInt(hidden.units[t][p]) * BigInt(Math.round(x * 1000)) * 2n + 10n ** 15n) / (2n * 10n ** 15n));
    assert.equal(viaUnits, exact, `${t} ${p} ${x}`);
  }
});
