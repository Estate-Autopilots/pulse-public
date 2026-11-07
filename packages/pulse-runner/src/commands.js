import fs from 'node:fs';
import path from 'node:path';
import { MCP_TOOL_RULE, PROFILES, ROOT_HELPER, SHELL_SAFE_DIRS } from './profiles.js';
import { agentAuthEnv, safePath } from './paths.js';
import { findOnPath } from './sandbox.js';

/** Claude permission rule for an absolute path. */
const absRule = (tool, p) => `${tool}(/${p}/**)`;

export function jobDirs(paths, jobId) {
  const root = path.join(paths.jobsDir, jobId);
  return {
    root,
    work: path.join(root, 'work'),
    tmp: path.join(root, 'tmp'),
    home: path.join(root, 'home'),
    private: path.join(root, 'private'),
  };
}

/**
 * The environment is built from nothing rather than filtered, so nothing in the runner's
 * environment can reach a job by accident (including an ANTHROPIC_API_KEY, which would
 * bill an API account instead of the company's subscription).
 */
function baseEnv(job, dirs, pathValue) {
  return {
    PATH: safePath(pathValue),
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    PULSE_JOB_ID: job.id,
  };
}

function buildClaude(job, { paths, dirs, pathValue }) {
  const profile = PROFILES[job.profile];
  const mcpFile = path.join(dirs.private, 'mcp.json');
  const mcpConfig = { mcpServers: { pulse: { type: 'http', url: job.mcp.url, headers: { Authorization: `Bearer ${job.mcp.token}` } } } };

  // The sandbox is the real barrier. These rules also keep the agent's own file tools away
  // from the login state and the MCP token file, which must be mounted for the CLI to work.
  const hidden = [paths.configDir, paths.authDir, dirs.private];
  const denied = hidden.flatMap((p) => [absRule('Read', p), absRule('Edit', p)]);

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', profile.tools.join(','),
    '--allowedTools', [...profile.tools, MCP_TOOL_RULE].join(','),
    '--disallowedTools', denied.join(','),
    '--permission-mode', 'dontAsk',
    '--mcp-config', mcpFile,
    '--strict-mcp-config',
    '--max-budget-usd', String(job.limits.costCapUsd),
    '--no-session-persistence',
  ];
  if (job.model) args.push('--model', job.model);

  return {
    cmd: findOnPath('claude', safePath(pathValue)),
    name: 'claude',
    args,
    env: {
      ...baseEnv(job, dirs, pathValue),
      CLAUDE_CONFIG_DIR: agentAuthEnv(paths).CLAUDE_CONFIG_DIR,
      DISABLE_AUTOUPDATER: '1',
    },
    stdin: job.prompt,
    files: [{ path: mcpFile, content: `${JSON.stringify(mcpConfig)}\n` }],
    rwBinds: [paths.claudeConfigDir],
    costCapEnforced: true,
  };
}

function buildCodex(job, { paths, dirs, pathValue }) {
  const profile = PROFILES[job.profile];
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--cd', dirs.work,
    '--sandbox', profile.codexSandbox,
    '-c', 'approval_policy="never"',
    '-c', `mcp_servers.pulse.url=${JSON.stringify(job.mcp.url)}`,
    '-c', 'mcp_servers.pulse.bearer_token_env_var="PULSE_MCP_TOKEN"',
  ];
  if (job.model) args.push('--model', job.model);
  args.push('-');

  return {
    cmd: findOnPath('codex', safePath(pathValue)),
    name: 'codex',
    args,
    env: {
      ...baseEnv(job, dirs, pathValue),
      CODEX_HOME: agentAuthEnv(paths).CODEX_HOME,
      PULSE_MCP_TOKEN: job.mcp.token,
    },
    stdin: job.prompt,
    files: [],
    rwBinds: [paths.codexHome],
    costCapEnforced: false,
  };
}

function buildShellSafe(job, { dirs }) {
  const [name, ...args] = job.command;
  let cmd = null;
  for (const dir of SHELL_SAFE_DIRS) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      cmd = candidate;
      break;
    }
  }
  return {
    cmd,
    name,
    args,
    env: { ...baseEnv(job, dirs, '/usr/bin:/bin') },
    stdin: null,
    files: [],
    rwBinds: [],
    costCapEnforced: true,
  };
}

/** AI-EMPLOYEE-POWER: a direct shell job. In the sandbox: bash -c with a read-only view of the server (hostView); as root:
 *  the root helper through sudo -n, the command line on stdin and the time limit as its argument (it kills the command
 *  itself, since the runner's user cannot signal a root process). */
function buildShell(job, { dirs, pathValue, config }) {
  const line = job.command[0];
  const env = { ...baseEnv(job, dirs, pathValue || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin') };
  if (job.profile === 'root') {
    const helper = config?.rootHelper ?? ROOT_HELPER;
    return {
      cmd: findOnPath('sudo', '/usr/bin:/bin'),
      name: 'sudo',
      args: ['-n', helper, String(Math.max(1, Math.min(1800, Number(job.limits?.timeLimitSec) || 600))), job.id],
      env,
      stdin: line,
      files: [],
      rwBinds: [],
      costCapEnforced: true,
      root: true,
    };
  }
  return {
    cmd: '/bin/bash',
    name: 'bash',
    args: ['-c', line],
    env,
    stdin: null,
    files: [],
    rwBinds: [],
    costCapEnforced: true,
    hostView: true,
  };
}

export function buildCommand(job, context) {
  if (job.kind === 'claude') return buildClaude(job, context);
  if (job.kind === 'codex') return buildCodex(job, context);
  if (job.kind === 'shell') return buildShell(job, context);
  return buildShellSafe(job, context);
}
