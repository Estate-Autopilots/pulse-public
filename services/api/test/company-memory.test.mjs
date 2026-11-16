import assert from "node:assert/strict";
import test from "node:test";
import { answerFrom, datesOf, eventsOf, searchWords } from "../dist/company-memory.js";

// EA-PATTERNS (2170): the company memory's question reading and its extractive answer (no model writes it, so it never
// says more than the citations). Every client and group here is synthetic.
const now = new Date("2026-11-15T10:00:00Z");

test("a month in the question becomes a date window; a later month means last year", () => {
  assert.deepEqual(datesOf("which clients complained about delays in Oct?", now), { from: "2026-10-01", to: "2026-11-01" });
  assert.deepEqual(datesOf("what did we promise Synthetic Homes in Sept 2025?", now), { from: "2025-09-01", to: "2025-10-01" });
  assert.deepEqual(datesOf("shoots in December", now), { from: "2025-12-01", to: "2026-01-01" });
  assert.deepEqual(datesOf("payments last month", now), { from: "2026-10-01", to: "2026-11-01" });
  assert.deepEqual(datesOf("who may approve the creative?", now), { from: null, to: null });   // "may" is not May
  assert.deepEqual(datesOf("what happened in May", now), { from: "2026-05-01", to: "2026-06-01" });
  assert.deepEqual(datesOf("what was the decision on the market budget?", now), { from: null, to: null });   // not Dec, not Mar
});

test("question words are dropped from the word search and stems reach the event tags", () => {
  const w = searchWords("Which clients complained about delays in October?").split(" ");
  assert.ok(w.includes("complained") && w.includes("delays") && w.includes("complaint") && w.includes("delay"));
  assert.ok(!w.includes("which") && !w.includes("clients") && !w.includes("october"));
  assert.equal(searchWords("बजट कितना है?"), "बजट कितना है");                       // Devanagari words stay
  assert.deepEqual(eventsOf("Which clients complained about delays in October?"), ["complaint", "delay"]);
  assert.deepEqual(eventsOf("overdue edits, and what did we promise?"), ["delay", "promise"]);
  assert.deepEqual(eventsOf("kal kitne leads aaye?"), []);
});

test("the answer lists each client once with its dates, events and numbered citations", () => {
  const hit = (client, from, events, kind = "whatsapp") => ({ id: from, kind, title: "t", score: 1, byWords: true, byMeaning: false, where: "Group",
    channelId: null, messageId: null, link: "/chats", clientId: client ? `id-${client}` : null, client, projectId: null, project: null,
    from: `${from}T05:00:00Z`, to: `${from}T06:00:00Z`, speakers: [], events, text: "x", redacted: false });
  const a = answerFrom("delays in Oct", [hit("Synthetic Homes", "2026-10-03", ["complaint", "delay"]), hit("Synthetic Homes", "2026-10-20", ["delay"]),
    hit("Example Realty", "2026-10-11", ["complaint"]), hit(null, "2026-10-05", [], "task")]);
  assert.match(a, /^4 places in the company memory match "delays in Oct", in 3 clients or sources:/);
  assert.match(a, /• Synthetic Homes \(3 Oct 2026 – 20 Oct 2026\): complaint, delay \[1\]\[2\]/);
  assert.match(a, /• Example Realty \(11 Oct 2026\): complaint \[3\]/);
  assert.match(a, /• Group \(5 Oct 2026\) \[4\]/);
  assert.match(answerFrom("anything", []), /^Nothing in the company memory you can see answers this/);
});

test("ask_company_memory and get_risk_scores are API v1 operations, so apps and AI employees get them as MCP tools", async () => {
  const { v1Operations } = await import("../dist/v1.js");
  const ops = Object.fromEntries(v1Operations().map((o) => [o.mcp?.name, o]));
  for (const [name, path] of [["ask_company_memory", "/api/v1/search/memory"], ["get_risk_scores", "/api/v1/search/risks"]]) {
    assert.equal(ops[name]?.path, path);
    assert.equal(ops[name].method, "GET");                                   // reads only
    assert.equal(ops[name].scope, "search.read");
  }
});
