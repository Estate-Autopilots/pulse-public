// AI-SERVER-TOOLS (6 Nov 2026; owner: "AI employees must be able to work on the company's connected servers"): the
// company's servers over API v1, so AI employees (their own key) and the assistant (a person's connected app) get the same
// tools: list_servers, run_on_server, get_server_job, get_server_job_output. The database decides who may (migration
// 1590): an AI employee where "AI employees may use this server" is on, up to the server's level; a person only as an
// organisation admin. Every job keeps who asked and for whom, and shows in Settings → Servers.
import { defineV1Operation, v1Fail, type V1Context } from './v1.js';
import { bool, change, maybe, object, one, str, text, type Row } from './v1-kit.js';

/** The runner's shell-safe allow-list (docs/runner/PROTOCOL.md §4): these run as a plain argv, no shell, read-only. */
export const SHELL_SAFE = ['echo', 'uname', 'uptime', 'df', 'free', 'nproc', 'sleep'];
const LEVEL_PROFILE: Record<string, string> = { 'read-only': 'read-only', write: 'write', full: 'shell', root: 'root' };
/** A command line the direct shell takes (one line of bash, at most 20,000 bytes). */
const SHELL_MAX = 20000;

/** How a request becomes a runner job (AI-EMPLOYEE-POWER, 6 Nov 2026):
 *  - level root: the command as a root shell job (the database checks the owner's root grant, the runner its own opt-in);
 *  - an allow-listed simple command: shell-safe (no shell at all, read-only);
 *  - any other command on a server whose runner runs a direct shell: a 'shell' job (bash in the sandbox: read-only, or
 *    write in its own work folder), seconds instead of a CLI session;
 *  - otherwise through the server's own CLI as before (Codex runs commands in every sandbox; Claude Code only at full);
 *  - a task: a Claude or Codex job. */
export function planJob(input: { mode: string; command?: string; task?: string; level?: string },
    server: { claude: boolean; codex: boolean; accessLevel: string; directShell?: boolean }) {
  const level = input.level ?? 'read-only';
  const profile = LEVEL_PROFILE[level];
  if (!profile) return { error: 'level is read-only, write, full or root' } as const;
  if (input.mode === 'shell') {
    const cmd = String(input.command ?? '').trim();
    if (!cmd) return { error: 'Give the command to run' } as const;
    if (Buffer.byteLength(cmd) > SHELL_MAX) return { error: 'A command is at most 20,000 bytes; put a longer script in a file first' } as const;
    if (level === 'root') return { kind: 'shell', command: [cmd], prompt: null, profile: 'root' } as const;
    const argv = cmd.split(/\s+/);
    if (!/[|&;<>()$`\\"'*?{}\[\]~!#=]/.test(cmd) && SHELL_SAFE.includes(argv[0]) && argv.length <= 16 && argv.every((a) => a.length <= 200))
      return { kind: 'shell-safe', command: argv, prompt: null, profile: 'read-only' } as const;
    if (server.directShell) return { kind: 'shell', command: [cmd], prompt: null, profile: level === 'read-only' ? 'read-only' : 'write' } as const;
    const prompt = `Run this shell command in your job folder exactly as written, then report its exact output (stdout and stderr, trimmed to the useful part) and its exit code. Do nothing else.\n\n${cmd}`;
    if (server.codex) return { kind: 'codex', command: null, prompt, profile } as const;
    if (server.claude) return { kind: 'claude', command: null, prompt, profile: 'shell' } as const;
    return { error: 'Only echo, uname, uptime, df, free, nproc and sleep run without a CLI; sign in Claude or Codex on this server (Settings → Servers) for other commands.' } as const;
  }
  if (input.mode === 'claude' || input.mode === 'codex') {
    if (level === 'root') return { error: 'Root runs shell commands: use mode shell' } as const;
    const task = String(input.task ?? input.command ?? '').trim();
    if (!task) return { error: 'Give the task for the CLI' } as const;
    if (!(input.mode === 'claude' ? server.claude : server.codex)) return { error: `${input.mode === 'claude' ? 'Claude Code' : 'Codex'} is not signed in on this server.` } as const;
    return { kind: input.mode, command: null, prompt: task, profile } as const;
  }
  return { error: 'mode is shell, claude or codex' } as const;
}

/** A runner job id ("job_" + 32 hex, migration 1590) as the uuid its hex spells (app_change.subject_id is a uuid). */
export const jobUuid = (id: string) => {
  const m = /^job_([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/.exec(id);
  if (!m) throw Object.assign(Error('not a job id'), { code: 'v1_job_id' });
  return m.slice(1).join('-');
};

const SERVER = object({ id: str, name: str, online: bool, accessLevel: str, sandbox: bool, aiEmployees: bool, mayUse: bool, askFirstForWrites: bool,
  tier: str, timeLimitSec: { type: 'integer' }, directShell: bool, rootShell: bool, claude: bool, codex: bool, hostname: maybe, os: maybe });
const JOB = object({ id: str, server: str, kind: str, profile: str, status: str, final: bool, summary: maybe, exitCode: { type: ['integer', 'null'] },
  errorCode: maybe, errorMessage: maybe, accessLevel: maybe, costUsd: { type: ['number', 'null'] }, durationMs: { type: ['number', 'null'] },
  requestedBy: maybe, requestedFor: maybe, output: maybe, link: str });
const jobOut = (j: Row, max: number) => {
  const out = [j.text, j.log].filter((x) => typeof x === 'string' && x.trim()).join('\n').trim();
  return { id: String(j.id), server: String(j.server ?? ''), kind: String(j.kind), profile: String(j.profile), status: String(j.status), final: j.final === true,
    summary: (j.summary as string) ?? null, exitCode: typeof j.exitCode === 'number' ? j.exitCode : null, errorCode: (j.errorCode as string) ?? null,
    errorMessage: (j.errorMessage as string) ?? null, accessLevel: (j.accessLevel as string) ?? null,
    costUsd: j.costUsd === null || j.costUsd === undefined ? null : Number(j.costUsd), durationMs: j.durationMs === null || j.durationMs === undefined ? null : Number(j.durationMs),
    requestedBy: (j.requestedBy as string) ?? null, requestedFor: (j.requestedFor as string) ?? null,
    output: out ? (out.length > max ? `${out.slice(0, max)}\n… (${out.length - max} more characters: get_server_job_output)` : out) : null, link: String(j.link) };
};
const servers = async (ctx: V1Context) => await one<Row[]>(ctx, 'select pulse.runner_server_list() v') ?? [];
const readJob = async (ctx: V1Context, id: string, log: number) => {
  if (!/^job_[0-9a-f]{32}$/.test(id)) v1Fail(404, 'No such job');
  return await one<Row | null>(ctx, 'select pulse.runner_server_job_read($1,$2) v', [id, log]) ?? v1Fail(404, 'No such job');
};
const serverOnly = async (ctx: V1Context) => {
  if (ctx.principal.kind !== 'ai' && !(await one<boolean>(ctx, "select pulse.viewer_is('admin') v"))) v1Fail(403, 'Servers are for organisation admins and AI employees');
};

defineV1Operation({ operationId: 'listServers', method: 'GET', path: '/api/v1/workflows/servers', scope: 'workflows.read',
  summary: 'The company\'s connected servers and what may run on them',
  response: object({ items: { type: 'array', items: SERVER } }),
  mcp: { name: 'list_servers', title: 'List servers',
    description: 'Lists the company\'s connected servers (Settings → Servers): name, online, access level (read-only, read-write or full), sandbox, whether Claude Code or Codex is signed in there, whether you may use it (AI employees: only where "AI employees may use this server" is on), your tier there (read-only, sandboxed or root) and its time limit, and whether the server runs a direct shell (directShell) and root jobs (rootShell).' },
  handler: async (ctx) => { await serverOnly(ctx); return { items: (await servers(ctx)).map((s) => ({ ...s, hostname: s.hostname ?? null, os: s.os ?? null })) }; },
});

defineV1Operation({ operationId: 'runOnServer', method: 'POST', path: '/api/v1/workflows/servers/{server}/jobs', scope: 'workflows.write',
  summary: 'Run a shell command, or a Claude Code or Codex task, on one of the company\'s servers',
  params: object({ server: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^/\\u0000-\\u001f]+$' } }),
  body: object({ mode: { enum: ['shell', 'claude', 'codex'] }, command: text(20000), task: text(20000), level: { enum: ['read-only', 'write', 'full', 'root'] },
    timeLimitSec: { type: 'integer', minimum: 10, maximum: 1800 }, costCapUsd: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
    forPersonId: { type: 'string', pattern: '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' } }, ['mode']),
  response: object({ job: JOB }), authorize: serverOnly,
  mcp: { name: 'run_on_server', title: 'Run on a server',
    description: 'Runs work on a company server by name (from list_servers). mode "shell" runs command, one bash command line: where the server runs a direct shell, at once in its sandbox (level read-only: a read-only view of the server; write: its own work folder too); with level root, as root outside the sandbox (only with your root tier there: internet, ssh and scp to the company\'s own servers, docker, services, any file); otherwise through the server\'s signed-in CLI. mode "claude" or "codex" gives task (a prompt) to that CLI on the server. level read-only (default), write, full or root: never above your tier and the server\'s level. timeLimitSec up to your tier\'s limit. Returns the job; follow it with get_server_job.' },
  handler: async (ctx, { params, body }) => {
    const b = body as { mode: string; command?: string; task?: string; level?: string; timeLimitSec?: number; costCapUsd?: number; forPersonId?: string };
    const all = await servers(ctx), name = params.server;
    const s = all.find((x) => x.id === name) ?? all.find((x) => String(x.name).toLowerCase() === name.trim().toLowerCase())
      ?? v1Fail(404, `No server is called ${name}. list_servers shows the company's servers.`);
    const plan = planJob(b, { claude: s.claude === true, codex: s.codex === true, accessLevel: String(s.accessLevel), directShell: s.directShell === true });
    if ('error' in plan) return v1Fail(400, plan.error!);
    // Root takes its tier's limit unless asked for less (the database clamps it); a direct shell five minutes.
    const limit = b.timeLimitSec ?? (plan.profile === 'root' ? null : plan.kind === 'shell-safe' ? 60 : plan.kind === 'shell' ? 300 : 900);
    const started = await one<Row>(ctx, 'select pulse.runner_server_job_start($1,$2,$3,$4,$5,$6,$7,$8) v',
      [s.id, plan.kind, plan.prompt, plan.command, plan.profile, limit, b.costCapUsd ?? 2, b.forPersonId ?? null]);
    // AI-EMPLOYEE-POWER (6 Nov 2026): app_change_add takes a uuid subject. The job id ("job_" + 32 hex) went in as
    // it was, the database refused it (22P02, a bare 400 "The request was refused") and rolled the job back: every
    // run_on_server failed. The job's uuid is its id's hex; the id itself stays in the detail.
    await change(ctx, 'server.job', jobUuid(String(started.id)), { job: started.id, server: s.name, kind: plan.kind, profile: plan.profile });
    return { job: jobOut(await readJob(ctx, String(started.id), 20), 4000) };
  },
});

defineV1Operation({ operationId: 'getServerJob', method: 'GET', path: '/api/v1/workflows/server-jobs/{jobId}', scope: 'workflows.read',
  summary: 'How a server job is going: status, cost and the start of its output',
  params: object({ jobId: { type: 'string', pattern: '^job_[0-9a-f]{32}$' } }),
  response: object({ job: JOB }),
  mcp: { name: 'get_server_job', title: 'Server job status',
    description: 'The status of a job from run_on_server (queued, running, succeeded, failed, timed_out, cancelled, rejected), its cost, duration, error and the first part of its output. final is true when it has ended.' },
  handler: async (ctx, { params }) => { await serverOnly(ctx); return { job: jobOut(await readJob(ctx, params.jobId, 60), 3000) }; },
});

defineV1Operation({ operationId: 'getServerJobOutput', method: 'GET', path: '/api/v1/workflows/server-jobs/{jobId}/output', scope: 'workflows.read',
  summary: 'A server job\'s full answer and the end of its log',
  params: object({ jobId: { type: 'string', pattern: '^job_[0-9a-f]{32}$' } }),
  response: object({ job: JOB }),
  mcp: { name: 'get_server_job_output', title: 'Server job output',
    description: 'The full answer of a job from run_on_server (the CLI\'s final message, or the command\'s output) and the last lines of its log, up to 20,000 characters.' },
  handler: async (ctx, { params }) => { await serverOnly(ctx); return { job: jobOut(await readJob(ctx, params.jobId, 400), 20000) }; },
});
