// UX-5A: Ctrl+K's matching and ranking (search-rank.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { near, norm, prepare, rank, recentBoost, score, understand } from "./search-rank.mjs";

const items = [
  { key: "presence", label: "Office presence", synonyms: ["office", "geofence", "office location"], path: ["HR", "Policies", "Office presence"] },
  { key: "wifi", label: "Office Wi-Fi", synonyms: ["wifi", "ssid", "network name"], path: ["HR", "Policies", "Office presence", "Office Wi-Fi"] },
  { key: "ip", label: "Office IP", synonyms: ["public ip", "internet", "office network"], path: ["HR", "Policies", "Office presence", "Office IP"] },
  { key: "checkin", label: "Check in (office)", synonyms: ["check in", "punch in", "attendance"] },
  { key: "client-projects", label: "Client projects" },
  { key: "record", label: "Projects Record Sentinel", sub: "Synthetic Client · Pune" },
  { key: "leave", label: "Apply for leave", synonyms: ["time off", "holiday", "vacation"] },
  { key: "payslip", label: "Payslips", synonyms: ["salary slip"] },
].map(prepare);
const labels = (r) => r.map((x) => x.item.label);

test("words, starts of words, words run together and one typo all match", () => {
  assert.equal(norm("Wi-Fi  Ofﬁce!"), "wi fi office");
  assert.deepEqual(labels(rank(items, "office")).slice(0, 4), ["Office presence", "Office Wi-Fi", "Office IP", "Check in (office)"]);
  assert.ok(labels(rank(items, "wifi")).includes("Office Wi-Fi"));
  assert.ok(labels(rank(items, "ofice")).includes("Office presence"));
  assert.ok(near("ofice", "office") && near("offcie", "office") && !near("off", "of") && !near("cat", "cut"));
  assert.equal(labels(rank(items, "pres"))[0], "Office presence");
});

test("a plain search needs every word; synonyms count", () => {
  assert.deepEqual(labels(rank(items, "office payslip")), []);
  assert.deepEqual(labels(rank(items, "time off")), ["Apply for leave"]);
  assert.deepEqual(labels(rank(items, "salary")), ["Payslips"]);
  assert.ok(score(items.find((x) => x.key === "client-projects"), "projects") > 0);
});

test("Pip reads a question: drops the asking words, adds what the words mean", () => {
  const u = understand("Where do I add the office internet?");
  assert.equal(u.question, true); assert.equal(u.intent, "change");
  assert.deepEqual(u.keywords, ["office", "internet"]);
  assert.ok(u.groups.find((g) => g.word === "internet").alts.includes("wifi"));
  assert.deepEqual(labels(rank(items, "where do I add the office internet?")), []);
  const read = rank(items, "where do I add the office internet?", { groups: u.groups, min: 0.55 });
  assert.ok(["Office IP", "Office Wi-Fi"].includes(read[0].item.label), labels(read).join());
  assert.deepEqual(understand("how do I take time off").groups.map((g) => g.word), ["time off"]);
});

test("recent picks and context lift a result without hiding better matches", () => {
  const now = Date.parse("2026-10-13T06:00:00Z");
  assert.equal(recentBoost("x", [], now), 0);
  const picked = recentBoost("leave", [{ key: "leave", at: now - 3600e3, n: 4 }], now);
  assert.ok(picked > 0.2 && picked <= 0.4);
  assert.ok(recentBoost("leave", [{ key: "leave", at: now - 90 * 86400e3, n: 4 }], now) < 0.05);
  const r = rank(items, "office", { boost: (i) => (i.key === "checkin" ? 0.6 : 0) });
  assert.equal(r[0].item.label, "Check in (office)");
});

test("ranking a few thousand records stays far under 100 ms", () => {
  const many = Array.from({ length: 4000 }, (_, i) => prepare({ label: `Person ${i} ${["Kireteso", "Iyer", "Shah", "Mifos"][i % 4]}`, sub: `Pod ${i % 9}` }));
  // CPU time, not wall time: the cost of ranking itself, not the time other jobs hold the shared CI CPUs (EST-1480).
  const c = process.cpuUsage(); const r = rank(many, "mifos 12"); const { user, system } = process.cpuUsage(c); const ms = (user + system) / 1000;
  assert.ok(r.length > 0); assert.ok(ms < 100, `${ms} ms`);
});
