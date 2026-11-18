import assert from "node:assert/strict";
import test from "node:test";
import { leadershipTopic } from "./leadership-words.mjs";

test("pay, exits, the company's own money and legal matters read as leadership business", () => {
  assert.equal(leadershipTopic("Write the payroll rules (minimum pay)")?.key, "pay");
  assert.equal(leadershipTopic("October salaries")?.key, "pay");
  assert.equal(leadershipTopic("Appraisal for the design team")?.key, "pay");
  assert.equal(leadershipTopic("Draft the warning letter")?.key, "people");
  assert.equal(leadershipTopic("Plan the notice period handover")?.key, "people");
  assert.equal(leadershipTopic("Share the bank statement with the CA")?.key, "money");
  assert.equal(leadershipTopic("Send the term sheet back")?.key, "money");
  assert.equal(leadershipTopic("Reply to the legal notice")?.key, "legal");
  assert.equal(leadershipTopic("Call", "Talk about the increment before Friday")?.key, "pay");
});

test("an agency's everyday words do not", () => {
  for (const t of ["Home loan offer creative", "Investor persona research", "Brand equity film", "Sales incentive release", "Image ad set designed",
    "Meta campaign set up and scheduled", "Client informed: budget", "Model-led video drafted", "Payment follow-up with the client"]) assert.equal(leadershipTopic(t), null, t);
});
