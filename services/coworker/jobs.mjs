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
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSandbox, sandboxReady } from "./sandbox.mjs";

const FILE = /\.(csv|xlsx|xls|pdf|txt)$/i;
const MIME = /csv|spreadsheet|excel|pdf|text\/plain/i;
const WORDS = /\b(statements?|bank|passbook|gst|gstr|reconcil\w*|ledger|transactions?|entries|tally|books)\b/i;
const uuid5 = (s) => { const h = createHash("sha1").update(`pulse-jobs:${s}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const rupees = (minor) => `₹${Math.round(Number(minor) / 100).toLocaleString("en-IN")}`;
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString("en-IN")} ${n === 1 ? one : many}`;

/** Whether a chat message is a finance job (statements sent to an AI employee with Finance & billing), and its files. */
export function financeAsk(message, tools) {
  if (!Array.isArray(tools) || !tools.includes("billing")) return null;
  const files = (message?.files ?? []).filter((f) => f && typeof f.id === "string" && (FILE.test(String(f.name ?? "")) || MIME.test(String(f.mime ?? ""))));
  if (!files.length) return null;
  const body = String(message?.body ?? "");
  // A sheet or PDF with no words, or with finance words, is a statement to read; "here's the logo pdf" is not.
  if (body.trim() && !WORDS.test(body) && !files.some((f) => /statement|bank|gst|ledger|passbook|hdfc|icici|sbi|axis|kotak/i.test(String(f.name ?? "")))) return null;
  const names = files.map((f) => String(f.name ?? "file")).slice(0, 3).join(", ");
  return { files: files.map((f) => f.id).slice(0, 20), title: `Reading ${files.length === 1 ? names : `${files.length} files (${names}${files.length > 3 ? ", …" : ""})`}`.slice(0, 200) };
}

/** The fast path inside a chat run: open the job (Pulse posts the "give me a few seconds" message) and close the run
 *  at no cost. Returns true when it took the message. */
export async function openFinanceJob(emp, run, ctx) {
  const ask = financeAsk(ctx.message, emp.me?.tools);
  if (!ask || ctx.message?.channelKind === "client") return false;
  const r = await emp.call("POST", "/api/v0/agent/jobs", { kind: "fin.ingest", title: ask.title, channelId: ctx.message.channelId, sourceMessageId: ctx.message.id,
    files: ask.files, input: { asked: String(ctx.message.body ?? "").slice(0, 500) }, clientId: uuid5(`job:${ctx.message.id}`) });
  await emp.call("POST", `/api/v0/agent/runs/${run}`, { state: "done", tokens: 0, seconds: 0 }).catch(() => {});
  return !!r?.id;
}

/** People's decisions as a categoriser skill: a counterparty whose confirmed lines agree on one category (2+). */
export function learnedRules(decisions) {
  const by = new Map();
  for (const d of decisions ?? []) {
    if (!d?.who || !d.category || String(d.who).length < 3) continue;
    const k = `${String(d.who).toLowerCase()}|${d.direction}`;
    const e = by.get(k) ?? { who: String(d.who).toLowerCase(), direction: d.direction, cats: new Map() };
    e.cats.set(d.category, (e.cats.get(d.category) ?? 0) + Number(d.n || 1));
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

/** The plain line the person reads when the job ends. */
export function doneLine(r) {
  const t = r?.totals ?? {}, f = t.flags ?? {};
  const ok = (r?.files ?? []).filter((x) => x.ok).length, bad = (r?.files ?? []).filter((x) => !x.ok);
  const need = Object.values(f).length ? Math.max(...Object.values(f)) : 0;
  const parts = [`Read ${plural(ok, "file")}, ${plural(t.rows ?? 0, "line")}${t.duplicates ? ` (${plural(t.duplicates, "repeat")} dropped)` : ""}.`];
  if (need) parts.push(`To check: ${[f.unclear_category && `${f.unclear_category} unclear`, f.missing_document && `${f.missing_document} need a bill or invoice`, f.suspicious && `${f.suspicious} look odd`, f.possible_duplicate && `${f.possible_duplicate} may be repeats`].filter(Boolean).join(", ")}.`);
  if (bad.length) parts.push(`Could not read ${bad.map((x) => x.name).slice(0, 2).join(", ")}: please send a CSV or Excel download.`);
  if (r?.missingMonths?.length) parts.push(`Missing months: ${r.missingMonths.slice(0, 4).join(", ")}.`);
  parts.push("Open Finance → AI analyst to check them.");
  return parts.join(" ").slice(0, 300);
}

async function testSkill(skill, dir) {
  await writeFile(join(dir, "skill.json"), JSON.stringify(skill));
  let out = null;
  const r = await runSandbox({ script: "fin_ingest.py", inDir: dir, outDir: join(dir, "t"), args: ["--test-skill", "/in/skill.json"], limits: { wallSec: 60, memMb: 512 } }, (j) => { if (j && "passed" in j) out = j; });
  return r.code === 0 && out ? out : { passed: 0, failed: 1, why: "its tests did not run" };
}

/** Take and run the next job, if there is one. Returns the job id or null. */
export async function workJob(emp, { kinds = ["fin.ingest"], log = () => {} } = {}) {
  if (!sandboxReady()) return null;
  const { job } = await emp.call("POST", "/api/v0/agent/jobs/claim", { kinds });
  if (!job) return null;
  const lease = job.leaseToken, base = `/api/v0/agent/jobs/${job.id}`;
  const dir = await mkdtemp(join(tmpdir(), "pulse-job-"));
  const inDir = join(dir, "in"), outDir = join(dir, "out");
  const t0 = Date.now();
  let sent = 0, lastAt = 0;
  const step = (p, line) => emp.call("POST", `${base}/progress`, { lease, progress: p, line }).catch(() => {});
  try {
    await step(3, "Opening the files…");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(inDir, { recursive: true });
    const files = [];
    for (const f of job.files ?? []) {
      const chunks = [];
      for (let p = 0; p < Math.max(1, f.parts); p++) chunks.push(Buffer.from(await emp.call("GET", `${base}/files/${f.no}/${p}?lease=${lease}`, undefined, { raw: true })));
      const path = `f${f.no}-${String(f.name).replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80)}`;
      await writeFile(join(inDir, path), Buffer.concat(chunks));
      files.push({ path, name: f.name });
    }
    const ctx = await emp.call("GET", `${base}/context?lease=${lease}`);
    const rules = learnedRules(ctx.decisions);
    const skills = (ctx.skills ?? []).map((s) => ({ name: s.name, kind: s.kind, status: s.status, version: s.version, body: s.body }));
    await writeFile(join(inDir, "job.json"), JSON.stringify({ files, skills, invoices: (ctx.invoices ?? []).map((i) => ({ ...i, date: String(i.date).slice(0, 10) })),
      known: Object.fromEntries(rules.map((r) => [r.match, r.category])), largeMinor: Number(ctx.largeMinor) || undefined }));
    const res = await runSandbox({ script: "fin_ingest.py", inDir, outDir }, (j) => {
      if (j?.t !== "progress" || Date.now() - lastAt < 2500) return;
      lastAt = Date.now(); step(Math.min(90, Math.round(j.p * 0.9)), j.line);
    });
    if (res.code !== 0) throw new Error(res.killed === "time" ? "It took longer than a job may run; send the months in smaller files." : res.killed === "memory" ? "The file needs more memory than a job may use; send it in parts." : "The analysis stopped on these files.");
    const result = JSON.parse(await readFile(join(outDir, "result.json"), "utf8"));
    const chunks = (await readdir(outDir)).filter((n) => /^items-\d+\.jsonl\.gz$/.test(n)).sort();
    let added = 0;
    for (const [i, n] of chunks.entries()) {
      const items = gunzipSync(await readFile(join(outDir, n))).toString().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      added += (await emp.call("POST", `${base}/items`, { lease, items })).added ?? 0;
      sent += items.length;
      if (Date.now() - lastAt > 2500) { lastAt = Date.now(); await step(90 + Math.round((9 * (i + 1)) / chunks.length), `Putting ${sent.toLocaleString("en-IN")} lines into Pulse for checking…`); }
    }
    // What it learned: parser skills for layouts it had to work out, and rules from people's decisions.
    const learned = [];
    for (const s of result.proposedSkills ?? []) {
      const testResult = await testSkill(s, dir);
      const r = await emp.call("POST", `${base}/skills`, { lease, skill: { ...s, testResult } }).catch(() => null);
      if (r?.new) learned.push(s.title);
    }
    if (rules.length) {
      const skill = { kind: "categoriser", name: "categoriser-learned", title: "Categories people confirmed", body: { rules },
        tests: rules.slice(0, 20).map((r) => ({ text: r.match.toUpperCase(), who: r.match, direction: r.direction, expect: r.category })),
        why: `${plural(rules.length, "rule")} from what people confirmed; each saves a guess or a model call next time.` };
      const r = await emp.call("POST", `${base}/skills`, { lease, skill: { ...skill, testResult: await testSkill(skill, dir) } }).catch(() => null);
      if (r && !r.same) learned.push(skill.title);
    }
    result.added = added;
    result.learned = learned;
    const line = doneLine(result);
    await emp.call("POST", `${base}/finish`, { lease, status: "done", line, result: { ...result, unclear: (result.unclear ?? []).slice(0, 40) },
      stats: { rowsIn: result.totals?.rows ?? 0, cpuSeconds: res.seconds, skillsUsed: result.skillsUsed ?? {}, tokens: 0, modelCalls: 0 } });
    log("job", job.id.slice(0, 8), "done", `${result.totals?.rows ?? 0} lines, ${added} new, ${Math.round((Date.now() - t0) / 1000)} s`);
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
