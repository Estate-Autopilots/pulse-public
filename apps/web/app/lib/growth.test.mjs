import assert from "node:assert/strict";
import test from "node:test";
import { cleanVia, explainer, newVisitorId, pitch, poweredBy, readRef, readStart, startHref, stillDismissed } from "./growth.mjs";

test("the company that brought them comes first, Vitals after it", () => {
  assert.equal(poweredBy("EA"), "Powered by EA · Vitals");
  assert.equal(poweredBy(""), "Powered by Vitals");
  assert.equal(pitch("Coral Studio"), "Coral Studio runs its work on Vitals. Your business can too, free.");
  assert.match(pitch(null), /Free to start/);
});

test("Start free opens their own company, pre-filled, signed in or not", () => {
  assert.equal(startHref({ signedIn: true, via: "@EA", source: "chat", name: "Lotus Interiors" }), "/start/space?from=growth&via=ea&source=chat&name=Lotus+Interiors");
  assert.equal(startHref({ signedIn: false, via: "ea", source: "quote" }), "/signup?from=growth&via=ea&source=quote");
  assert.equal(startHref({ signedIn: false, via: "not a handle!", source: "elsewhere", name: "x" }), "/signup?from=growth");
});

test("a start page reads the pre-fill only from the card", () => {
  assert.deepEqual(readStart("?from=growth&via=EA&source=chat&name=Lotus%20Interiors"), { via: "ea", source: "chat", name: "Lotus Interiors" });
  assert.deepEqual(readStart("from=growth&source=nope"), { via: null, source: null, name: "" });
  assert.equal(readStart("?via=ea"), null);
});

test("the referral is kept two hours and checked when read back", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.deepEqual(readRef(JSON.stringify({ via: "ea", source: "quote", at: now - 3600_000 }), now), { via: "ea", source: "quote", at: now - 3600_000 });
  assert.equal(readRef(JSON.stringify({ via: "ea", source: "quote", at: now - 3 * 3600_000 }), now), null);
  assert.equal(readRef(JSON.stringify({ via: "ea", source: "mail", at: now }), now), null);
  assert.equal(readRef("{broken", now), null);
  assert.equal(readRef(null, now), null);
  assert.equal(cleanVia("@Vitals.Tech"), "vitals.tech");
});

test("a closed card stays closed for 30 days", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(stillDismissed(now - 29 * 86400_000, now), true);
  assert.equal(stillDismissed(now - 31 * 86400_000, now), false);
  assert.equal(stillDismissed("nope", now), false);
});

test("the visitor id is random letters and digits only", () => {
  const id = newVisitorId(() => new Uint8Array(32).map((_, i) => i * 7));
  assert.match(id, /^[a-z0-9]{32}$/);
  assert.notEqual(newVisitorId(), newVisitorId());
});

test("the explainer slot plays the owner's video when it is set", () => {
  assert.deepEqual(explainer(undefined), { kind: "none", url: null });
  assert.deepEqual(explainer("http://insecure.example/v.mp4"), { kind: "none", url: null });
  assert.deepEqual(explainer("https://cdn.example/what-is-vitals.mp4"), { kind: "file", url: "https://cdn.example/what-is-vitals.mp4" });
  assert.equal(explainer("https://youtu.be/AbCdEf12345").url, "https://www.youtube-nocookie.com/embed/AbCdEf12345?autoplay=1&rel=0");
  assert.equal(explainer("https://www.loom.com/share/abc").kind, "link");
});
