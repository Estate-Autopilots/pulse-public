// SERVERS-AI: the pure half of Pulse Runner (docs/runner/PROTOCOL.md, v1): codes, credentials and tokens, and the
// checks that turn what a server sends into the exact, bounded values Pulse stores. No database, no clock but `now`.
// Unknown fields are ignored (protocol: "both sides must ignore them"); a field of the wrong type is a 400 invalid_request.
import { createHash, randomBytes } from 'node:crypto';

export class RunnerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function refuse(status: number, code: string, message: string): never { throw new RunnerError(status, code, message); }
function bad(message: string): never { throw new RunnerError(400, 'invalid_request', message); }

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hex32 = () => randomBytes(16).toString('hex');
export const jobId = () => `job_${hex32()}`;
export const outputId = () => `out_${hex32()}`;

// ---------------------------------------------------------------------------------------------------- pairing codes
/** ABCD-1234 as the protocol says (`^[A-Z0-9]{4}-[A-Z0-9]{4}$`); Pulse makes them without I, O, 0 and 1. */
export const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeCode(bytes: Buffer = randomBytes(8)) {
  let s = ''; for (const b of bytes.subarray(0, 8)) s += ALPHABET[b % 32];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
/** "abcd 1234", "ABCD1234" or "ABCD-1234" → "ABCD-1234"; anything else is not a code (null). */
export function normalCode(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 20) return null;
  const s = raw.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
}
export const codeHash = (code: string) => sha256(`runner-code:${code}`);
export const CODE_MINUTES = 10;
/** The runner's own default Pulse API (pulse-runner's DEFAULT_CONFIG.apiUrl). */
export const RUNNER_DEFAULT_API = 'https://api.vitalsos.ai';
/** The one line an admin runs on the server, as root: the Pulse Runner package pairs with the code and installs its
 *  service. A Pulse whose runner API is not the runner's default (PULSE_RUNNER_API_URL) names itself with --api-url. */
export function installCommand(code: string, api = process.env.PULSE_RUNNER_API_URL || RUNNER_DEFAULT_API) {
  const origin = api.replace(/\/+$/, '');
  return `sudo npx --yes @vitalsos/pulse-runner connect --code ${code}${origin === RUNNER_DEFAULT_API ? '' : ` --api-url ${origin}`}`;
}

// ---------------------------------------------------------------------------------------------------- secrets
/** The server's credential: prc_ and 43 base64url characters (256 bits). Only its SHA-256 is stored. */
export const CREDENTIAL = /^prc_[A-Za-z0-9_-]{43}$/;
export const makeCredential = () => `prc_${randomBytes(32).toString('base64url')}`;
/** A job's Pulse MCP token: pmt_ and 43 base64url characters. Only its SHA-256 is stored. */
export const MCP_TOKEN = /^pmt_[A-Za-z0-9_-]{43}$/;
export const makeMcpToken = () => `pmt_${randomBytes(32).toString('base64url')}`;
/** Where the server's Claude / Codex reach Pulse's MCP; it must equal the runner's own configured MCP URL. */
export const mcpUrl = () => process.env.PULSE_RUNNER_MCP_URL || 'https://mcp.vitalsos.ai/mcp';

/** The bearer credential of a server call, or null. */
export function bearer(header: unknown) {
  if (typeof header !== 'string') return null;
  const m = /^Bearer (\S+)$/.exec(header);
  return m && CREDENTIAL.test(m[1]) ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------------- shapes
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const JOB_ID = /^job_[0-9a-f]{32}$/;
const ANY_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const text = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) || null : null;
const num = (v: unknown, lo = 0, hi = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
const int = (v: unknown, lo = 0, hi = Number.MAX_SAFE_INTEGER) => { const n = num(v, lo, hi); return n === null ? null : Math.floor(n); };
const bool = (v: unknown) => typeof v === 'boolean' ? v : null;
const iso = (v: unknown) => { if (typeof v !== 'string' || v.length > 40) return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/** POST /pair's runner block: hostname, os, arch, version (each bounded, all optional). */
export function cleanPair(body: unknown) {
  if (!isObj(body)) bad('Send JSON with code and runner');
  const b = body as Obj, code = normalCode(b.code);
  if (!code) bad('code must look like ABCD-1234');
  const r = isObj(b.runner) ? b.runner : {};
  return { code: code!, hostname: text(r.hostname, 255), os: text(r.os, 40), arch: text(r.arch, 40), version: text(r.version, 40) };
}

/** runningJobs: job ids the server is running (at most 64; anything that is not an id is dropped). */
function running(v: unknown) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) bad('runningJobs must be an array');
  return [...new Set((v as unknown[]).filter((x): x is string => typeof x === 'string' && ANY_JOB_ID.test(x)))].slice(0, 64);
}

export function cleanHeartbeat(body: unknown) {
  const b = isObj(body) ? body : {};
  const status = b.status === 'draining' ? 'draining' : 'ready';
  return { version: text(b.version, 40), status, runningJobs: running(b.runningJobs), maxConcurrent: int(b.maxConcurrent, 0, 64), uptimeSec: int(b.uptimeSec, 0) };
}

/** Pulse holds a poll at most 25 s (the runner gives up after waitSec + 15). */
export const MAX_WAIT_SEC = 25;
export function cleanPoll(body: unknown) {
  const b = isObj(body) ? body : {};
  const wait = num(b.waitSec, 0, 3600), slots = int(b.slots, 0, 64);
  return { waitSec: Math.min(wait ?? MAX_WAIT_SEC, MAX_WAIT_SEC), slots: slots ?? 0, runningJobs: running(b.runningJobs) };
}

/** Capabilities, allow-listed field by field: exactly the protocol's list; anything else is dropped, never stored. */
export function cleanCapabilities(body: unknown) {
  if (!isObj(body)) bad('Send the capabilities as a JSON object');
  const b = body as Obj, o = (v: unknown) => isObj(v) ? v : {};
  const sys = o(b.system), cpu = o(sys.cpu), ram = o(sys.ram), disk = o(sys.disk), ai = o(b.ai), tools = o(b.tools), iso_ = o(b.isolation), lim = o(b.limits);
  const bytes = (x: Obj) => ({ totalBytes: num(x.totalBytes), freeBytes: num(x.freeBytes) });
  const cli = (x: unknown, extra: boolean) => {
    const c = o(x);
    return { installed: bool(c.installed) ?? false, version: text(c.version, 40), loggedIn: bool(c.loggedIn) ?? false,
      ...(extra ? { authMethod: text(c.authMethod, 40), subscriptionType: text(c.subscriptionType, 40) } : {}) };
  };
  const tool = (k: string) => text(tools[k], 40);
  return {
    runnerVersion: text(b.runnerVersion, 40), reportedAt: iso(b.reportedAt),
    system: { os: text(sys.os, 40), arch: text(sys.arch, 40), cpu: { model: text(cpu.model, 120), cores: int(cpu.cores, 0, 4096), loadAvg1: num(cpu.loadAvg1, 0, 100000) },
      ram: bytes(ram), disk: bytes(disk) },
    ai: { claude: cli(ai.claude, true), codex: cli(ai.codex, true) },
    tools: { node: tool('node'), python: tool('python'), git: tool('git'), docker: tool('docker') },
    isolation: { mode: text(iso_.mode, 20), available: bool(iso_.available) ?? false, verified: bool(iso_.verified) ?? false, reason: text(iso_.reason, 300) },
    limits: { maxConcurrent: int(lim.maxConcurrent, 0, 64), maxProfile: ['read-only', 'write', 'shell'].includes(lim.maxProfile as string) ? lim.maxProfile as string : null,
      allowNoSandbox: bool(lim.allowNoSandbox) ?? false },
    // AI-EMPLOYEE-POWER: whether the runner runs direct shell jobs and root jobs (allowRoot and its root helper there).
    shell: { direct: bool(o(b.shell).direct) ?? false, root: bool(o(b.shell).root) ?? false },
  };
}

// ---------------------------------------------------------------------------------------------------- events
export const EVENT_TYPES = ['status', 'agent', 'log', 'usage', 'limits', 'warning', 'dry_run'] as const;
export const STATES = ['accepted', 'running', 'stopping', 'uploading'] as const;
/** One stored event's data is kept under 32 KiB; a longer one keeps its type and says it was cut. */
const EVENT_BYTES = 32 * 1024;
export type RunnerEvent = { seq: number; ts: string | null; type: typeof EVENT_TYPES[number]; data: Obj };
/** A batch: up to 100 events with seq ≥ 1. Unknown event types are skipped (the protocol may grow); the batch is not refused. */
export function cleanEvents(body: unknown): RunnerEvent[] {
  if (!isObj(body) || !Array.isArray(body.events)) bad('Send { "events": [...] }');
  const list = (body as { events: unknown[] }).events;
  if (list.length > 100) bad('At most 100 events per batch');
  const out: RunnerEvent[] = [];
  for (const e of list) {
    if (!isObj(e)) bad('Each event is an object');
    const seq = (e as Obj).seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || seq > 2_000_000_000) bad('Each event needs a whole seq from 1');
    const type = (e as Obj).type;
    if (!(EVENT_TYPES as readonly unknown[]).includes(type)) continue;
    let data: Obj = isObj((e as Obj).data) ? (e as Obj).data as Obj : {};
    if (type === 'status') data = { state: (STATES as readonly unknown[]).includes(data.state) ? data.state : null, ...(text(data.reason, 300) ? { reason: text(data.reason, 300) } : {}) };
    if (type === 'usage') data = cleanUsage(data) ?? {};
    if (type === 'warning') data = { code: text(data.code, 60), message: text(data.message, 500) };
    if (type === 'log') data = { stream: data.stream === 'stderr' ? 'stderr' : 'stdout', line: typeof data.line === 'string' ? data.line.slice(0, 8000) : '', ...(data.truncated === true ? { truncated: true } : {}) };
    if (Buffer.byteLength(JSON.stringify(data)) > EVENT_BYTES) data = { truncated: true, bytes: Buffer.byteLength(JSON.stringify(data)) };
    out.push({ seq, ts: iso((e as Obj).ts), type: type as RunnerEvent['type'], data });
  }
  return out;
}

export function cleanUsage(v: unknown) {
  if (!isObj(v)) return null;
  const n = (k: string) => num(v[k], 0, 1e12);
  return { costUsd: n('costUsd'), inputTokens: n('inputTokens'), outputTokens: n('outputTokens'), cacheReadTokens: n('cacheReadTokens'),
    cacheWriteTokens: n('cacheWriteTokens'), numTurns: n('numTurns'), source: v.source === 'codex' ? 'codex' : v.source === 'claude' ? 'claude' : null };
}

// ---------------------------------------------------------------------------------------------------- result
export const RESULT_STATUS = ['succeeded', 'failed', 'timed_out', 'cancelled', 'rejected'] as const;
export function cleanResult(body: unknown) {
  if (!isObj(body)) bad('Send the result as a JSON object');
  const b = body as Obj;
  if (!(RESULT_STATUS as readonly unknown[]).includes(b.status)) bad('status is succeeded, failed, timed_out, cancelled or rejected');
  const err = isObj(b.error) ? { code: typeof b.error.code === 'string' && /^[a-z_]{1,40}$/.test(b.error.code) ? b.error.code : 'internal_error', message: text(b.error.message, 500) } : null;
  const outs = Array.isArray(b.outputs) ? (b.outputs as unknown[]).filter(isObj).slice(0, 20).map((x) => ({
    path: text(x.path, 512), bytes: num(x.bytes), sha256: typeof x.sha256 === 'string' && /^[0-9a-f]{1,64}$/i.test(x.sha256) ? x.sha256.toLowerCase() : null,
    outputId: typeof x.outputId === 'string' && /^out_[0-9a-f]{32}$/.test(x.outputId) ? x.outputId : null })) : [];
  const a = isObj(b.audit) ? b.audit : {};
  const who = (v: unknown) => isObj(v) ? { ...(text(v.type, 40) ? { type: text(v.type, 40) } : {}), id: text(v.id, 80), name: text(v.name, 120) } : null;
  const approval = isObj(a.approval) ? { approvedBy: who(a.approval.approvedBy), approvedAt: iso(a.approval.approvedAt) } : null;
  return {
    status: b.status as typeof RESULT_STATUS[number], dryRun: b.dryRun === true, exitCode: int(b.exitCode, -2147483648, 2147483647),
    signal: text(b.signal, 20), error: err, startedAt: iso(b.startedAt), finishedAt: iso(b.finishedAt), durationMs: int(b.durationMs, 0),
    usage: cleanUsage(b.usage), outputs: outs,
    audit: { requestedBy: who(a.requestedBy), kind: text(a.kind, 20), profile: text(a.profile, 20), approval, isolation: text(a.isolation, 20),
      promptSha256: typeof a.promptSha256 === 'string' && /^[0-9a-f]{1,64}$/i.test(a.promptSha256) ? a.promptSha256.toLowerCase() : null },
  };
}

// ---------------------------------------------------------------------------------------------------- outputs
/** A declared output path: relative to the job's workdir, no `..`, no absolute path, no backslash or control characters. */
export function outputPath(raw: unknown) {
  if (typeof raw !== 'string' || !raw || raw.length > 512 || /[\u0000-\u001f\u007f\\]/.test(raw) || raw.startsWith('/')) return null;
  const parts = raw.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return raw;
}
/** Pulse keeps uploaded output files up to 8 MiB each (the web edge buffers at most 10 MB per request). */
export const OUTPUT_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------- jobs Pulse sends
export const SHELL_SAFE = ['echo', 'uname', 'uptime', 'df', 'free', 'nproc', 'sleep'] as const;
export const PROFILES = ['read-only', 'write', 'shell'] as const;
export const MODEL = /^[A-Za-z0-9._:\-[\]]{1,100}$/;
export const MAX_TIME_LIMIT_SEC = 4 * 3600;
export type JobRequest = { kind: 'claude' | 'codex' | 'shell-safe'; prompt: string | null; command: string[] | null; profile: typeof PROFILES[number];
  model: string | null; timeLimitSec: number; costCapUsd: number | null; outputs: { path: string; required: boolean }[]; dryRun: boolean; approve: boolean };

/** An admin's job, checked as the runner will check it (so a mistake is a 400 here, not a rejected job there). */
export function cleanJobRequest(body: unknown): JobRequest {
  if (!isObj(body)) bad('Send the job as a JSON object');
  const b = body as Obj;
  const kind = b.kind;
  if (kind !== 'claude' && kind !== 'codex' && kind !== 'shell-safe') bad('kind is claude, codex or shell-safe');
  const profile = (b.profile ?? 'read-only') as string;
  if (!(PROFILES as readonly string[]).includes(profile)) bad('profile is read-only, write or shell');
  let prompt: string | null = null, command: string[] | null = null, costCapUsd: number | null = null;
  if (kind === 'shell-safe') {
    if (b.prompt !== undefined && b.prompt !== null) bad('A shell-safe job takes a command, not a prompt');
    if (!Array.isArray(b.command) || !b.command.length || b.command.length > 16 || b.command.some((a) => typeof a !== 'string' || a.length > 200 || /[\u0000\n\r]/.test(a))) bad('command is a list of up to 16 words, such as ["df", "-h"]');
    command = b.command as string[];
    if (!(SHELL_SAFE as readonly string[]).includes(command[0])) bad(`A shell-safe command is one of ${SHELL_SAFE.join(', ')}`);
    if (command[0] === 'sleep' && !(command.length === 2 && /^\d{1,3}$/.test(command[1]) && Number(command[1]) <= 300)) bad('sleep takes one number of seconds, up to 300');
    if (profile !== 'read-only') bad('A shell-safe job runs read-only');
  } else {
    if (b.command !== undefined && b.command !== null) bad('Only a shell-safe job takes a command');
    if (typeof b.prompt !== 'string' || !b.prompt.trim()) bad('Write what the AI should do');
    prompt = b.prompt as string;
    if (Buffer.byteLength(prompt) > 1024 * 1024) bad('The prompt is at most 1 MiB');
    costCapUsd = num(b.costCapUsd, 0.01, 1000) ?? (b.costCapUsd === undefined ? 1 : bad('costCapUsd is 0.01 to 1000'));
  }
  const timeLimitSec = b.timeLimitSec === undefined ? (kind === 'shell-safe' ? 120 : 900) : int(b.timeLimitSec, 1, MAX_TIME_LIMIT_SEC) ?? bad(`timeLimitSec is 1 to ${MAX_TIME_LIMIT_SEC}`);
  const model = b.model === undefined || b.model === null || b.model === '' ? null : typeof b.model === 'string' && MODEL.test(b.model) ? b.model : bad('That model name is not valid');
  if (kind === 'shell-safe' && model) bad('A shell-safe job has no model');
  const outputs = b.outputs === undefined ? [] : Array.isArray(b.outputs) && b.outputs.length <= 20
    ? (b.outputs as unknown[]).map((o) => { const p = outputPath(isObj(o) ? o.path : null); if (!p) bad('An output path is relative to the job folder, without ..'); return { path: p!, required: isObj(o) && o.required === true }; })
    : bad('outputs is a list of up to 20 { path, required }');
  if (new Set(outputs.map((o) => o.path)).size !== outputs.length) bad('Each output path once');
  const approve = b.approve === true;
  // The approval decision belongs to Pulse: write and shell need an admin's explicit approval on this request.
  if (profile !== 'read-only' && !approve) bad('A write or shell job needs your approval (approve: true)');
  return { kind: kind as JobRequest['kind'], prompt, command, profile: profile as JobRequest['profile'], model, timeLimitSec, costCapUsd, outputs, dryRun: b.dryRun === true, approve };
}

export type JobRow = { id: string; org_id: string; kind: string; prompt: string | null; command: string[] | null; profile: string; approval: Obj | null; model: string | null;
  time_limit_sec: number; cost_cap_usd: string | number | null; outputs: { path: string; required: boolean }[]; dry_run: boolean; requested_by: string; requester_name: string | null;
  requested_by_type?: string | null; access_level?: string | null; sandbox?: boolean | null };
/** The protocol's Job object for one stored job (mcp only for claude and codex). */
export function jobObject(j: JobRow, mcp: { token: string; expiresAt: string } | null) {
  // AI-EMPLOYEE-POWER: only Claude and Codex jobs carry a prompt, a cost cap and an MCP token; shell-safe and shell a command.
  const ai = j.kind === 'claude' || j.kind === 'codex';
  return {
    id: j.id, orgId: j.org_id, kind: j.kind,
    ...(ai ? { prompt: j.prompt } : { command: j.command }),
    profile: j.profile, approval: j.approval ?? null, ...(j.model ? { model: j.model } : {}),
    limits: { timeLimitSec: j.time_limit_sec, ...(ai ? { costCapUsd: Number(j.cost_cap_usd) } : {}) },
    outputs: j.outputs ?? [],
    ...(ai && mcp ? { mcp: { url: mcpUrl(), token: mcp.token, expiresAt: mcp.expiresAt } } : {}),
    requestedBy: { type: j.requested_by_type === 'ai-employee' ? 'ai-employee' : 'person', id: j.requested_by, ...(j.requester_name ? { name: j.requester_name } : {}) },
    // RUNNERS-FULL (PROTOCOL.md §4): the level the job was queued at, and whether Pulse wants it sandboxed.
    ...(j.access_level ? { access: { level: j.access_level, sandbox: j.sandbox !== false } } : {}),
    dryRun: j.dry_run,
  };
}

/** Online: a heartbeat or a poll within the last 90 seconds. */
export const ONLINE_SEC = 90;
export const online = (lastSeen: string | Date | null, now = Date.now()) => !!lastSeen && now - new Date(lastSeen).getTime() <= ONLINE_SEC * 1000;

// ---------------------------------------------------------------------------------------------------- RUNNERS-FULL
/** A server's access level, set by an admin: read-only (default), read-write (files), full (files and shell). */
export const ACCESS_LEVELS = ['read-only', 'read-write', 'full'] as const;
export type AccessLevel = typeof ACCESS_LEVELS[number];
/** The most a level allows (the database's pulse.runner_level_allows says the same). */
export function levelAllows(level: string, profile: string) {
  return profile === 'read-only' || (profile === 'write' && (level === 'read-write' || level === 'full')) || (profile === 'shell' && level === 'full');
}
/** Settings → Servers → Access: { level, sandbox, aiEmployees, reason }. The sandbox stays on unless turned off. */
export function cleanAccess(body: unknown) {
  if (!isObj(body)) bad('Send the access as a JSON object');
  const b = body as Obj;
  if (!(ACCESS_LEVELS as readonly unknown[]).includes(b.level)) bad('Access is read-only, read-write or full');
  if (b.sandbox !== undefined && typeof b.sandbox !== 'boolean') bad('sandbox is true or false');
  if (b.aiEmployees !== undefined && typeof b.aiEmployees !== 'boolean') bad('aiEmployees is true or false');
  return { level: b.level as AccessLevel, sandbox: b.sandbox !== false, aiEmployees: b.aiEmployees === true, reason: text(b.reason, 500) };
}

/** A subscription login asked of a server (PROTOCOL.md §10). */
export const LOGIN_ID = /^lgn_[0-9a-f]{32}$/;
export const loginId = () => `lgn_${hex32()}`;
export const LOGIN_TOOLS = ['claude', 'codex'] as const;
export const LOGIN_STATES = ['starting', 'waiting', 'verifying', 'succeeded', 'failed', 'cancelled'] as const;
export const LOGIN_FINAL = ['succeeded', 'failed', 'cancelled', 'expired'];
/** What the server says about a login: a state, and only with "waiting" the https link and the device code. */
export function cleanLoginReport(body: unknown) {
  if (!isObj(body)) bad('Send the login state as a JSON object');
  const b = body as Obj;
  if (!(LOGIN_STATES as readonly unknown[]).includes(b.state)) bad('state is starting, waiting, verifying, succeeded, failed or cancelled');
  const state = b.state as typeof LOGIN_STATES[number];
  const url = state === 'waiting' && typeof b.url === 'string' && b.url.length <= 2048 && /^https:\/\/[^\s\u0000-\u001f\u007f]+$/.test(b.url) ? b.url : null;
  const userCode = state === 'waiting' && typeof b.userCode === 'string' && /^[A-Za-z0-9-]{4,24}$/.test(b.userCode) ? b.userCode : null;
  const err = isObj(b.error) ? { code: typeof b.error.code === 'string' && /^[a-z_]{1,40}$/.test(b.error.code) ? b.error.code : 'login_failed', message: text(b.error.message, 300) } : null;
  return { state, url, userCode, needsCode: state === 'waiting' && b.needsCode === true, error: err };
}
/** A pasted one-time code: one run of printable characters, as the provider's page shows it. */
export function cleanPastedCode(raw: unknown) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s.length >= 4 && s.length <= 512 && /^[\x21-\x7e]+$/.test(s) ? s : null;
}
type AiLogins = Record<string, { lastLoggedInAt?: string | null; lapsedAt?: string | null; plan?: string | null }>;
/** When each CLI was last seen signed in, and since when it is not (a lapsed login), from a new capability report. */
export function nextAiLogins(prev: unknown, caps: ReturnType<typeof cleanCapabilities>, now = new Date().toISOString()): AiLogins {
  const p = (isObj(prev) ? prev : {}) as AiLogins, out: AiLogins = {};
  for (const tool of LOGIN_TOOLS) {
    const c = caps.ai[tool] as { installed: boolean; loggedIn: boolean; subscriptionType?: string | null };
    const was = isObj(p[tool]) ? p[tool] : {};
    if (c.loggedIn) out[tool] = { lastLoggedInAt: now, lapsedAt: null, plan: c.subscriptionType ?? was.plan ?? null };
    else if (was.lastLoggedInAt) out[tool] = { lastLoggedInAt: was.lastLoggedInAt, lapsedAt: was.lapsedAt ?? now, plan: was.plan ?? null };
  }
  return out;
}
/** A CLI that was signed in on this server and now is not: Settings shows "needs a new login". */
export const needsLogin = (cli: { installed?: boolean; loggedIn?: boolean } | undefined, seen: AiLogins[string] | undefined) =>
  !!cli?.installed && !cli.loggedIn && !!seen?.lastLoggedInAt;
