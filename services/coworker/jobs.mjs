// FIN-AGENT (17 Nov 2026): heavy work in two speeds, for every AI employee (finance first).
//  * The fast reply: a chat message that hands it statements (CSV, Excel, PDF) is answered at once, with no model call:
//    "Got it. Give me a few seconds…". That message is the job's own and is edited in place as the job runs (Pulse
//    writes it from each progress step), so the person watches it move: "⏳ Reading the statements · 40% · HDFC: 120,000
//    of 300,000 lines checked".
//  * The worker: takes the job (a lease Pulse renews with each step), fetches its files with the AI employee's own key,
//    runs the analysis in the sandbox (sandbox.mjs: no network, limits), hands in the lines in chunks of 5,000 (Pulse
//    skips a line it already has), proposes what it learned as skills, each with its own tests run in the sandbox
//    first, and finishes with one plain line and the link to check the flags.
//  * The learning loop: the job uses published skills first (a parser for a layout seen before, rules learned from what
//    people confirmed), so the second statement of a bank needs no guessing; people's decisions become a categoriser
//    skill (counterparty → category, two or more agreeing decisions) proposed for an approver to publish.
// FIN-AGENT-2 (18 Nov 2026):
//  * The AI step: the groups no rule knew get one model call a job (the fast tier, within the AI employee's budget).
//    Its guesses stay "to check"; a person's one tap keeps or changes them, and a kept guess counts as two agreeing
//    decisions (the AI's and the person's), so it becomes a rule and the next statement needs neither.
//  * GST returns (GSTR-1, GSTR-3B, GSTR-2B from the portal) sent with or without statements: gst_recon.py checks them
//    against Pulse's invoices and the bank payments, in the same sandbox (kind fin.gst, or inside fin.ingest).
//  * A named learned skill run on a chat's files (kind fin.skill, from the run_skill tool).
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { remoteReady, runSandbox, sandboxReady } from "./sandbox.mjs";
import { engineName, tierRuntime } from "./engines.mjs";

const FILE = /\.(csv|xlsx|xls|pdf|txt|json)$/i;
const MIME = /csv|spreadsheet|excel|pdf|text\/plain|json/i;
const WORDS = /\b(statements?|bank|passbook|gst|gstr\w*|reconcil\w*|ledger|transactions?|entries|tally|books|returns?|itc)\b/i;
/** A GST return by its name, as the portal names its downloads (GSTR1_…, gstr-3b, 2B, R1…). */
const GST_NAME = /gstr|gst[-_ ]?r[-_ ]?[0-9]|(?:^|[^a-z0-9])(r1|r3b|r2b|r2a|3b|2b|2a)(?:[^a-z0-9]|$)/i;
const uuid5 = (s) => { const h = createHash("sha1").update(`pulse-jobs:${s}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const rupees = (minor) => `₹${Math.round(Number(minor) / 100).toLocaleString("en-IN")}`;
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString("en-IN")} ${n === 1 ? one : many}`;
/** The categories people pick from on Finance → AI analyst (desk.tsx), the only answers the AI step may give. */
export const CATEGORIES = ["Ad spend", "Software & tools", "Rent & office", "Salaries", "Freelancers", "Travel", "Food & office supplies", "Utilities", "Professional fees",
  "Equipment", "Taxes & GST", "Bank charges", "Client payment", "Other income", "Refund", "Owner money", "Other"];

/** Whether a chat message is a finance job (statements or GST returns sent to an AI employee with Finance & billing). */
export function financeAsk(message, tools) {
  if (!Array.isArray(tools) || !tools.includes("billing")) return null;
  const files = (message?.files ?? []).filter((f) => f && typeof f.id === "string" && (FILE.test(String(f.name ?? "")) || MIME.test(String(f.mime ?? ""))));
  if (!files.length) return null;
  const body = String(message?.body ?? "");
  const named = (f) => /statement|bank|gst|ledger|passbook|hdfc|icici|sbi|axis|kotak/i.test(String(f.name ?? "")) || GST_NAME.test(String(f.name ?? ""));
  // A sheet or PDF with no words, or with finance words, is a statement to read; "here's the logo pdf" is not. A JSON
  // file is read only when it is named as a GST return or the message says so (it is the portal's download format).
  if (body.trim() && !WORDS.test(body) && !files.some(named)) return null;
  const json = files.filter((f) => /\.json$/i.test(String(f.name ?? "")) || /json/i.test(String(f.mime ?? "")));
  if (json.length === files.length && !files.some((f) => GST_NAME.test(String(f.name ?? ""))) && !/\bgst/i.test(body)) return null;
  const gst = files.filter((f) => GST_NAME.test(String(f.name ?? "")) || (/\.json$/i.test(String(f.name ?? "")) && /\bgst/i.test(body)));
  const names = files.map((f) => String(f.name ?? "file")).slice(0, 3).join(", ");
  return { files: files.map((f) => f.id).slice(0, 20), kind: gst.length === files.length ? "fin.gst" : "fin.ingest", gst: gst.length > 0,
    title: `${gst.length === files.length ? "Checking GST: " : "Reading "}${files.length === 1 ? names : `${files.length} files (${names}${files.length > 3 ? ", …" : ""})`}`.slice(0, 200) };
}

/** The fast path inside a chat run: open the job (Pulse posts the "give me a few seconds" message) and close the run
 *  at no cost. Returns true when it took the message. */
export async function openFinanceJob(emp, run, ctx) {
  const ask = financeAsk(ctx.message, emp.me?.tools);
  if (!ask || ctx.message?.channelKind === "client") return false;
  const r = await emp.call("POST", "/api/v0/agent/jobs", { kind: ask.kind, title: ask.title, channelId: ctx.message.channelId, sourceMessageId: ctx.message.id,
    files: ask.files, input: { asked: String(ctx.message.body ?? "").slice(0, 500), ...(ask.gst ? { gst: "true" } : {}) }, clientId: uuid5(`job:${ctx.message.id}`) });
  await emp.call("POST", `/api/v0/agent/runs/${run}`, { state: "done", tokens: 0, seconds: 0 }).catch(() => {});
  return !!r?.id;
}

/** People's decisions as a categoriser skill: a counterparty whose confirmed lines agree on one category, twice or more.
 *  A line where a person kept the AI's guess as it was counts twice (the AI's decision and the person's). */
export function learnedRules(decisions) {
  const by = new Map();
  for (const d of decisions ?? []) {
    if (!d?.who || !d.category || String(d.who).length < 3) continue;
    const k = `${String(d.who).toLowerCase()}|${d.direction}`;
    const e = by.get(k) ?? { who: String(d.who).toLowerCase(), direction: d.direction, cats: new Map() };
    e.cats.set(d.category, (e.cats.get(d.category) ?? 0) + Number(d.n || 1) + Math.min(Number(d.agreed) || 0, 1));
    by.set(k, e);
  }
  const rules = [];
  for (const e of by.values()) {
    if (e.cats.size !== 1) continue;
    const [[category, n]] = [...e.cats];
    if (n >= 2) rules.push({ match: e.who, category, direction: e.direction, seen: n });
  }
  rules.sort((a, b) => b.seen - a.seen || a.match.localeCompare(b.match));
  return rules.slice(0, 2000);
}

// ------------------------------------------------------------------------------------------------- the AI step
/** One prompt for the groups no rule knew. Narrations come redacted from the sandbox (no account, card or phone
 *  numbers); only words, the side and the totals go to the model. */
export function suggestPrompt(unclear, categories = CATEGORIES) {
  const lines = unclear.slice(0, 40).map((u, i) => `${i + 1}. ${u.direction === "in" ? "MONEY IN" : "MONEY OUT"} · who: ${JSON.stringify(String(u.key || "(no name)").slice(0, 60))} · bank words: ${JSON.stringify(String(u.sample ?? "").slice(0, 120))} · ${plural(u.lines, "line")}, ${rupees(u.minor)}`);
  return `You sort an Indian company's bank lines into categories. For each numbered group below (who was paid or who paid, the side, the bank's words, how many lines and their total), choose exactly one category from this list, or "Not sure":
${categories.join(" | ")}

Rules: use the words only (a person's name alone, or the amount alone, is "Not sure"); "Client payment" is money in from a customer; "Owner money" is money a founder put in or took out; never invent a category outside the list.
Answer with JSON only, one object per group: [{"n": 1, "category": "...", "confidence": 0.0 to 1.0, "why": "up to 12 words"}]

${lines.join("\n")}`;
}

/** The model's answer, strictly: JSON objects whose category is on the list (case as on the list) and is not "Not
 *  sure", a confidence of 0.5 or more; anything else is dropped. Keys are "<group key>|<side>". */
export function parseSuggestions(text, unclear, categories = CATEGORIES) {
  const out = new Map();
  const m = /\[[\s\S]*\]/.exec(String(text ?? ""));
  if (!m) return out;
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  const canon = new Map(categories.map((c) => [c.toLowerCase(), c]));
  for (const a of arr) {
    const u = unclear[Number(a?.n) - 1];
    const cat = canon.get(String(a?.category ?? "").trim().toLowerCase());
    const conf = Math.max(0, Math.min(1, Number(a?.confidence)));
    if (!u || !cat || !(conf >= 0.5)) continue;
    // No long digit runs in the reason people read (account or phone numbers never come back from the model).
    const why = String(a?.why ?? "").replace(/\d[\d\s-]{4,}\d/g, "•••").replace(/\s+/g, " ").trim().slice(0, 80);
    out.set(`${u.key}|${u.direction}`, { category: cat, confidence: Math.round(conf * 100) / 100, why });
  }
  return out;
}

const kindOf = (category, direction) => direction === "in" ? (category === "Refund" ? "refund" : "income") : "expense";

/** The guesses onto the lines of their groups: category, kind, a reason that says it is the AI's guess, its source.
 *  The line stays "to check" (an AI guess is never sure until a person confirms it). Returns how many lines it took. */
export function applySuggestions(items, byKey, engine = "ai") {
  let n = 0;
  for (const it of items) {
    const k = it.unclearKey;
    delete it.unclearKey;
    if (!k || !byKey.size || !(it.flags ?? []).includes("unclear_category")) continue;
    const s = byKey.get(`${k}|${it.direction}`);
    if (!s) continue;
    it.category = s.category;
    it.kind = kindOf(s.category, it.direction);
    it.confidence = Math.min(s.confidence, 0.59);
    const said = `The AI's guess: ${s.category}${s.why ? ` (${s.why})` : ""}. Please check.`.slice(0, 200);
    it.reasons = [said, ...(it.reasons ?? []).filter((r) => !/^I could not tell what this is for|^My guess is /.test(r))].slice(0, 4);
    it.source = `ai:${engine}`.slice(0, 80);
    n++;
  }
  return n;
}

/** The test runtime's answer (no model): every group whose words name software or ads gets that category. */
const suggestStub = async (prompt) => JSON.stringify([...prompt.matchAll(/^(\d+)\. .*bank words: "([^"]*)"/gm)].flatMap(([, n, words]) =>
  /aws|google|zoho|slack|notion|figma|adobe|canva/i.test(words) ? [{ n: Number(n), category: "Software & tools", confidence: 0.8, why: "a software company's name" }]
    : /freelanc|shoot|photo|video|edit/i.test(words) ? [{ n: Number(n), category: "Freelancers", confidence: 0.7, why: "the words name a shoot or freelance work" }] : []));

/** One model call for a job's unclear groups, on the first free engine of its chain (the fast tier). Never more than
 *  one call a job; nothing when its budget is used up or nothing is unclear. {byKey, engine, tokens}. */
export async function aiSuggest(emp, unclear, { base, lease, modelOk = true, log = () => {} } = {}) {
  const none = { byKey: new Map(), engine: null, tokens: 0 };
  if (!unclear?.length || !modelOk || typeof emp?.model !== "function") return none;
  const stub = !!emp.opts?.stub || emp.me?.provider === "stub";
  // An AI employee on the test runtime never asks a model about a real company's lines.
  if (emp.me?.provider === "stub" && !emp.opts?.stub) return none;
  const plan = stub ? { usable: [{ id: "stub", kind: "stub" }] } : await emp.plan().catch(() => ({ usable: [] }));
  const prompt = suggestPrompt(unclear);
  for (const engine of (plan.usable ?? []).filter((e) => e.kind !== "connection").slice(0, 2)) {
    const rt = stub ? { provider: "stub", model: "stub" } : tierRuntime(engine, emp.me, "fast", process.env);
    try {
      const r = await emp.model(rt, prompt, { stub: stub ? (emp.opts?.suggestStub ?? suggestStub) : undefined, maxOut: 3000, timeoutMs: 180000 });
      const tokens = Math.max(0, Math.round(Number(r?.tokens) || 0));
      if (base) await emp.call("POST", `${base}/model`, { lease, tokens }).catch(() => {});
      return { byKey: parseSuggestions(r?.text, unclear.slice(0, 40)), engine: engineName(engine, rt), tokens };
    } catch (err) {
      log("AI step on", engine.id, "failed:", String(err?.message ?? err).slice(0, 120));
    }
  }
  return none;
}

// ------------------------------------------------------------------------------------------------- what people read
/** The plain line the person reads when the job ends. */
export function doneLine(r) {
  const t = r?.totals ?? {}, f = t.flags ?? {};
  const ok = (r?.files ?? []).filter((x) => x.ok).length, bad = (r?.files ?? []).filter((x) => !x.ok);
  const need = Object.values(f).length ? Math.max(...Object.values(f)) : 0;
  const parts = [];
  if (r?.totals) parts.push(`Read ${plural(ok, "file")}, ${plural(t.rows ?? 0, "line")}${t.duplicates ? ` (${plural(t.duplicates, "repeat")} dropped)` : ""}.`);
  if (need) parts.push(`To check: ${[f.unclear_category && `${f.unclear_category} unclear${r?.ai?.lines ? ` (the AI guessed ${r.ai.lines})` : ""}`, f.missing_document && `${f.missing_document} need a bill or invoice`, f.suspicious && `${f.suspicious} look odd`, f.possible_duplicate && `${f.possible_duplicate} may be repeats`].filter(Boolean).join(", ")}.`);
  if (r?.gst) parts.push(gstLine(r.gst));
  if (bad.length) parts.push(`Could not read ${bad.map((x) => x.name).slice(0, 2).join(", ")}: please send a CSV or Excel download.`);
  if (r?.missingMonths?.length) parts.push(`Missing months: ${r.missingMonths.slice(0, 4).join(", ")}.`);
  parts.push("Open Finance → AI analyst to check them.");
  return parts.join(" ").slice(0, 300);
}

/** GST in one sentence: the notices' two questions first, then invoices and unpaid bills. */
export function gstLine(g) {
  const c = g?.counts ?? {}, months = (k) => [...new Set((g?.findings ?? []).filter((x) => x.kind === k).map((x) => x.month))];
  const mw = (m) => { const [y, mm] = String(m).split("-"); return `${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[Number(mm) - 1]} ${y.slice(2)}`; };
  const sum = (k) => (g?.findings ?? []).filter((x) => x.kind === k).reduce((a, x) => a + (x.amountMinor || 0), 0);
  const bits = [];
  if (c.gstr1_vs_3b) bits.push(`3B shows ${rupees(sum("gstr1_vs_3b"))} less GST than GSTR-1 in ${months("gstr1_vs_3b").map(mw).join(", ")}`);
  if (c.itc_over_2b) bits.push(`3B claims ${rupees(sum("itc_over_2b"))} more credit than 2B in ${months("itc_over_2b").map(mw).join(", ")}`);
  if (c.invoice_not_in_gstr1) bits.push(`${plural(c.invoice_not_in_gstr1, "invoice")} not in GSTR-1`);
  if (c.invoice_mismatch) bits.push(`${plural(c.invoice_mismatch, "invoice")} with different amounts`);
  if (c.itc_no_payment) bits.push(`${plural(c.itc_no_payment, "supplier bill")} in 2B with no payment found`);
  const n = (g?.files ?? []).filter((x) => x.ok).length;
  return bits.length ? `GST (${plural(n, "return")}): ${bits.join("; ")}.` : `GST (${plural(n, "return")}): nothing that differs from Pulse.`;
}

async function testSkill(skill, dir) {
  await writeFile(join(dir, "skill.json"), JSON.stringify(skill));
  let out = null;
  const r = await runSandbox({ script: "fin_ingest.py", inDir: dir, outDir: join(dir, "t"), args: ["--test-skill", "/in/skill.json"], limits: { wallSec: 60, memMb: 512 } }, (j) => { if (j && "passed" in j) out = j; });
  return r.code === 0 && out ? out : { passed: 0, failed: 1, why: "its tests did not run" };
}

/** Whether a downloaded file is a GST return: by its name, or a JSON whose top keys are the portal's. */
export function isGstFile(name, head) {
  if (GST_NAME.test(String(name))) return true;
  const s = String(head ?? "").slice(0, 4000);
  return /^\s*[[{]/.test(s) && /"(gstin|fp|ret_period|rtnprd|docdata|sup_details|b2b)"\s*:/.test(s);
}

/** Take and run the next job, if there is one. Returns the job id or null. */
export async function workJob(emp, { kinds = ["fin.ingest", "fin.gst", "fin.skill"], log = () => {} } = {}) {
  // The sandbox here, or (FIN-AGENT-2) on the remote host named by PULSE_SANDBOX_REMOTE when it passes the same probe.
  if (!sandboxReady() && !(await remoteReady())) return null;
  const { job } = await emp.call("POST", "/api/v0/agent/jobs/claim", { kinds });
  if (!job) return null;
  const lease = job.leaseToken, base = `/api/v0/agent/jobs/${job.id}`;
  const dir = await mkdtemp(join(tmpdir(), "pulse-job-"));
  const inDir = join(dir, "in"), outDir = join(dir, "out"), gstIn = join(dir, "gst-in"), gstOut = join(dir, "gst-out");
  const t0 = Date.now();
  let sent = 0, lastAt = 0, cpu = 0;
  const step = (p, line) => emp.call("POST", `${base}/progress`, { lease, progress: p, line }).catch(() => {});
  try {
    await step(3, "Opening the files…");
    await mkdir(inDir, { recursive: true }); await mkdir(gstIn, { recursive: true });
    const files = [], gstFiles = [];
    for (const f of job.files ?? []) {
      const chunks = [];
      for (let p = 0; p < Math.max(1, f.parts); p++) chunks.push(Buffer.from(await emp.call("GET", `${base}/files/${f.no}/${p}?lease=${lease}`, undefined, { raw: true })));
      const bytes = Buffer.concat(chunks);
      const path = `f${f.no}-${String(f.name).replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80)}`;
      const gst = job.kind === "fin.gst" || isGstFile(f.name, bytes.subarray(0, 4000).toString("utf8"));
      await writeFile(join(gst ? gstIn : inDir, path), bytes);
      (gst ? gstFiles : files).push({ path, name: f.name });
    }
    const ctx = await emp.call("GET", `${base}/context?lease=${lease}`);
    const result = { files: [], kind: job.kind };
    let added = 0;
    const learned = [], outLines = [];
    // ---- bank statements (fin.ingest, fin.skill)
    if (files.length) {
      const rules = learnedRules(ctx.decisions);
      let skills = (ctx.skills ?? []).map((s) => ({ name: s.name, kind: s.kind, status: s.status, version: s.version, body: s.body }));
      if (job.kind === "fin.skill") {
        if (!ctx.skill) throw new Error("That skill is not published any more; list_skills shows the ones to use.");
        skills = [{ name: ctx.skill.name, kind: ctx.skill.kind, status: "published", version: ctx.skill.version, body: ctx.skill.body }];
      }
      await writeFile(join(inDir, "job.json"), JSON.stringify({ files, skills, invoices: (ctx.invoices ?? []).map((i) => ({ ...i, date: String(i.date).slice(0, 10) })),
        known: job.kind === "fin.skill" ? {} : Object.fromEntries(rules.map((r) => [r.match, r.category])), largeMinor: Number(ctx.largeMinor) || undefined }));
      const res = await runSandbox({ script: "fin_ingest.py", inDir, outDir }, (j) => {
        if (j?.t !== "progress" || Date.now() - lastAt < 2500) return;
        lastAt = Date.now(); step(Math.min(80, Math.round(j.p * 0.8)), j.line);
      });
      cpu += res.seconds;
      if (res.code !== 0) throw new Error(res.killed === "time" ? "It took longer than a job may run; send the months in smaller files." : res.killed === "memory" ? "The file needs more memory than a job may use; send it in parts." : "The analysis stopped on these files.");
      Object.assign(result, JSON.parse(await readFile(join(outDir, "result.json"), "utf8")));
      // The AI step: the groups no rule knew (once a job, within its budget). A named skill's run asks no model.
      let ai = { byKey: new Map(), engine: null, tokens: 0 };
      if (job.kind !== "fin.skill" && result.unclear?.length) {
        await step(82, `Asking the AI about ${plural(result.unclear.length, "group")} no rule knew…`);
        ai = await aiSuggest(emp, result.unclear, { base, lease, modelOk: ctx.modelOk !== false, log });
      }
      let aiLines = 0;
      const chunks = (await readdir(outDir)).filter((n) => /^items-\d+\.jsonl\.gz$/.test(n)).sort();
      for (const [i, n] of chunks.entries()) {
        const items = gunzipSync(await readFile(join(outDir, n))).toString().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        aiLines += applySuggestions(items, ai.byKey, ai.engine ?? "ai");
        if (gstFiles.length) for (const x of items) if (x.direction === "out") outLines.push({ date: x.date, amount: x.amountMinor, who: x.counterparty, narration: x.narration });
        added += (await emp.call("POST", `${base}/items`, { lease, items })).added ?? 0;
        sent += items.length;
        if (Date.now() - lastAt > 2500) { lastAt = Date.now(); await step(84 + Math.round((6 * (i + 1)) / chunks.length), `Putting ${sent.toLocaleString("en-IN")} lines into Pulse for checking…`); }
      }
      if (ai.engine) result.ai = { groups: ai.byKey.size, lines: aiLines, engine: ai.engine, tokens: ai.tokens };
      // What it learned: parser skills for layouts it had to work out, and rules from people's decisions.
      for (const s of result.proposedSkills ?? []) {
        const testResult = await testSkill(s, dir);
        const r = await emp.call("POST", `${base}/skills`, { lease, skill: { ...s, testResult } }).catch(() => null);
        if (r?.new) learned.push(s.title);
      }
      if (rules.length && job.kind !== "fin.skill") {
        const skill = { kind: "categoriser", name: "categoriser-learned", title: "Categories people confirmed", body: { rules },
          tests: rules.slice(0, 20).map((r) => ({ text: r.match.toUpperCase(), who: r.match, direction: r.direction, expect: r.category })),
          why: `${plural(rules.length, "rule")} from what people confirmed; each saves a guess or a model call next time.` };
        const r = await emp.call("POST", `${base}/skills`, { lease, skill: { ...skill, testResult: await testSkill(skill, dir) } }).catch(() => null);
        if (r && !r.same) learned.push(skill.title);
      }
    }
    // ---- GST returns (fin.gst, or sent with the statements)
    if (gstFiles.length) {
      await step(91, `Checking ${plural(gstFiles.length, "GST return")} against Pulse's invoices and payments…`);
      await writeFile(join(gstIn, "job.json"), JSON.stringify({ files: gstFiles, invoices: (ctx.invoices ?? []).map((i) => ({ ...i, date: String(i.date).slice(0, 10) })),
        payments: [...(ctx.payments ?? []), ...outLines], gstin: ctx.gstin ?? null }));
      const res = await runSandbox({ script: "gst_recon.py", inDir: gstIn, outDir: gstOut, args: ["/in", "/out"] });
      cpu += res.seconds;
      if (res.code !== 0) throw new Error(res.killed ? "The GST check took longer or more memory than a job may use; send fewer months at a time." : "The GST check stopped on these files.");
      result.gst = JSON.parse(await readFile(join(gstOut, "result.json"), "utf8"));
      result.files = [...(result.files ?? []), ...result.gst.files.map((f) => ({ name: f.name, ok: f.ok, gst: f.return ?? null, period: f.period ?? null }))];
    }
    result.added = added;
    result.learned = learned;
    const line = doneLine(result);
    await emp.call("POST", `${base}/finish`, { lease, status: "done", line, result: { ...result, unclear: (result.unclear ?? []).slice(0, 40), ...(result.gst ? { gst: { ...result.gst, findings: result.gst.findings.slice(0, 200) } } : {}) },
      stats: { rowsIn: result.totals?.rows ?? 0, cpuSeconds: cpu, skillsUsed: result.skillsUsed ?? {}, tokens: 0, modelCalls: 0 } });
    log("job", job.id.slice(0, 8), "done", `${result.totals?.rows ?? 0} lines, ${added} new${result.gst ? `, ${result.gst.findings.length} GST findings` : ""}, ${Math.round((Date.now() - t0) / 1000)} s`);
    return job.id;
  } catch (err) {
    log("job", job.id.slice(0, 8), "failed:", String(err.message).slice(0, 160));
    await emp.call("POST", `${base}/finish`, { lease, status: "failed", error: String(err.message).slice(0, 400), stats: {} }).catch(() => {});
    return job.id;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export { rupees };
