// DE-EA: a label written once for every company says the company's own words.
import assert from "node:assert/strict";
import test from "node:test";
import { NEUTRAL_VOCABULARY, NO_TEAM, lower, noTeam, say } from "./words.mjs";

test("tokens say the company's words, capitalised as written", () => {
  const pod = { ...NEUTRAL_VOCABULARY, team: "Pod", teams: "Pods" };
  assert.equal(say("{Teams} & {functions}", pod), "Pods & teams");
  assert.equal(say("{Teams} & {functions}", NEUTRAL_VOCABULARY), "Teams & departments", "a unit called Team: a function is a department");
  assert.equal(say("Ask the {team}’s head", pod), "Ask the pod’s head");
  assert.equal(say("{Team} head, HR can see"), "Team head, HR can see", "no words: the neutral ones");
  assert.equal(say("Every {client}", { client: "Patient" }), "Every patient");
  assert.equal(say("No tokens here", pod), "No tokens here");
});

test("the API's key for no team is said in the company's word", () => {
  assert.equal(NO_TEAM, "No pod");
  assert.equal(noTeam({ team: "Crew" }), "No crew");
  assert.equal(noTeam(null), "No team");
  assert.equal(lower("PGS"), "PGS");
});
