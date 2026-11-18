// HR-PEOPLE (T1.1.10–11): the pay policy's answers as plain sentences and as the document everyone accepts.
import assert from "node:assert/strict";
import test from "node:test";
import { splitPay as apiSplit, DEFAULT_TEMPLATE } from "../../../../services/api/src/comp-model.ts";
import { ANSWER_FIELDS, EXAMPLE_GROSS, inr, partRule, payPolicyDoc, splitPay } from "../people/pay/policy-doc.mjs";

const policy = { approvers: "founders", probationApproval: "hr", managers: "none", probationDays: 90, remindDays: 14, noticeProbation: null, noticeConfirmed: 30,
  offerDays: 7, encashBasis: "basic", encashDivisor: 30, recoverMax: 12, components: DEFAULT_TEMPLATE,
  claimCategories: [{ key: "travel", label: "Travel", cap: 3000 }], claimThreshold: 5000 };

test("the split is the API's split, to the paisa", () => {
  for (const gross of [EXAMPLE_GROSS, 1234567, 99, 25000000]) assert.deepEqual(splitPay(gross, DEFAULT_TEMPLATE), apiSplit(gross, DEFAULT_TEMPLATE), `gross ${gross}`);
  const noBalance = [{ key: "basic", label: "Basic", kind: "earning", of: "gross", pct: 60 }, { key: "conv", label: "Conveyance", kind: "earning", of: "gross", pct: 10 }];
  assert.deepEqual(splitPay(EXAMPLE_GROSS, noBalance), apiSplit(EXAMPLE_GROSS, noBalance));
});

test("five answers, each one plain sentence a busy owner reads in a glance", () => {
  const d = payPolicyDoc(policy, { company: "Lotus Interiors", head: "pod head" });
  assert.deepEqual(d.answers.map((a) => a.key), Object.keys(ANSWER_FIELDS));
  assert.equal(d.answers[0].sentence, "A founder approves every pay change, offer, pause and bonus. HR proposes it.");
  assert.equal(d.answers[1].sentence, "Probation is 90 days, with a reminder 14 days before it ends.");
  assert.equal(d.answers[2].sentence, "Notice is 15 days during probation and 30 days after it.", "an empty notice is the exit rule's");
  assert.match(d.answers[4].sentence, /^Basic: 50% of gross pay; House rent allowance: 40% of Basic; Special allowance: the rest\.$/);
  for (const a of d.answers) assert.ok(a.sentence.length < 160 && !/undefined|NaN|null/.test(a.sentence + a.more), a.sentence);
});

test("the document says the numbers the answers gave, with the ₹40,000 example", () => {
  const d = payPolicyDoc(policy, { company: "Lotus Interiors", head: "pod head" });
  assert.match(d.body, /^This policy says how pay works at Lotus Interiors\./);
  for (const h of ["## 1. Who approves pay", "## 2. Probation and offers", "## 3. Notice", "## 4. A day's pay, leave and advances", "## 5. How your salary is split", "## 6. Claims", "## What happens next"]) assert.ok(d.body.includes(h), h);
  assert.ok(d.body.includes("| Basic | 50% of gross pay | ₹20,000 |"));
  assert.ok(d.body.includes("| House rent allowance | 40% of Basic | ₹8,000 |"));
  assert.ok(d.body.includes("| Special allowance | the rest | ₹12,000 |"));
  assert.ok(d.body.includes("| Employer PF (paid by the company) | 12% of Basic, at most ₹1,800 a month | ₹1,800 |"));
  assert.ok(d.body.includes("Your pod head approves a claim; above ₹5,000, HR or a founder approves it too."));
  assert.ok(d.body.length >= 10 && d.body.length <= 30000, "fits a policy document (policy_draft_save)");
  assert.doesNotMatch(d.body, /undefined|NaN|null|\{\{/);
  assert.equal(d.title, "Pay policy");
});

test("other answers read right too", () => {
  const d = payPolicyDoc({ ...policy, approvers: "second_hr", probationApproval: "founder", encashBasis: "none", encashDivisor: 26, recoverMax: 1, components: [], claimCategories: [] });
  assert.equal(d.answers[0].sentence, "A second person in HR approves every pay change, offer, pause and bonus. HR proposes it.");
  assert.equal(d.answers[3].sentence, "A day's pay is monthly pay ÷ 26 working days. An advance or loan is paid back within 1 month.");
  assert.equal(d.answers[3].more, "Unused leave is not paid out.");
  assert.equal(d.answers[4].sentence, "Pay is one amount a month, not split.");
  assert.doesNotMatch(d.body, /## 6\. Claims/);
  assert.equal(partRule({ key: "x", label: "X", kind: "earning", balance: true }, []), "the rest");
  assert.equal(inr(118000000), "₹11,80,000");
});
