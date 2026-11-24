// WORKFLOW-QA (14 Nov 2026): People & pay's set-up rules (pay-setup.mjs), from walking "Set up pay for all 24 staff".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inBatches, offerStart, ownPayLine, readAll, setupStartDay, setupTotalLabel, setupWalk, waitingSetups } from "./pay-setup.mjs";

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

test("Approve all: the approvals go four at a time, all of them, and progress counts each one (WORKFLOW-QA-2)", async () => {
  let live = 0, most = 0; const seen = [], counts = [];
  const r = await inBatches(Array.from({ length: 23 }, (_, i) => i), async (i) => {
    live++; most = Math.max(most, live); await new Promise((ok) => setTimeout(ok, 5 + (i % 3))); seen.push(i); live--;
  }, { onDone: (n) => counts.push(n) });
  assert.equal(r.done, 23); assert.equal(r.failed, null);
  assert.equal(most, 4, "four at once, never more");
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 23 }, (_, i) => i), "each one exactly once");
  assert.deepEqual(counts, Array.from({ length: 23 }, (_, i) => i + 1));
});

test("Approve all: after a refusal no new approval starts, and the first refusal in the list is the one shown", async () => {
  const started = [];
  const r = await inBatches(Array.from({ length: 12 }, (_, i) => i), async (i) => {
    started.push(i); await new Promise((ok) => setTimeout(ok, i === 1 ? 20 : 2));
    if (i === 1 || i === 2) throw new Error(`refused ${i}`);
  });
  assert.equal(r.failed?.item, 1, "the earlier one in the list");
  assert.match(String(r.failed?.error), /refused 1/);
  assert.ok(started.length < 12, `stopped starting new ones (${started.length} started)`);
  assert.equal(r.done, started.length - 2);
});

test("Approve all: an empty list does nothing; one at a time still works", async () => {
  assert.deepEqual(await inBatches([], async () => { throw new Error("never"); }), { done: 0, failed: null });
  const order = []; await inBatches([1, 2, 3], async (i) => { order.push(i); }, { size: 1 });
  assert.deepEqual(order, [1, 2, 3]);
});

test("the own-pay line never says \"You set up 0\" (WORKFLOW-QA-2: a founder whose own pay was the only one left)", () => {
  assert.equal(ownPayLine(24), "You set up 24; a founder sets up yours.");
  assert.equal(ownPayLine(0), "Yours is the one left, and someone else sets it up.");
  assert.doesNotMatch(ownPayLine(0), /\b0\b/);
});

test("the Approve-all drawer reads every person's pay, a failed read once more (WORKFLOW-QA-2: a partial sum was shown as the total)", async () => {
  const asked = new Map();
  const got = await readAll(["a", "b", "c", "d", "e"], async (k) => {
    asked.set(k, (asked.get(k) ?? 0) + 1);
    if (k === "b" && asked.get(k) === 1) throw new Error("network");   // fails once, then answers
    if (k === "d") return null;                                        // never answers
    return k.charCodeAt(0);
  });
  assert.deepEqual([...got.keys()].sort(), ["a", "b", "c", "e"]);
  assert.equal(asked.get("b"), 2, "a failed read is tried once more");
  assert.equal(asked.get("d"), 2, "and only once more");
  assert.equal(asked.get("a"), 1, "an answered read is not repeated");
  let on = true; const stopped = await readAll(["a", "b"], async (k) => { on = false; return k; }, { size: 1, live: () => on });
  assert.equal(stopped.size, 1, "stops when the drawer closes");
});

test("the drawer's total says how many it covers when some pay could not be shown", () => {
  assert.equal(setupTotalLabel(23, 23), "23 people · pay a month in all");
  assert.equal(setupTotalLabel(1, 1), "1 person · pay a month in all");
  assert.equal(setupTotalLabel(19, 23), "Pay a month for 19 of 23 people · 4 could not be shown");
});
