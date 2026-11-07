import { DEFAULT_PROFILE, PROFILES, SHELL_MAX_BYTES, SHELL_SAFE_COMMANDS, profileWithinCeiling } from './profiles.js';

export class JobRejected extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRejected';
    this.code = code;
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL_RE = /^[A-Za-z0-9._:\-[\]]{1,100}$/;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_OUTPUTS = 20;
export const ACCESS_LEVELS = Object.freeze(['read-only', 'read-write', 'full']);

const invalid = (message) => new JobRejected('invalid_job', message);

export function isValidJobId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function validateOutputPath(p) {
  if (typeof p !== 'string' || !p || p.length > 512 || p.includes('\0') || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((part) => part && part !== '.' && part !== '..');
}

/** Checks a job from Pulse and returns a normalised copy. Throws JobRejected on any problem. */
export function validateJob(job, { config, orgId, now = Date.now() }) {
  if (!job || typeof job !== 'object') throw invalid('job must be an object');
  if (!isValidJobId(job.id)) throw invalid('id is invalid');
  if (job.orgId !== orgId) throw new JobRejected('org_mismatch', 'job is for a different organisation');
  if (!['claude', 'codex', 'shell-safe', 'shell'].includes(job.kind)) throw invalid('kind is invalid');
  if (!job.requestedBy?.type || !job.requestedBy?.id) throw invalid('requestedBy.type and requestedBy.id are required');

  const timeLimitSec = job.limits?.timeLimitSec;
  if (!Number.isFinite(timeLimitSec) || timeLimitSec <= 0) throw invalid('limits.timeLimitSec must be a positive number');
  if (timeLimitSec > config.maxTimeLimitSec) throw invalid(`limits.timeLimitSec is above the runner's limit of ${config.maxTimeLimitSec}`);

  const outputs = job.outputs ?? [];
  if (!Array.isArray(outputs) || outputs.length > MAX_OUTPUTS) throw invalid(`outputs must be an array of at most ${MAX_OUTPUTS}`);
  for (const output of outputs) {
    if (!validateOutputPath(output?.path)) throw invalid('outputs[].path must be a relative path inside the workdir');
  }

  const profile = job.profile ?? DEFAULT_PROFILE;
  const normal = {
    ...job,
    profile,
    outputs: outputs.map((o) => ({ path: o.path, required: o.required === true })),
    dryRun: job.dryRun === true,
    approval: job.approval ?? null,
    // RUNNERS-FULL: the access level Pulse's admin set for this server and whether Pulse wants the sandbox. Informational
    // apart from sandbox:false, which the local allowNoSandbox must also allow (daemon.js). Anything else reads as none.
    access: job.access && typeof job.access === 'object' && ACCESS_LEVELS.includes(job.access.level)
      ? { level: job.access.level, sandbox: job.access.sandbox !== false } : null,
  };

  if (job.kind === 'shell-safe') {
    if (job.prompt !== undefined && job.prompt !== null) throw invalid('shell-safe jobs take command, not prompt');
    const command = job.command;
    if (!Array.isArray(command) || command.length === 0 || command.length > 32) throw invalid('command must be a non-empty argv array');
    if (!command.every((arg) => typeof arg === 'string' && arg.length <= 1024 && !arg.includes('\0'))) throw invalid('command arguments must be strings');
    if (!SHELL_SAFE_COMMANDS.includes(command[0])) throw new JobRejected('command_not_allowed', `${String(command[0]).slice(0, 64)} is not an allowed shell-safe command`);
    return normal;
  }

  // AI-EMPLOYEE-POWER: a direct shell job: one bash command line. read-only and write run in the sandbox (a read-only view
  // of the server; write adds nothing outside the job folder); root runs outside it, only when this server allows root.
  if (job.kind === 'shell') {
    if (job.prompt !== undefined && job.prompt !== null) throw invalid('shell jobs take command, not prompt');
    const command = job.command;
    if (!Array.isArray(command) || command.length !== 1 || typeof command[0] !== 'string' || !command[0].trim()
      || Buffer.byteLength(command[0]) > SHELL_MAX_BYTES || command[0].includes('\0')) throw invalid('a shell job takes one command line');
    if (!['read-only', 'write', 'root'].includes(profile)) throw invalid('a shell job runs read-only, write or root');
    if (PROFILES[profile].needsApproval && !(job.approval?.approvedBy?.id && job.approval?.approvedAt)) {
      throw new JobRejected('approval_required', `profile ${profile} needs the org admin's approval in Pulse`);
    }
    if (profile === 'root') {
      if (config.allowRoot !== true) throw new JobRejected('root_not_allowed', 'This server does not allow root jobs (allowRoot is off in its local config)');
      return normal;
    }
    if (!profileWithinCeiling(profile, config.maxProfile)) {
      throw new JobRejected('profile_not_allowed', `profile ${profile} is above this server's limit of ${config.maxProfile}`);
    }
    return normal;
  }

  if (job.command !== undefined && job.command !== null) throw invalid('command is only for shell-safe jobs');
  if (typeof job.prompt !== 'string' || !job.prompt.trim()) throw invalid('prompt is required');
  if (Buffer.byteLength(job.prompt) > MAX_PROMPT_BYTES) throw invalid('prompt is over 1 MiB');
  if (job.model !== undefined && job.model !== null && !MODEL_RE.test(job.model)) throw invalid('model is invalid');

  if (!PROFILES[profile] || profile === 'root') throw invalid('profile is unknown');
  if (PROFILES[profile].needsApproval && !(job.approval?.approvedBy?.id && job.approval?.approvedAt)) {
    throw new JobRejected('approval_required', `profile ${profile} needs the org admin's approval in Pulse`);
  }
  if (!profileWithinCeiling(profile, config.maxProfile)) {
    throw new JobRejected('profile_not_allowed', `profile ${profile} is above this server's limit of ${config.maxProfile}`);
  }

  const cap = job.limits?.costCapUsd;
  if (!Number.isFinite(cap) || cap <= 0) throw invalid('limits.costCapUsd must be a positive number');

  const mcp = job.mcp;
  if (!mcp || typeof mcp.token !== 'string' || !mcp.token) throw new JobRejected('mcp_invalid', 'mcp.token is required');
  if (mcp.url !== config.mcpUrl) throw new JobRejected('mcp_invalid', 'mcp.url is not the configured Pulse MCP server');
  const expires = Date.parse(mcp.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) throw new JobRejected('mcp_invalid', 'mcp token has expired');

  return normal;
}
