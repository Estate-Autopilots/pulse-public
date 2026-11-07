// AI-SERVER-TOOLS (6 Nov 2026; owner: "We need to give them all access. We decide which agent gets what, but all get
// it."): an AI employee's Pulse tools are Pulse's own MCP tools (services/api/src/mcp.ts, built from every API v1
// operation), called with the AI employee's own key, so it acts as itself under row security, inside its company only,
// in the areas its managers left it (all by default; migration 1590), and every new API v1 area reaches it by itself.
// Engine-neutral: the model asks for tools in its JSON answer ({"tools": [...]}), the runtime calls them and gives the
// results back for the next round (at most TOOL_ROUNDS), then the answer goes out as before.
import { answerJson } from "./runtime.mjs";

export const TOOL_ROUNDS = 3;
export const TOOLS_PER_ROUND = 5;
const SECRET = /(pak_[0-9a-f]{8}_[0-9a-f]{20,}|pmt_[A-Za-z0-9_-]{20,}|pat_[A-Za-z0-9_-]{20,}|psvc_[0-9a-f-]{36}_[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|postgres(ql)?:\/\/\S+:\S+@)/g;
/** What a tool returned, with anything that looks like a secret taken out (the model never sees a secret). */
export const redact = (s) => String(s ?? "").replace(SECRET, "[hidden]");

/** One JSON-RPC call to Pulse's MCP endpoint with the AI employee's key (an SSE or a JSON answer). */
export async function mcpCall(base, key, method, params, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const r = await fetchImpl(`${base}/api/v1/mcp`, { method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} }) });
  const raw = await r.text();
  let j = null;
  try { j = JSON.parse(raw); } catch {
    const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1);
    try { j = data ? JSON.parse(data) : null; } catch { j = null; }
  }
  if (j?.error) { const e = new Error(String(j.error.message ?? "Pulse refused the tool").slice(0, 300)); e.status = r.status; throw e; }
  if (!r.ok || !j) { const e = new Error(`Pulse tools answered ${r.status}`); e.status = r.status; throw e; }
  return j.result;
}

/** The tool list as the prompt shows it: one short line each (name, arguments with * for required, first sentence). */
export function catalogue(tools) {
  return (tools ?? []).filter((t) => t && typeof t.name === "string").map((t) => {
    const props = Object.keys(t.inputSchema?.properties ?? {}).filter((k) => k !== "requestId"), req = new Set(t.inputSchema?.required ?? []);
    // AI-EMPLOYEE-POWER: one short clause each (the catalogue goes into every call with tools).
    const first = String(t.description ?? t.title ?? "").replace(/\s+/g, " ").split(/(?<=\.)\s/)[0].slice(0, 100);
    return `- ${t.name}(${props.map((k) => `${k}${req.has(k) ? "*" : ""}`).join(", ")}): ${first}`;
  }).join("\n");
}

/** The tools the model asked for in its answer: [{name, args}] (at most TOOLS_PER_ROUND), or []. */
export function toolCalls(text, known = null) {
  const j = answerJson(String(text ?? ""));
  const list = Array.isArray(j?.tools) ? j.tools : [];
  return list.filter((x) => x && typeof x === "object" && typeof (x.name ?? x.tool) === "string")
    .map((x) => ({ name: String(x.name ?? x.tool).slice(0, 80), args: x.args && typeof x.args === "object" && !Array.isArray(x.args) ? x.args : x.arguments && typeof x.arguments === "object" ? x.arguments : {} }))
    .filter((x) => !known || known.has(x.name)).slice(0, TOOLS_PER_ROUND);
}

/** A tool's answer as text for the next round (its text content, refusals said as such), at most `max` characters. */
export function resultText(call, result, max = 4000) {
  const text = (result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n")
    || (result?.structuredContent ? JSON.stringify(result.structuredContent) : "");
  const t = redact(text).trim();
  return `${call.name}(${redact(JSON.stringify(call.args)).slice(0, 300)}) ${result?.isError ? "was refused" : "returned"}: ${t.length > max ? `${t.slice(0, max)} … (cut)` : t || "(nothing)"}`;
}

/** The job a run_on_server answer holds (id and whether it has ended), or null. */
export function jobOf(result) {
  const j = result?.structuredContent?.job ?? (() => { try { return JSON.parse((result?.content ?? []).find((c) => c?.type === "text")?.text ?? "null")?.job; } catch { return null; } })();
  return j && typeof j.id === "string" ? { id: j.id, final: j.final === true, kind: j.kind } : null;
}

const TIER_WORDS = { "read-only": "read-only", sandboxed: "read-write in a sandbox", root: "root, unsandboxed", none: "none" };

/** AI-EMPLOYEE-POWER: "run <command> on <server>" asked plainly: the shell job it needs, so the runtime runs it before the
 *  first model call (one model call instead of two). Only for a server it may use; never at root (that stays the model's
 *  explicit choice). */
export function directRun(text, servers = []) {
  const m = String(text ?? "").trim().replace(/^\(test\)\s*/i, "").match(/^(?:please\s+)?run\s+[`"']?(.+?)[`"']?\s+on\s+([A-Za-z0-9._-]+)\s*[?.!]*$/i);
  if (!m) return null;
  const s = servers.find((x) => x.mayUse && String(x.name).toLowerCase() === m[2].toLowerCase());
  return s && m[1].trim() ? { name: "run_on_server", args: { server: s.name, mode: "shell", command: m[1].trim(), level: "read-only" } } : null;
}

/** What the prompt says about its tools (and how to ask for them). */
export function toolsPart(tools, { name, servers = [] } = {}) {
  const usable = servers.filter((s) => s.mayUse), others = servers.filter((s) => !s.mayUse);
  const serverWords = !servers.length ? "Your company has not connected a server to Pulse yet (an organisation admin does that in Settings → Servers)."
    : `Your company's connected servers: ${servers.map((s) => `${s.name} (${s.online ? "online" : "offline"}, ${s.mayUse ? `your tier: ${TIER_WORDS[s.tier] ?? s.accessLevel}${s.tier === "root" ? `, up to ${Math.round((s.timeLimitSec ?? 600) / 60)} min a command` : ""}` : "AI employees may not use it yet"}${s.claude ? ", Claude Code signed in" : ""}${s.codex ? ", Codex signed in" : ""})`).join("; ")}.`
      + (usable.length ? " You may run work on the ones you may use, up to their access level." : "")
      + (others.length ? ` For the others an organisation admin turns on "AI employees may use this server" in Settings → Servers.` : "");
  return `Your Pulse tools. You act in Pulse yourself, as ${name ?? "yourself"}, within your company only, through these tools: tasks, projects, people, HR (leave, attendance), finance, billing (quotes, invoices), companies and clients, chats, documents, search and your company's servers. ${serverWords}
Never say you have no access, cannot see settings or servers, or only see chats when a tool below covers it: use the tool, then answer from what it returned. If a tool refuses, say plainly what it said and who can change it.
To use tools, answer with JSON only: {"tools": [{"name": "tool_name", "args": {…}}]} (up to ${TOOLS_PER_ROUND} at a time). You then get their results and answer again, either with more tools or with your final answer in the usual JSON. At most ${TOOL_ROUNDS} rounds of tools.
For a server: run_on_server (server by name; mode "shell" with command: any bash command line, run at once on the server; or "claude"/"codex" with task). level: "read-only" to look, "write" when the work must change files in your sandbox, "root" only where your tier is root (then it runs as root: installs, docker, services, downloads, ssh/scp to the company's own servers, any file). The runtime waits for the job and gives you its output; a long job keeps running in the background (get_server_job / get_server_job_output later). Quote the real output; never claim a level or limit the job did not have.
Writes (creating or changing tasks, invoices, leave, server work at write or full) are real: do them when the person asked for them or your role clearly needs them, and say what you did. Money and destructive actions ask for confirm: true; ask the person first.
Tools (name(arguments, * required): what it does):
${catalogue(tools)}`;
}
