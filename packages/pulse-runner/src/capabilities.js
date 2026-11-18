import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { agentAuthEnv, safePath } from './paths.js';
import { findOnPath } from './sandbox.js';
import { VERSION } from './version.js';
import { ROOT_HELPER } from './profiles.js';

const VERSION_RE = /\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.-]+)?/;

function run(cmd, args, env, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function toolVersion(name, env) {
  const cmd = findOnPath(name, env.PATH);
  if (!cmd) return null;
  const { ok, stdout, stderr } = await run(cmd, ['--version'], env);
  if (!ok) return null;
  // Only the version number leaves this function, never the raw output.
  return (stdout || stderr).match(VERSION_RE)?.[0] ?? null;
}

/** Only these fields of `claude auth status` are reported. Emails and org IDs are dropped. */
const CLAUDE_METHOD_RE = /^[A-Za-z0-9._-]{1,40}$/;

async function detectClaude(env) {
  const cmd = findOnPath('claude', env.PATH);
  if (!cmd) return { installed: false, version: null, loggedIn: false };
  const version = await toolVersion('claude', env);
  const { ok, stdout } = await run(cmd, ['auth', 'status'], env);
  let loggedIn = ok;
  let authMethod;
  let subscriptionType;
  try {
    const status = JSON.parse(stdout);
    if (typeof status.loggedIn === 'boolean') loggedIn = status.loggedIn;
    if (CLAUDE_METHOD_RE.test(status.authMethod ?? '')) authMethod = status.authMethod;
    if (CLAUDE_METHOD_RE.test(status.subscriptionType ?? '')) subscriptionType = status.subscriptionType;
  } catch {
    // Older versions print text. The exit code is then all that is used.
  }
  return { installed: true, version, loggedIn, ...(authMethod ? { authMethod } : {}), ...(subscriptionType ? { subscriptionType } : {}) };
}

async function detectCodex(env) {
  const cmd = findOnPath('codex', env.PATH);
  if (!cmd) return { installed: false, version: null, loggedIn: false };
  const version = await toolVersion('codex', env);
  const { ok, stdout, stderr } = await run(cmd, ['login', 'status'], env);
  // "Logged in using ChatGPT" / "… an API key": only which kind of sign-in, never the account.
  const said = `${stdout}\n${stderr}`;
  const authMethod = !ok ? null : /chatgpt/i.test(said) ? 'chatgpt' : /api key/i.test(said) ? 'api-key' : null;
  return { installed: true, version, loggedIn: ok, ...(authMethod ? { authMethod } : {}) };
}

function diskStats(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return { totalBytes: stat.blocks * stat.bsize, freeBytes: stat.bavail * stat.bsize };
  } catch {
    return { totalBytes: null, freeBytes: null };
  }
}

function rootHelperPresent(config) {
  try { return fs.statSync(config.rootHelper ?? ROOT_HELPER).isFile(); } catch { return false; }
}

/** Builds the capability report. Its shape is an allow-list: nothing else is ever sent. */
export async function collectCapabilities({ paths, config, isolationStatus, pathValue = process.env.PATH ?? '' }) {
  const env = { PATH: safePath(pathValue), HOME: os.homedir(), LANG: 'C.UTF-8', NO_COLOR: '1', ...agentAuthEnv(paths) };
  const [claude, codex, python, git, docker] = await Promise.all([
    detectClaude(env),
    detectCodex(env),
    toolVersion('python3', env),
    toolVersion('git', env),
    toolVersion('docker', env),
  ]);
  const cpus = os.cpus();
  return {
    runnerVersion: VERSION,
    reportedAt: new Date().toISOString(),
    system: {
      os: process.platform,
      arch: process.arch,
      cpu: { model: cpus[0]?.model ?? null, cores: cpus.length, loadAvg1: os.loadavg()[0] },
      ram: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
      disk: diskStats(paths.stateDir),
    },
    ai: { claude, codex },
    tools: { node: process.versions.node, python, git, docker },
    isolation: isolationStatus,
    limits: { maxConcurrent: config.maxConcurrent, maxProfile: config.maxProfile, allowNoSandbox: config.allowNoSandbox === true },
    // AI-EMPLOYEE-POWER: direct shell jobs (whenever jobs can run here) and root jobs (allowRoot and the helper present).
    shell: { direct: isolationStatus?.verified === true || isolationStatus?.mode === 'none', root: config.allowRoot === true && rootHelperPresent(config) },
  };
}
