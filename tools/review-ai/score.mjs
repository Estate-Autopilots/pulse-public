#!/usr/bin/env node
// SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.3: "the Claude on the company's server should give confidence to these"):
// Review data's AI check, run on the company's own server. It takes the next unchecked suggestions with the company's
// AI co-worker key (GET /api/v0/agent/review-data/queue), asks the server's own Claude (`claude -p`, the company's
// sign-in) how sure it is that accepting each is right and why, in one plain line, and sends the scores back
// (POST /api/v0/agent/review-data/scores). A score decides nothing: people accept, the sure ones together.
// Suggestions read from WhatsApp groups are never handed out by the API (migration 2044).
//
//   PULSE_URL=https://pulse.<domain> PULSE_AGENT_KEY_FILE=~/.config/pulse/review-ai.key node tools/review-ai/score.mjs [--batches 4] [--dry-run]
//
// --dry-run prints the scores and sends nothing. Exit 0 when done (also when nothing is waiting), 1 on an error.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const BATCH = 25;

/** What the model is asked: the facts of each suggestion and the exact answer shape. */
export function promptFor(items) {
  const lines = items.map((x) => JSON.stringify({ id: x.id, type: x.kind, suggestion: x.title, proposed: x.proposed ?? {}, sourceSure: x.sourceConfidence ?? null, evidence: x.evidence ?? "" }));
  return [
    "You check data-cleaning suggestions for a small company's work app (people, clients, projects, places, leave).",
    "For each suggestion below, say how sure you are that ACCEPTING it is right, from 0 to 1, using only the facts given.",
    "Be strict: 0.9 or more only when the facts clearly support it; below 0.6 when they conflict or are thin.",
    "Give one plain reason of at most 20 words a busy office worker understands (no jargon, no ids).",
    "Answer ONLY with a JSON array, one object per suggestion: {\"id\": \"...\", \"confidence\": 0.0, \"reason\": \"...\"}.",
    "",
    ...lines,
  ].join("\n");
}

/** The scores in the model's answer, for the asked ids only, each well formed; anything else is dropped. */
export function parseScores(text, ids) {
  const want = new Set(ids);
  const start = String(text ?? "").indexOf("["), end = String(text ?? "").lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let list;
  try { list = JSON.parse(String(text).slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.flatMap((s) => {
    const id = typeof s?.id === "string" ? s.id : "", c = Number(s?.confidence), reason = typeof s?.reason === "string" ? s.reason.trim().replace(/\s+/g, " ").slice(0, 300) : "";
    if (!want.has(id) || seen.has(id) || !Number.isFinite(c) || c < 0 || c > 1 || !reason) return [];
    seen.add(id);
    return [{ id, confidence: Math.round(c * 1000) / 1000, reason }];
  });
}

async function call(base, key, path, body) {
  const r = await fetch(`${base}/api/v0/agent/review-data/${path}`, { method: body ? "POST" : "GET", headers: { "x-pulse-agent-key": key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${data?.error ?? ""}`.trim());
  return data;
}

async function main(argv) {
  const dry = argv.includes("--dry-run"), batches = Math.max(1, Math.min(40, Number(argv[argv.indexOf("--batches") + 1]) || 4));
  const base = (process.env.PULSE_URL ?? "").replace(/\/$/, "");
  const keyFile = (process.env.PULSE_AGENT_KEY_FILE ?? "").replace(/^~(?=\/)/, homedir());
  if (!/^https?:\/\//.test(base) || !keyFile) { console.error("Set PULSE_URL and PULSE_AGENT_KEY_FILE"); return 1; }
  const key = readFileSync(keyFile, "utf8").trim();
  let scored = 0;
  for (let b = 0; b < batches; b++) {
    const { items } = await call(base, key, `queue?limit=${BATCH}`);
    if (!items?.length) break;
    const out = spawnSync(process.env.REVIEW_AI_CLAUDE ?? "claude", ["-p", "--output-format", "text"], { input: promptFor(items), encoding: "utf8", timeout: 300_000, maxBuffer: 4 << 20 });
    if (out.status !== 0) { console.error(`claude did not answer (${out.status}): ${String(out.stderr).slice(0, 300)}`); return 1; }
    const scores = parseScores(out.stdout, items.map((x) => x.id));
    if (!scores.length) { console.error("No usable scores in the answer; stopping"); return 1; }
    if (dry) { console.log(JSON.stringify(scores, null, 1)); scored += scores.length; break; }
    scored += (await call(base, key, "scores", { scores })).scored;
  }
  console.log(`review-ai: ${scored} suggestion${scored === 1 ? "" : "s"} ${dry ? "scored (dry run, nothing sent)" : "checked"}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((rc) => process.exit(rc), (e) => { console.error(e?.message ?? e); process.exit(1); });
