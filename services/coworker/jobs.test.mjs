// FIN-AGENT: which chat messages become a finance job, the rules learned from people's decisions, the closing line.
import test from "node:test";
import assert from "node:assert/strict";
import { doneLine, financeAsk, learnedRules, openFinanceJob } from "./jobs.mjs";

const f = (name, mime = "text/csv") => ({ id: "00000000-0000-4000-8000-000000000001", name, mime });

test("statements sent to a Finance AI employee are a job; other files and other AI employees are not", () => {
  assert.deepEqual(financeAsk({ body: "April bank statement", files: [f("hdfc.csv")] }, ["billing"]), { files: [f("hdfc.csv").id], title: "Reading hdfc.csv" });
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
