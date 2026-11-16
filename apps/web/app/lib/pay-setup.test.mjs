// WORKFLOW-QA (14 Nov 2026): People & pay's set-up rules (pay-setup.mjs), from walking "Set up pay for all 24 staff".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { offerStart, setupStartDay, setupWalk, waitingSetups } from "./pay-setup.mjs";

test("a first set-up starts on the 1st of the month, or the joining day when later: never today by default", () => {
  assert.equal(setupStartDay("2026-11-14", "2025-06-02"), "2026-11-01");
  assert.equal(setupStartDay("2026-11-14", null), "2026-11-01");
  assert.equal(setupStartDay("2026-11-14", "2026-11-10"), "2026-11-10", "joined this month: from the joining day");
  assert.equal(setupStartDay("2026-11-14", "2026-11-20"), "2026-11-20", "joins later: from the joining day");
});

const row = (id, extra = {}) => ({ id, name: id, current: true, hasRecord: false, action: { key: "setup", label: "Set up pay" }, ...extra });

test("the set-up walk is everyone without pay except the person looking (nobody proposes their own pay)", () => {
  const people = [row("Kedab"), row("Asha"), row("Bela", { hasRecord: true }), row("Old", { current: false }), row("Zed")];
  assert.deepEqual(setupWalk(people, "Kedab").map((p) => p.id), ["Asha", "Zed"]);
  assert.deepEqual(setupWalk(people, null).map((p) => p.id), ["Asha", "Kedab", "Zed"]);
  assert.deepEqual(setupWalk(null, "x"), []);
});

test("a founder's waiting set-ups are the proposed first set-ups the API offers them to review", () => {
  const review = { key: "change.approve", label: "Review change" };
  const people = [
    row("Raise", { hasRecord: true, action: review, change: { id: "1", kind: "raise", status: "proposed", effectiveOn: "2026-11-01" } }),
    row("Yash", { hasRecord: true, action: review, change: { id: "2", kind: "start", status: "proposed", effectiveOn: "2026-11-01" } }),
    row("Own", { hasRecord: true, action: null, change: { id: "3", kind: "start", status: "proposed", effectiveOn: "2026-11-01" } }),
    row("Anu", { hasRecord: true, action: review, change: { id: "4", kind: "start", status: "proposed", effectiveOn: "2026-11-01" } }),
  ];
  assert.deepEqual(waitingSetups(people).map((p) => p.id), ["Anu", "Yash"]);
});

test("People & pay uses these rules (the form's default day, the walk, the founder's Approve all)", () => {
  const flows = readFileSync(new URL("../people/pay/flows.tsx", import.meta.url), "utf8");
  const home = readFileSync(new URL("../people/pay/home.tsx", import.meta.url), "utf8");
  assert.match(flows, /useState\(start \? setupStartDay\(p\.today, p\.person\.joinedOn\)/);
  assert.match(home, /setupWalk\(data\.people, me\)/);
  assert.match(home, /waitingSetups\(data\.people\)/);
});

test("BUG-SWEEP-2: a new offer is filled in from the pay record; an edited offer keeps its own; a new hire starts empty", () => {
  const inForce = { payType: "salary", figures: { monthly: 4_800_000, ctc: null, rate: null, hours: null } };
  assert.deepEqual(offerStart(inForce, null), { payType: "salary", monthly: "48000", rate: "", hours: "", fromPay: true });
  const offer = { payType: "salary", figures: { monthly: 5_500_000 } };
  assert.deepEqual(offerStart(inForce, offer), { payType: "salary", monthly: "55000", rate: "", hours: "", fromPay: false });
  assert.deepEqual(offerStart(null, null), { payType: "salary", monthly: "", rate: "", hours: "", fromPay: false });
  assert.deepEqual(offerStart({ payType: "salary", figures: null }, null), { payType: "salary", monthly: "", rate: "", hours: "", fromPay: false }, "figures sealed from this reader");
  assert.deepEqual(offerStart({ payType: "hourly", figures: { monthly: 0, rate: 50_000, hours: 80 } }, undefined), { payType: "hourly", monthly: "0", rate: "500", hours: "80", fromPay: true });
});
