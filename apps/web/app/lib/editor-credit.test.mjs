import assert from "node:assert/strict";
import test from "node:test";
import { attributionBuckets, deliveryCreditExplanation, deliveryHowLabel } from "./editor-credit.mjs";

test("30-day editor credit shows person and shared-login counts and shares", () => {
  assert.deepEqual(attributionBuckets({
    window_days: 30,
    total_deliveries: 6,
    credited_to_person: 4,
    credited_to_person_share: 4 / 6,
    shared_login: 1,
    shared_login_share: 1 / 6,
    unresolved: 1,
  }), [
    { key: "person", label: "Credited to a person", count: 4, share: "67%" },
    { key: "shared", label: "Shared login", count: 1, share: "17%" },
  ]);
});

test("person delivery explanations label each of the four attribution methods", () => {
  assert.deepEqual([
    deliveryCreditExplanation("person-1", "account map", "person-1"),
    deliveryCreditExplanation("person-1", "confirmation", "person-1"),
    deliveryCreditExplanation("person-1", "fingerprint", "person-1"),
    deliveryCreditExplanation("person-1", "folder owner", "person-1"),
  ], [
    "The uploaded account is linked to a person",
    "The delivery was confirmed for a person",
    "A matching file fingerprint supports the attribution",
    "Drive folder ownership supports the attribution",
  ]);
});

test("shared and unresolved deliveries never claim personal credit", () => {
  assert.equal(deliveryCreditExplanation("shared login", "shared", "person-1"), "The delivery came through a shared login; no person is credited");
  assert.equal(deliveryCreditExplanation("shared login", null, "person-1"), "The delivery came through a shared login; no person is credited");
  assert.equal(deliveryCreditExplanation("unresolved", null, "person-1"), "No individual uploader was identified");
  assert.equal(deliveryHowLabel(null, "person-1"), "Person credit was recorded, but its explanation is unavailable");
  assert.equal(deliveryCreditExplanation("person-2", "fingerprint", "person-1"), "This delivery isn't credited to this person");
  assert.equal(deliveryCreditExplanation("person-1", "confirmation", null), null);
});
