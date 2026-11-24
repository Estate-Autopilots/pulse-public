// FIN-AGENT: which chat messages become a finance job, the rules learned from people's decisions, the closing line.
// FIN-AGENT-2: GST returns as jobs, the AI step for unclear groups (one call, strict answers, guesses stay to check),
// a kept guess counting as two agreeing decisions, and the GST sentence.
import test from "node:test";
import assert from "node:assert/strict";
import { aiSuggest, applySuggestions, CATEGORIES, doneLine, financeAsk, gstLine, isGstFile, learnedRules, openFinanceJob, parseSuggestions, suggestPrompt } from "./jobs.mjs";

const f = (name, mime = "text/csv") => ({ id: "00000000-0000-4000-8000-000000000001", name, mime });

test("statements sent to a Finance AI employee are a job; other files and other AI employees are not", () => {
  assert.deepEqual(financeAsk({ body: "April bank statement", files: [f("hdfc.csv")] }, ["billing"]), { files: [f("hdfc.csv").id], kind: "fin.ingest", gst: false, title: "Reading hdfc.csv" });
  assert.ok(financeAsk({ body: "", files: [f("export.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")] }, ["billing"]), "a sheet with no words");
  assert.equal(financeAsk({ body: "our new logo", files: [f("logo.pdf", "application/pdf")] }, ["billing"]), null, "a logo is not a statement");
  assert.ok(financeAsk({ body: "see attached", files: [f("ICICI-Apr.pdf", "application/pdf")] }, ["billing"]), "a bank's name in the file name");
  assert.equal(financeAsk({ body: "statement", files: [f("a.csv")] }, ["chats", "tasks"]), null, "needs Finance & billing");
  assert.equal(financeAsk({ body: "statement", files: [f("photo.jpg", "image/jpeg")] }, ["billing"]), null, "a photo is not a table");
  assert.match(financeAsk({ body: "", files: [f("a.csv"), f("b.csv"), f("c.csv"), f("d.csv")] }, ["billing"]).title, /^Reading 4 files \(a\.csv, b\.csv, c\.csv, …\)$/);
});

test("the fast path opens the job and closes the run at no cost, with no model call", async () => {
  const calls = [];
  const emp = { me: { tools: ["billing"] }, call: async (m, p, b) => { calls.push([m, p, b]); return p === "/api/v0/agent/jobs" ? { id: "j1", statusMessageId: "m1" } : {}; } };
  const ctx = { message: { id: "msg1", channelId: "ch1", channelKind: "direct", body: "statements", files: [f("hdfc.csv")] } };
  assert.equal(await openFinanceJob(emp, "run1", ctx), true);
  assert.equal(calls[0][1], "/api/v0/agent/jobs");
  assert.equal(calls[0][2].kind, "fin.ingest");
  assert.deepEqual(calls[1], ["POST", "/api/v0/agent/runs/run1", { state: "done", tokens: 0, seconds: 0 }]);
  const again = []; await openFinanceJob({ ...emp, call: async (m, p, b) => { again.push(b); return { id: "j1" }; } }, "run2", ctx);
  assert.equal(again[0].clientId, calls[0][2].clientId, "the same message opens the same job (idempotent)");
  assert.equal(await openFinanceJob(emp, "run3", { message: { ...ctx.message, files: [] } }), false);
});

test("people's decisions become rules only when two or more agree", () => {
  const rules = learnedRules([
    { who: "Ravi Synthetic", direction: "out", category: "Freelancers", n: 3 },
    { who: "Mystery Traders", direction: "out", category: "Equipment", n: 1 },
    { who: "Mystery Traders", direction: "out", category: "Food & office supplies", n: 2 },
    { who: "Orbit Realty Llp", direction: "in", category: "Client payment", n: 5 },
    { who: "x", direction: "out", category: "Other", n: 9 },
  ]);
  assert.deepEqual(rules, [{ match: "orbit realty llp", category: "Client payment", direction: "in", seen: 5 }, { match: "ravi synthetic", category: "Freelancers", direction: "out", seen: 3 }]);
});

test("the closing line says what it read and what needs a person", () => {
  const line = doneLine({ files: [{ ok: true }, { ok: true }, { ok: false, name: "scan.pdf" }], totals: { rows: 1200, duplicates: 80, flags: { unclear_category: 40, missing_document: 12 } }, missingMonths: ["2026-06"] });
  assert.equal(line, "Read 2 files, 1,200 lines (80 repeats dropped). To check: 40 unclear, 12 need a bill or invoice. Could not read scan.pdf: please send a CSV or Excel download. Missing months: 2026-06. Open Finance → AI analyst to check them.");
  assert.ok(line.length <= 300);
});

test("GST returns sent to a Finance AI employee are a GST job; a JSON file that is not one is not a job", () => {
  const r1 = financeAsk({ body: "", files: [f("GSTR1_27AAAAA0000A1Z5_102026.json", "application/json"), f("returns_R3B_102026.json", "application/json")] }, ["billing"]);
  assert.equal(r1.kind, "fin.gst"); assert.equal(r1.gst, true); assert.match(r1.title, /^Checking GST: 2 files/);
  const mixed = financeAsk({ body: "Oct statements and GST", files: [f("hdfc-oct.csv"), f("gstr2b-oct.json", "application/json")] }, ["billing"]);
  assert.equal(mixed.kind, "fin.ingest", "statements and returns together: one job reads both"); assert.equal(mixed.gst, true);
  assert.equal(financeAsk({ body: "", files: [f("package.json", "application/json")] }, ["billing"]), null, "a JSON that is not a GST return");
  assert.ok(financeAsk({ body: "GST for October", files: [f("download.json", "application/json")] }, ["billing"]), "the message says GST");
  assert.equal(isGstFile("export.json", '{"gstin":"x","fp":"102026","b2b":[]}'), true, "the portal's keys");
  assert.equal(isGstFile("hdfc.csv", "Date,Narration,Withdrawal"), false);
});

const unclear = [
  { key: "aws india", direction: "out", lines: 3, minor: 1500000, sample: "ACH/AWS INDIA/•••" },
  { key: "ravi synthetic", direction: "out", lines: 2, minor: 4000000, sample: "NEFT/RAVI SYNTHETIC/SHOOT 12 OCT" },
  { key: "mystery", direction: "in", lines: 1, minor: 10000, sample: "IMPS MYSTERY" },
];

test("the AI step's prompt carries words and totals only, and its answer is taken strictly", () => {
  const p = suggestPrompt(unclear);
  assert.match(p, /^1\. MONEY OUT · who: "aws india" · bank words: "ACH\/AWS INDIA\/•••" · 3 lines, ₹15,000$/m);
  assert.ok(CATEGORIES.every((c) => p.includes(c)), "the list of categories people pick from");
  const by = parseSuggestions(`Sure: [{"n":1,"category":"software & tools","confidence":0.92,"why":"AWS is cloud hosting"},
    {"n":2,"category":"Freelancers","confidence":0.7,"why":"shoot payment to 9876 543 210"},{"n":3,"category":"Lottery","confidence":0.99},
    {"n":3,"category":"Not sure","confidence":0.9},{"n":7,"category":"Travel","confidence":0.9},{"n":2,"category":"Travel","confidence":0.2}]`, unclear);
  assert.deepEqual([...by.keys()], ["aws india|out", "ravi synthetic|out"], "only list categories, known groups and confidence of 0.5 or more");
  assert.deepEqual(by.get("aws india|out"), { category: "Software & tools", confidence: 0.92, why: "AWS is cloud hosting" });
  assert.equal(by.get("ravi synthetic|out").why, "shoot payment to •••", "no digit runs come back");
  assert.equal(parseSuggestions("I can't help with that", unclear).size, 0);
  assert.equal(parseSuggestions("[not json", unclear).size, 0);
});

test("a guess goes onto its group's lines and they stay to check", () => {
  const by = parseSuggestions('[{"n":1,"category":"Software & tools","confidence":0.95,"why":"cloud hosting"}]', unclear);
  const items = [
    { unclearKey: "aws india", direction: "out", flags: ["unclear_category"], reasons: ["I could not tell what this is for."], category: null, confidence: 0, source: "fallback" },
    { unclearKey: "aws india", direction: "in", flags: ["unclear_category"], reasons: [], category: null },
    { unclearKey: null, direction: "out", flags: [], reasons: [], category: "Rent & office", source: "rules" },
  ];
  assert.equal(applySuggestions(items, by, "server:claude/sonnet"), 1);
  assert.deepEqual(items[0], { direction: "out", flags: ["unclear_category"], reasons: ["The AI's guess: Software & tools (cloud hosting). Please check."], category: "Software & tools",
    kind: "expense", confidence: 0.59, source: "ai:server:claude/sonnet" });
  assert.equal(items[1].category, null, "the other side of the same name is another group");
  assert.ok(!("unclearKey" in items[2]), "the group key never goes to Pulse");
});

test("the AI step makes one call a job, on the fast tier, counts it, and makes none without budget", async () => {
  const calls = [], models = [];
  const emp = { me: { provider: "claude", tools: ["billing"] }, opts: { stub: true }, call: async (m, p, b) => { calls.push([p, b]); return {}; },
    plan: async () => ({ usable: [] }), model: async (rt, prompt, o) => { models.push(rt); return { text: await o.stub(prompt), tokens: 900 }; } };
  const r = await aiSuggest(emp, unclear, { base: "/api/v0/agent/jobs/j1", lease: "l1" });
  assert.equal(models.length, 1); assert.equal(models[0].provider, "stub");
  assert.deepEqual([...r.byKey.keys()], ["aws india|out", "ravi synthetic|out"]);
  assert.deepEqual(calls, [["/api/v0/agent/jobs/j1/model", { lease: "l1", tokens: 900 }]], "Pulse counts the call on the job");
  assert.equal((await aiSuggest(emp, unclear, { modelOk: false })).byKey.size, 0, "no call once the budget is used up");
  assert.equal((await aiSuggest(emp, [], {})).byKey.size, 0);
  assert.equal(models.length, 1);
  const real = { ...emp, opts: {}, me: { provider: "stub" } };
  assert.equal((await aiSuggest(real, unclear, {})).byKey.size, 0, "the test runtime never asks about a real company");
});

test("a person keeping the AI's guess teaches a rule at once; changing it does not", () => {
  const rules = learnedRules([
    { who: "aws india", direction: "out", category: "Software & tools", n: 1, agreed: 1 },
    { who: "kavya synthetic", direction: "out", category: "Freelancers", n: 1, agreed: 0 },
  ]);
  assert.deepEqual(rules, [{ match: "aws india", category: "Software & tools", direction: "out", seen: 2 }]);
});

test("the closing line says what the AI guessed and what GST found", () => {
  const gst = { files: [{ ok: true }, { ok: true }, { ok: true }], counts: { gstr1_vs_3b: 1, invoice_not_in_gstr1: 2, itc_no_payment: 3 },
    findings: [{ kind: "gstr1_vs_3b", month: "2026-08", amountMinor: 1800000 }] };
  assert.equal(gstLine(gst), "GST (3 returns): 3B shows ₹18,000 less GST than GSTR-1 in Aug 26; 2 invoices not in GSTR-1; 3 supplier bills in 2B with no payment found.");
  assert.equal(gstLine({ files: [{ ok: true }], counts: {}, findings: [] }), "GST (1 return): nothing that differs from Pulse.");
  const line = doneLine({ files: [{ ok: true }], totals: { rows: 90, flags: { unclear_category: 12 } }, ai: { lines: 9 } });
  assert.equal(line, "Read 1 file, 90 lines. To check: 12 unclear (the AI guessed 9). Open Finance → AI analyst to check them.");
  assert.match(doneLine({ files: [], gst }), /^GST \(3 returns\)/, "a GST-only job reads no statement lines");
});
