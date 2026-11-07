import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BIN = path.join(ROOT, 'bin', 'pulse-runner.js');
const TMP_ROOT = path.join(ROOT, '.test-tmp');

/** Temp directories stay inside the project, so tests touch nothing outside it. */
export function makeTmp(t) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  // The fake CLIs are extensionless CommonJS, and must not inherit this package's type: module.
  fs.writeFileSync(path.join(TMP_ROOT, 'package.json'), '{"type":"commonjs"}\n');
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 't-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
// Stands in for Claude Code. Its behaviour is chosen by a keyword in the prompt.
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'secret-person@example.com', orgId: 'SECRET-ORG-ID' }));
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'logout') { fs.writeFileSync(require('path').join(__dirname, 'logged-out'), ''); process.exit(0); }
// With a "login-flow" file beside it, login behaves as Claude Code does without a browser: a link, then a pasted code.
if (args[0] === 'auth' && args[1] === 'login' && fs.existsSync(require('path').join(__dirname, 'login-flow'))) {
  const link = 'https://claude.example/cai/oauth/authorize?code=true&state=s1';
  console.log('Opening browser to sign in');
  console.log("If the browser didn't open, visit: \u001b]8;;" + link + '\u0007' + link + '\u001b]8;;\u0007');
  process.stdout.write('Paste code here if prompted > ');
  let got = '';
  process.stdin.on('data', (d) => {
    got += d;
    if (!got.includes('\n')) return;
    fs.writeFileSync(require('path').join(__dirname, 'login-env'), JSON.stringify(Object.keys(process.env)));
    process.exit(got.trim() === 'GOOD-CODE#s1' ? 0 : 1);
  });
  return;
}
if (args[0] === 'auth' && args[1] === 'login') { console.log('LOGIN_RAN ' + (process.env.CLAUDE_CONFIG_DIR || '')); process.exit(0); }

let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  const say = (o) => console.log(JSON.stringify(o));
  say({ type: 'system', subtype: 'init', tools: [] });
  fs.writeFileSync('invocation.json', JSON.stringify({ args, prompt, envNames: Object.keys(process.env), env: process.env, cwd: process.cwd() }));
  if (prompt.includes('MARKER')) fs.writeFileSync(process.env.TMPDIR + '/../../../ran-' + process.env.PULSE_JOB_ID, 'x');
  if (prompt.includes('BLOCK') || prompt.includes('STUBBORN')) {
    if (prompt.includes('STUBBORN')) process.on('SIGTERM', () => {});
    say({ type: 'assistant', message: { content: 'working' } });
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('OUTPUTS')) {
    fs.mkdirSync('out', { recursive: true });
    fs.writeFileSync('out/report.md', '# Report\n');
  }
  // cwd is <state>/jobs/<id>/work, so this reaches the runner's real credential when nothing isolates the job.
  if (prompt.includes('SYMLINK')) fs.symlinkSync(require('path').resolve('../../../config/credential.json'), 'leak.txt');
  if (prompt.includes('HARDLINK')) fs.linkSync('../../../config/credential.json', 'leak.txt');
  if (prompt.includes('SECRET_ECHO')) console.log('stderr-free line with Bearer abc123def456');
  if (prompt.includes('STDERR')) console.error('a warning from the cli');
  if (prompt.includes('OVERBUDGET')) {
    say({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 9, usage: {}, num_turns: 1 });
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('EXIT3')) process.exit(3);
  say({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 123 } });
  say({ type: 'result', subtype: 'success', is_error: prompt.includes('AGENTERROR'), total_cost_usd: 0.25, num_turns: 2, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } });
});
`;

const FAKE_CODEX = String.raw`#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.50.1'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') process.exit(process.env.FAKE_CODEX_LOGGED_OUT ? 1 : 0);
if (args[0] === 'login') { console.log('CODEX_LOGIN_RAN'); process.exit(0); }
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  fs.writeFileSync('invocation.json', JSON.stringify({ args, prompt, env: process.env }));
  console.log(JSON.stringify({ type: 'thread.started' }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 6 } }));
});
`;

/**
 * A stand-in for bwrap that runs the program after "--" with NO real isolation.
 * With a "hides" file beside it, it answers the self-test as a working sandbox would.
 * This only tests the wiring. test/sandbox-real.test.js tests the real thing.
 */
const FAKE_BWRAP = String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const at = args.indexOf('--');
fs.appendFileSync(path.join(__dirname, 'bwrap-calls.log'), JSON.stringify(args) + '\n');
const program = args.slice(at + 1);
if (program.includes('pulse-probe') && fs.existsSync(path.join(__dirname, 'hides'))) { console.log('PROBE_OK'); process.exit(0); }
const r = spawnSync(program[0], program.slice(1), { stdio: 'inherit' });
process.exit(r.status ?? 1);
`;

export function installFakes(binDir, { claude = true, codex = true, bwrap = false, bwrapHides = false, loginFlow = false } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  // An absolute shebang, because the fakes also run under minimal PATHs.
  const write = (name, content) => fs.writeFileSync(path.join(binDir, name), content.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
  if (claude) write('claude', FAKE_CLAUDE);
  if (codex) write('codex', FAKE_CODEX);
  if (bwrap) write('bwrap', FAKE_BWRAP);
  if (bwrapHides) fs.writeFileSync(path.join(binDir, 'hides'), '');
  if (loginFlow) fs.writeFileSync(path.join(binDir, 'login-flow'), '');
}

/** PATH with the fakes first, then only the directories holding node and core utilities. */
export function fakePath(binDir) {
  return [binDir, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
}

export function runCli(args, { home, pathValue, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: pathValue ?? fakePath('/nonexistent'), PULSE_RUNNER_HOME: home, HOME: home, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export function startDaemon({ home, pathValue, env = {} }) {
  const child = spawn(process.execPath, [BIN, 'run'], {
    env: { PATH: pathValue, PULSE_RUNNER_HOME: home, HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.on('data', (d) => { output.text += d; });
  child.stderr.on('data', (d) => { output.text += d; });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, output, exited };
}

/** Writes local settings as an admin would, with fast timings for tests. */
export function writeTestConfig(home, overrides = {}) {
  const file = path.join(home, 'config', 'config.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({
    ...current,
    isolation: 'none',
    pollWaitSec: 1,
    pollMinMs: 20,
    heartbeatSec: 1,
    graceSec: 1,
    ...overrides,
  }));
}
