// GROUPS-HUB: the group-name reader (made-up projects, people and places in EA's naming style).
import test from "node:test";
import assert from "node:assert/strict";
import { parseGroupName, groupKind, bestMatch, similarity } from "../dist/group-names.js";

const known = { clients: ["Ahoro Velankar", "Sunita Rao Putig"], areas: ["Baner", "Vadgaon Bk", "Pimple Saudagar", "Wagholi"] };

test("bars: pod, project, client, area, month, codes", () => {
  const p = parseGroupName("Pod 1 | Lotus Crest | Mr. Ahoro Velankar | Baner | April 2026 | Lux", known);
  assert.equal(p.pod, 1); assert.equal(p.project, "Lotus Crest"); assert.equal(p.client, "Ahoro Velankar"); assert.equal(p.honorific, "Mr");
  assert.equal(p.area, "Baner"); assert.equal(p.month, "2026-04"); assert.deepEqual(p.segments, ["luxury"]); assert.equal(p.separated, true);
});

test("no bars, lower case: the same parts", () => {
  const p = parseGroupName("pod 2 lotus crest mr ahoro velankar baner april 2026 r lux", known);
  assert.equal(p.pod, 2); assert.equal(p.project, "Lotus Crest"); assert.equal(p.client, "Ahoro Velankar"); assert.equal(p.area, "Baner");
  assert.equal(p.month, "2026-04"); assert.deepEqual(p.segments, ["residential", "luxury"]);
});

test("a known three-word client and a two-word area", () => {
  const p = parseGroupName("green meadows miss sunita rao putig vadgaon bk sept 2025 m r", known);
  assert.equal(p.client, "Sunita Rao Putig"); assert.equal(p.area, "Vadgaon Bk"); assert.equal(p.month, "2025-09"); assert.deepEqual(p.segments, ["mid", "residential"]);
});

test("services in words, a city, no client", () => {
  const p = parseGroupName("skyline towers pimple saudagar aug 2026 videoshoot only", known);
  assert.deepEqual(p.services, ["video_shoot"]); assert.equal(p.project, "Skyline Towers"); assert.equal(p.area, "Pimple Saudagar"); assert.equal(p.month, "2026-08");
  const q = parseGroupName("river bend mr kehob dhore nagpur aug 2026 m p", known);
  assert.equal(q.city, "Nagpur"); assert.equal(q.area, null); assert.deepEqual(q.segments, ["mid", "plotting"]);
});

test("two-digit year, cross selling, pre launch", () => {
  const p = parseGroupName("Pod 1 Generic Ad Mr Kedar Jivop Wagholi Jan 26 Cross Selling", known);
  assert.equal(p.month, "2026-01"); assert.ok(p.services.includes("cross_selling")); assert.ok(p.services.includes("generic_ad")); assert.equal(p.area, "Wagholi");
  assert.ok(parseGroupName("pika lohiku project mr kedar jivop aug 2026").services.includes("pre_launch"));
});

test("internal groups stay internal; pods and teams follow their Pulse kind", () => {
  assert.equal(groupKind("custom", parseGroupName("Design huddle"), "Design huddle"), "internal");
  assert.equal(groupKind("custom", parseGroupName("Print vendor Kalyan"), "Print vendor Kalyan"), "vendor");
  assert.equal(groupKind("pod", parseGroupName("Pod 1"), "Pod 1"), "pod");
  assert.equal(groupKind("custom", parseGroupName("lotus crest mr ahoro velankar baner april 2026 r"), "x"), "client");
});

test("matching: a clear best match and its runner-up", () => {
  const projects = [{ name: "Lotus Crest" }, { name: "Lotus Garden" }, { name: "Skyline Towers" }];
  const m = bestMatch("lotus crest", projects, (x) => x.name);
  assert.equal(m.item.name, "Lotus Crest"); assert.equal(m.score, 1); assert.ok(m.next < 0.9);
  assert.ok(similarity("Skyline Tower", "Skyline Towers") > 0.85);
  assert.equal(bestMatch(null, projects, (x) => x.name), null);
});
