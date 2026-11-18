// ONBOARD-SMOOTH (owner, 15 Nov 2026): the STP / ATP plants industry pack (flow/packs.ts `water_plants`) and its plant
// project (flow/templates/plants.ts): the words, the record types, the 77-item work checklist, the QA call script, the
// vendor quotes, the delay reasons, and the "Start your company" choice that brings it.
import assert from "node:assert/strict";
import test from "node:test";
import { problems } from "../dist/flow/model.js";
import { PACK, packPayload, packSummary } from "../dist/flow/packs.js";
import { TEMPLATES } from "../dist/flow/templates/index.js";
import { PLANT_CHECKS, PLANT_DELAY_REASONS, QA_CALL_SCRIPT } from "../dist/flow/templates/plants.js";
import { onboardingPlan } from "../dist/self-serve-model.js";

test("the plants pack speaks the plant company's words and brings its records", () => {
  const p = PACK.get("water_plants");
  assert.ok(p, "the pack exists");
  assert.deepEqual([p.words.client, p.words.project, p.words.run, p.words.team, p.words.lead, p.words.head],
    ["Customer", "Plant", "Plant project", "Site team", "Enquiry", "Site in-charge"]);
  const payload = packPayload(p);
  assert.deepEqual(payload.recordTypes.map((r) => r.def.name), ["Site", "Plant", "BOM item", "Vendor quote", "Delay"]);
  const delay = payload.recordTypes.find((r) => r.key === "delay").def;
  assert.deepEqual(delay.fields.find((f) => f.key === "reason").options, PLANT_DELAY_REASONS);
  assert.ok(PLANT_DELAY_REASONS.includes("Material late from the vendor") && PLANT_DELAY_REASONS.includes("Customer payment pending"));
  const summary = packSummary(p);
  assert.deepEqual(summary.processes.map((x) => x.name), ["Plant project"]);
  assert.ok(summary.roles.some((r) => r.name === "Customer care") && summary.roles.some((r) => r.name === "Site engineer"));
});

test("the plant project: a valid process with a 70–80 item work checklist, a QA call script and 2–3 vendor quotes per item", () => {
  const t = TEMPLATES.find((x) => x.key === "plant_project");
  assert.ok(t, "the template is offered");
  const d = t.definition;
  assert.deepEqual(problems(d).filter((x) => x.level === "error"), []);
  assert.ok(d.steps.every((s) => s.block), "made of primitives");
  const work = d.steps.filter((s) => s.id !== "p7").reduce((n, s) => n + s.checklist.length, 0);
  assert.equal(work, Object.values(PLANT_CHECKS).reduce((n, l) => n + l.length, 0));
  assert.ok(work >= 70 && work <= 80, `work checklist has ${work} items`);
  const groups = JSON.stringify(d.steps.map((s) => s.checklist));
  for (const w of ["Electric panel", "Pumps", "Pipes", "Civil", "Wet run", "Commissioning certificate", "Lab report"]) assert.ok(new RegExp(w, "i").test(groups) || d.steps.some((s) => new RegExp(w, "i").test(s.title)), w);
  const qa = d.steps.find((s) => s.id === "p7");
  assert.equal(qa.who.role, "qa"); assert.deepEqual(qa.checklist, QA_CALL_SCRIPT); assert.equal(QA_CALL_SCRIPT.length, 11);
  const quotes = d.steps.find((s) => s.id === "p8");
  assert.equal(quotes.settings.recordType, "vendor_quote");
  assert.ok(quotes.checklist.every((l) => /[23](–3)? vendor quotes$/.test(l)), "every BOM group gets 2–3 quotes");
  assert.ok(d.rules.some((r) => r.steps?.includes("p7")) && d.rules.some((r) => r.steps?.includes("p16")), "a late QA call and late commissioning are flagged");
  assert.deepEqual(d.terms, { run: "Plant project", runs: "Plant projects" });
  assert.ok(!/\bEA\b|Pod\b|Blueprint/.test(JSON.stringify(d)), "no agency words");
});

test("Start your company: STP / ATP plants brings the plants pack, its modules and a first plant project", () => {
  const p = onboardingPlan({ name: "Nature Solutions demo", templates: ["plants"] });
  assert.equal(p.pack.key, "water_plants");
  assert.deepEqual(p.starters.map((s) => s.name), ["First plant project"]);
  assert.deepEqual(p.companyModules, { chats: true, finance: true });
  assert.ok(!p.modulesDoc.off.includes("hr") && !p.modulesDoc.off.includes("map"));
  assert.equal(onboardingPlan({ name: "Sun Co", templates: ["solar"] }).pack.key, "solar");
});
