// RELEASE-COMMS: who reads which part of a release note, and a share card's bytes (synthetic values only).
import assert from "node:assert/strict";
import test from "node:test";
import { AUDIENCES, audiencesFor, cardBytes, shapeNote } from "../dist/whats-new.js";

const facts = (extra) => ({ role: "person", workRoles: [], headsTeam: false, ...extra });

test("owners, admins and leadership read every audience; the owner part is their own", () => {
  for (const f of [facts({ role: "admin" }), facts({ role: "leadership" }), facts({ role: "hr", lead: true }), facts({ workRoles: ["leadership"] })]) {
    const a = audiencesFor(f);
    assert.deepEqual(a, [...AUDIENCES]);
    assert.equal(a[0], "owner");
  }
});

test("managers, sales and HR read their part and everyone's", () => {
  assert.deepEqual(audiencesFor(facts({ role: "manager" })), ["managers", "everyone"]);
  assert.deepEqual(audiencesFor(facts({ role: "pgs" })), ["managers", "everyone"]);
  assert.deepEqual(audiencesFor(facts({ workRoles: ["head_pgs"] })), ["managers", "everyone"]);
  assert.deepEqual(audiencesFor(facts({ headsTeam: true })), ["managers", "everyone"]);
  assert.deepEqual(audiencesFor(facts({ workRoles: ["sales"] })), ["salespeople", "everyone"]);
  assert.deepEqual(audiencesFor(facts({ workRoles: ["sales_head"] })), ["managers", "salespeople", "everyone"]);
  assert.deepEqual(audiencesFor(facts({ role: "hr" })), ["hr", "everyone"]);
  assert.deepEqual(audiencesFor(facts({ workRoles: ["hr", "sales"] })), ["salespeople", "hr", "everyone"]);
});

test("everyone else reads everyone's part; a client or guest seat reads only the clients' part", () => {
  assert.deepEqual(audiencesFor(facts({})), ["everyone"]);
  assert.deepEqual(audiencesFor(facts({ role: "accountant" })), ["everyone"]);
  assert.deepEqual(audiencesFor(facts({ workRoles: ["finance"] })), ["everyone"]);
  for (const side of ["client", "channel_partner", "guest"]) assert.deepEqual(audiencesFor(facts({ side, role: "admin" })), ["clients"]);
  assert.deepEqual(audiencesFor(facts({ side: "staff", role: "manager" })), ["managers", "everyone"]);
});

test("a note's share cards name their picture by address, never inline it", () => {
  const n = shapeNote({ id: 7, sha: "a".repeat(40), share: {
    owner: { text: " Hello team ", image: "0123456789ab" }, everyone: { text: "", image: null }, hr: { text: "Only words", image: "data:image/jpeg;base64,AAAA" },
    stranger: { text: "x", image: "0123456789ab" } } });
  assert.deepEqual(n.share, { owner: { text: "Hello team", imageUrl: "/api/v0/whats-new/7/card/owner?v=0123456789ab" }, hr: { text: "Only words", imageUrl: null } });
});

test("a card's bytes must be the picture type they claim", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
  assert.equal(cardBytes(`data:image/jpeg;base64,${jpeg.toString("base64")}`).type, "image/jpeg");
  assert.ok(cardBytes(`data:image/jpeg;base64,${jpeg.toString("base64")}`).bytes.equals(jpeg));
  assert.equal(cardBytes(`data:image/png;base64,${png.toString("base64")}`).type, "image/png");
  assert.equal(cardBytes(`data:image/png;base64,${jpeg.toString("base64")}`), null, "a JPEG that calls itself PNG");
  assert.equal(cardBytes(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`), null);
  assert.equal(cardBytes(`data:text/html;base64,${jpeg.toString("base64")}`), null);
  assert.equal(cardBytes("https://example.test/card.jpg"), null);
  assert.equal(cardBytes(null), null);
});
