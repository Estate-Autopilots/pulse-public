// CHAT-WORK: how an AI employee's model is called on this server, one run at a time, with every tool off and the prompt
// on stdin (never in argv): Claude Code (`claude -p`), the Codex CLI (`codex exec`) or a stub for tests. A plan that is
// out of quota is told apart from any other failure, with its reset time when the CLI says it.
// CONNECT-AI: and with the organisation's own connection (Settings → AI), handed to this runtime by Pulse inside the run:
//  * a subscription: the same CLI with its long-lived Claude token (CLAUDE_CODE_OAUTH_TOKEN) or its Codex sign-in (an
//    auth.json in a private CODEX_HOME), on this server or on the organisation's workspace over SSH (its key in a 600
//    temp file, its host key pinned); the secret travels on stdin's first line, never in argv or a log, and every temp
//    file is removed after the run; Codex's refreshed sign-in comes back so Pulse can seal it again;
//  * an API key: providers.mjs (OpenAI-compatible, Anthropic, Gemini), called from this server.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthError, callApi } from "./providers.mjs";

export class QuotaError extends Error { constructor(until, text) { super("out of quota"); this.until = until; this.text = text; } }
/** FEATURES-1024: the run was stopped because it looped or talked past its budget (budget.mjs watchCodex). */
export class RunawayError extends Error {}
export { AuthError };

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** When an "out of quota" message says the plan resets, as a Date (UTC unless it says otherwise), or null. Both CLIs'
 *  wordings: "resets Oct 24, 11am (UTC)" and "try again at Oct 27th, 2026 6:34 AM". */
export function quotaUntil(text, now = new Date()) {
  const m = String(text).match(/(?:resets?|try again at|try again on|available again at)\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?,?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mon === undefined) return null;
  let h = Number(m[4]) % 12; if (m[6] && /p/i.test(m[6])) h += 12; if (!m[6]) h = Number(m[4]);
  let year = m[3] ? Number(m[3]) : now.getUTCFullYear();
  let at = new Date(Date.UTC(year, mon, Number(m[2]), h, Number(m[5] ?? 0)));
  if (!m[3] && at.getTime() < now.getTime() - 86400000) at = new Date(Date.UTC(++year, mon, Number(m[2]), h, Number(m[5] ?? 0)));
  return Number.isNaN(at.getTime()) ? null : at;
}
export const QUOTA = /usage limit|weekly limit|rate limit|quota|limit reached|hit your (?:\w+ )?limit|out of (?:credits|usage)|5-hour limit/i;
const SIGNED_OUT = /invalid.{0,20}(?:token|api key|credential)|unauthori[sz]ed|authentication_error|token (?:has )?expired|not logged in|please (?:run )?\/?login/i;

function run(cmd, args, input, timeoutMs, env = {}, watch = null) {
  return new Promise((resolve, reject) => {
    const { CWD, ...rest } = env;
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...rest }, cwd: CWD });
    let out = "", err = "", pending = "", stopped = false; const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timeout")); }, timeoutMs);
    // FEATURES-1024: a watcher reads each output line as it comes and stops a run that loops or runs past its budget.
    child.stdout.on("data", (d) => {
      out += d; if (!watch || stopped) return;
      pending += d; const lines = pending.split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) { const why = watch(line); if (why) { stopped = true; clearTimeout(timer); child.kill("SIGKILL"); reject(new RunawayError(why)); return; } }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const CLAUDE_ARGS = (model, effort) => ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--strict-mcp-config", ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
const CODEX_ARGS = (model, effort) => ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", ...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : [])];
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** The shell a connected CLI run uses (here or on a workspace); the same as the API's test (ai-providers.ts cliScript). */
export function cliScript(provider, args) {
  const a = args.map(q).join(" ");
  if (provider === "claude") return `set -u; IFS= read -r S; d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; cd "$d"; if [ -n "$S" ]; then export CLAUDE_CODE_OAUTH_TOKEN="$(printf %s "$S" | base64 -d)"; export CLAUDE_CONFIG_DIR="$d"; fi; unset S; claude ${a}`;
  return `set -u; IFS= read -r S; d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; cd "$d"; if [ -n "$S" ]; then mkdir -m 700 "$d/home"; printf %s "$S" | base64 -d > "$d/home/auth.json"; chmod 600 "$d/home/auth.json"; export CODEX_HOME="$d/home"; fi; unset S; codex ${a}; c=$?; if [ -f "$d/home/auth.json" ]; then printf '\\n@@PULSE_AUTH@@%s\\n' "$(base64 -w0 "$d/home/auth.json")" >&2; fi; exit $c`;
}
/** Run a script on a workspace over SSH: its key in a 600 file in a private temp directory, its pinned host key only. */
async function sshRun(w, script, input, timeoutMs) {
  const dir = await mkdtemp(join(tmpdir(), "pulse-ws-"));
  try {
    const id = join(dir, "id"), kh = join(dir, "known_hosts");
    await writeFile(id, w.privateKey.endsWith("\n") ? w.privateKey : `${w.privateKey}\n`, { mode: 0o600 });
    await writeFile(kh, w.hostKey ? `${w.hostKey}\n` : "", { mode: 0o600 });
    return await run("ssh", ["-i", id, "-p", String(w.port), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", `UserKnownHostsFile=${kh}`,
      "-o", "GlobalKnownHostsFile=/dev/null", "-o", `StrictHostKeyChecking=${w.hostKey ? "yes" : "accept-new"}`, "-o", "LogLevel=ERROR", `${w.username}@${w.host}`, `bash -lc ${q(script)}`], input, timeoutMs);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function readClaude(r, started) {
  let d; try { d = JSON.parse(r.out.slice(r.out.indexOf("{"))); } catch { d = null; }
  const said = String(d?.result ?? r.out + r.err);
  if ((d?.is_error || r.code !== 0) && (QUOTA.test(said) || d?.api_error_status === 429)) throw new QuotaError(quotaUntil(said), said.slice(0, 200));
  if ((d?.is_error || r.code !== 0) && SIGNED_OUT.test(said)) throw new AuthError(`claude sign-in refused: ${said.slice(0, 160)}`);
  if (r.code === 255 && !d) throw new Error(`workspace unreachable: ${r.err.slice(0, 160)}`);
  if (!d || d.is_error) throw new Error(`claude failed: ${said.slice(0, 160)}`);
  const u = d.usage ?? {};
  const tokens = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((n, k) => n + (Number(u[k]) || 0), 0) || null;
  const tokensIn = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((n, k) => n + (Number(u[k]) || 0), 0);
  return { text: String(d.result ?? ""), tokens, tokensIn, tokensOut: Number(u.output_tokens) || 0, seconds: (Date.now() - started) / 1000 };
}
function readCodex(r, started) {
  let text = "", tokens = null, failed = "", tokensIn = null, tokensOut = null;
  for (const line of r.out.split("\n")) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "item.completed" && d.item?.type === "agent_message") text = String(d.item.text ?? "");
    if (d.type === "turn.completed" && d.usage) {
      tokens = ["input_tokens", "output_tokens", "reasoning_output_tokens"].reduce((n, k) => n + (Number(d.usage[k]) || 0), 0) || null;
      tokensIn = Number(d.usage.input_tokens) || 0; tokensOut = (Number(d.usage.output_tokens) || 0) + (Number(d.usage.reasoning_output_tokens) || 0);
    }
    if (d.type === "error" || d.type === "turn.failed") failed = String(d.message ?? d.error?.message ?? "");
  }
  const err = r.err.replace(/@@PULSE_AUTH@@\S+/, "");
  if (!text && QUOTA.test(failed + err)) throw new QuotaError(quotaUntil(failed + err), (failed || err).slice(0, 200));
  if (!text && SIGNED_OUT.test(failed + err)) throw new AuthError(`codex sign-in refused: ${(failed || err).slice(0, 160)}`);
  if (!text && r.code === 255) throw new Error(`workspace unreachable: ${err.slice(0, 160)}`);
  if (!text) throw new Error(`codex failed: ${(failed || err).slice(0, 160)}`);
  const m = r.err.match(/@@PULSE_AUTH@@([A-Za-z0-9+/=]+)/);
  return { text, tokens, tokensIn, tokensOut, seconds: (Date.now() - started) / 1000, refreshed: m ? Buffer.from(m[1], "base64").toString("utf8") : null };
}

/** The model's text, its own token count (or null) and the seconds it took; throws QuotaError when the plan refuses and
 *  AuthError when the sign-in or key is refused. `connection` and `workspace` come from Pulse for this run only. */
export async function callModel({ provider, model, effort, connection, workspace }, prompt, { timeoutMs = 420000, stub, watch = null, maxOut = null } = {}) {
  const started = Date.now();
  if (provider === "stub" || stub) {
    const r = await stub(prompt);
    return { text: r, tokens: Math.ceil(prompt.length / 4) + Math.ceil(r.length / 4), tokensIn: Math.ceil(prompt.length / 4), tokensOut: Math.ceil(r.length / 4), seconds: (Date.now() - started) / 1000 };
  }
  // FEATURES-1024: Claude Code keeps to the run's output budget; a Codex run is watched line by line (it can loop).
  const capEnv = provider === "claude" && maxOut ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOut) } : {};
  // CONNECT-AI: an API key of the organisation's (any provider).
  if (connection?.kind === "api") {
    const r = await callApi(connection, model || connection.model, prompt, effort, timeoutMs, maxOut ?? undefined).catch((e) => { if (e.quota) throw new QuotaError(quotaUntil(e.message), e.message.slice(0, 200)); throw e; });
    return { ...r, seconds: (Date.now() - started) / 1000 };
  }
  if (provider === "api") throw new Error("not connected: its AI connection was not handed over; choose a connected AI on its profile");
  // CONNECT-AI: a subscription of the organisation's, or this server's own sign-in on one of its workspaces.
  if ((provider === "claude" || provider === "codex") && (connection || workspace)) {
    const args = provider === "claude" ? CLAUDE_ARGS(model, effort) : CODEX_ARGS(model, effort);
    const line = connection?.secret ? Buffer.from(connection.secret, "utf8").toString("base64") : "";
    const script = cliScript(provider, args), input = `${line}\n${prompt}`;
    const r = workspace ? await sshRun(workspace, script, input, timeoutMs) : await run("bash", ["-c", script], input, timeoutMs, capEnv, provider === "codex" ? watch : null);
    return provider === "claude" ? readClaude(r, started) : readCodex(r, started);
  }
  const dir = await mkdtemp(join(tmpdir(), "pulse-coworker-"));
  try {
    if (provider === "claude") return readClaude(await run("claude", CLAUDE_ARGS(model, effort), prompt, timeoutMs, { CWD: dir, ...capEnv }), started);
    if (provider === "codex") return readCodex(await run("codex", CODEX_ARGS(model, effort), prompt, timeoutMs, { CWD: dir }, watch), started);
    // AI-EMPLOYEES v2: the older API runtimes had no key on this server; CONNECT-AI replaces them with connections.
    if (provider === "anthropic_api" || provider === "openai_api") throw new Error(`not connected: connect ${provider === "anthropic_api" ? "a Claude API" : "an OpenAI API"} key in Settings → AI and choose it on its profile`);
    throw new Error(`unknown runtime ${provider}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** The JSON object a model answered with (its answer may be wrapped in a code fence or a sentence). */
export function answerJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch { /* look for the object inside */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* not JSON */ } }
  return null;
}
