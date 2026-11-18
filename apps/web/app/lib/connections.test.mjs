import test from "node:test";
import assert from "node:assert/strict";
import { agreementBadge, filterRows, nextStep, otherSide, sentence, shortLine, sideName, tieSummary } from "./connections.mjs";

const company = (org, name) => ({ org, orgName: name, orgHandle: null, orgKind: "company", personal: false, account: null, name, handle: null });
const personal = (org, acct, name) => ({ org, orgName: `${name}`, orgHandle: null, orgKind: "personal", personal: true, account: acct, name, handle: null });
const row = (over) => ({ id: "c1", kind: "client", status: "active", source: "manual", aRole: null, bRole: null, note: null, since: "2026-11-16", startedOn: null,
  mySide: "a", a: company("v", "Synthetic Vitals"), b: company("n", "Synthetic Nature"), agreement: { state: "none" }, counts: { docs: 0, tasks: 0, chats: 0 }, contacts: [], ...over });

test("a connection in one sentence, from where you stand", () => {
  assert.equal(sentence(row()), "Synthetic Nature is a client of Synthetic Vitals");
  assert.equal(sentence(row({ kind: "freelancer", a: personal("p", "me", "Asha Rao"), b: personal("q", "r", "Ravi Kalah") }), "me"), "Ravi Kalah works for you as a freelancer");
  assert.equal(sentence(row({ kind: "cofounder", a: { ...company("v", "Synthetic Vitals"), account: "me", personal: false }, b: { org: null, orgName: null, orgHandle: null, orgKind: null, personal: null, account: "k", name: "Ken Rao", handle: "ken" } })),
    "Ken Rao and Synthetic Vitals are co-founders");
  assert.equal(sideName(otherSide(row({ mySide: "b" }))), "Synthetic Vitals");
});

test("the agreement badge and the one next step", () => {
  assert.deepEqual(agreementBadge({ state: "none" }), { text: "No agreement", tone: "bad" });
  assert.deepEqual(agreementBadge({ state: "waiting", waitingFor: "Nisha" }), { text: "Waiting for Nisha", tone: "warn" });
  assert.equal(nextStep(row({ status: "suggested" })).key, "confirm");
  assert.equal(nextStep(row()).key, "draft");
  assert.equal(nextStep(row({ agreement: { state: "draft" } })).key, "review");
  assert.equal(nextStep(row({ agreement: { state: "signed" } })).key, "give");
  assert.equal(nextStep(row({ status: "ended" })), null);
});

test("filters: people, companies, no agreement, suggested; ended ones only on their own tab", () => {
  const rows = [row({ id: "1" }), row({ id: "2", b: personal("q", "r", "Ravi Kalah"), agreement: { state: "draft" } }), row({ id: "3", status: "suggested" }), row({ id: "4", status: "ended" })];
  assert.deepEqual(filterRows(rows, "all").map((r) => r.id), ["1", "2", "3"]);
  assert.deepEqual(filterRows(rows, "people").map((r) => r.id), ["2"]);
  assert.deepEqual(filterRows(rows, "no-agreement").map((r) => r.id), ["1", "3"]);
  assert.deepEqual(filterRows(rows, "suggested").map((r) => r.id), ["3"]);
  assert.deepEqual(filterRows(rows, "ended").map((r) => r.id), ["4"]);
  assert.deepEqual(tieSummary({ people: [{ agreement: "none" }, { agreement: "signed" }] }), { count: 2, none: 1, text: "2 people · 1 with no agreement" });
});

test("the list's short line", () => {
  assert.equal(shortLine(row()), "Client of Synthetic Vitals");
  assert.equal(shortLine(row({ kind: "freelancer", bRole: "Designer", a: personal("p", "me", "Asha Rao"), b: personal("q", "r", "Ravi Kalah") }), "me"), "Freelancer for you · Designer");
  assert.equal(shortLine(row({ mySide: "b" })), "Synthetic Nature is a client of Synthetic Vitals");
});
