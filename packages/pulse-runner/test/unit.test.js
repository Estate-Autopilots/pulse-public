import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTmp, installFakes, fakePath } from './helpers.js';
import { makeJob } from './mock-pulse.js';
import { pathsFor, resolvePaths, safePath } from '../src/paths.js';
import { DEFAULT_CONFIG, ensureStateDirs, loadCredential, saveConfig, loadConfig, saveCredential } from '../src/store.js';
import { Redactor } from '../src/redact.js';
import { PulseError, assertSafeApiUrl } from '../src/http.js';
import { JobRejected, validateJob, validateOutputPath } from '../src/job-validate.js';
import { profileWithinCeiling } from '../src/profiles.js';
import { buildCommand, jobDirs } from '../src/commands.js';
import { Isolation, buildBwrapArgs, programBinds } from '../src/sandbox.js';
import { OutputRefused, readOutput } from '../src/outputs.js';
import { parseAgentLine } from '../src/usage.js';
import { collectCapabilities } from '../src/capabilities.js';
import { checkNodePath, describeStep, executePlan, installPlan, renderUnit, uninstallPlan } from '../src/service.js';

const context = { config: DEFAULT_CONFIG, orgId: 'org_test' };
const rejects = (job, code, ctx = context) => assert.throws(() => validateJob(job, ctx), (err) => err instanceof JobRejected && err.code === code);
const approval = { approvedBy: { id: 'usr_1', name: 'Admin' }, approvedAt: '2026-11-05T10:00:00Z' };

test('paths: PULSE_RUNNER_HOME wins, root uses the service home, users use their own', () => {
  assert.equal(resolvePaths({ env: { PULSE_RUNNER_HOME: '/x/y' }, uid: 1000, home: '/h' }).stateDir, '/x/y');
  assert.equal(resolvePaths({ env: {}, uid: 0, home: '/root' }).stateDir, '/var/lib/pulse-runner');
  assert.equal(resolvePaths({ env: {}, uid: 1000, home: '/h' }).stateDir, '/h/.pulse-runner');
});

test('safePath removes empty and relative entries', () => {
  assert.equal(safePath('/usr/bin::.:bin:/bin'), '/usr/bin:/bin');
});

test('credential is written 0600 and refused if others can read it', (t) => {
  const paths = pathsFor(path.join(makeTmp(t), 'state'));
  ensureStateDirs(paths);
  saveCredential(paths, { runnerId: 'r', orgId: 'o', credential: 'prc_x' });
  assert.equal(fs.statSync(paths.credentialFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.configDir).mode & 0o777, 0o700);
  assert.equal(loadCredential(paths).credential, 'prc_x');
  fs.chmodSync(paths.credentialFile, 0o644);
  assert.throws(() => loadCredential(paths), /mode 0600/);
});

test('config saves only non-default values, and never holds the credential', (t) => {
  const paths = pathsFor(path.join(makeTmp(t), 'state'));
  ensureStateDirs(paths);
  saveConfig(paths, { ...DEFAULT_CONFIG, maxConcurrent: 7 });
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.configFile, 'utf8')), { maxConcurrent: 7 });
  assert.equal(loadConfig(paths).maxConcurrent, 7);
  assert.equal(loadConfig(paths).isolation, 'bwrap');
});

test('isolation defaults to on', () => {
  assert.equal(DEFAULT_CONFIG.isolation, 'bwrap');
});

test('redactor masks known secrets, prefixes and bearer tokens, deeply', () => {
  const r = new Redactor(['supersecretvalue']);
  assert.equal(r.string('a supersecretvalue b'), 'a [REDACTED] b');
  assert.equal(r.string('token prc_abc-123 here'), 'token [REDACTED] here');
  assert.equal(r.string('pmt_zzz'), '[REDACTED]');
  assert.equal(r.string('Authorization: Bearer abc.def'), 'Authorization: Bearer [REDACTED]');
  assert.deepEqual(r.deep({ a: ['supersecretvalue', 1, null], b: { c: 'prc_q' } }), { a: ['[REDACTED]', 1, null], b: { c: '[REDACTED]' } });
});

test('API URL must be https, or http only to loopback', () => {
  assert.equal(assertSafeApiUrl('https://api.vitalsos.ai/x'), 'https://api.vitalsos.ai');
  assert.equal(assertSafeApiUrl('http://127.0.0.1:9'), 'http://127.0.0.1:9');
  assert.throws(() => assertSafeApiUrl('http://api.vitalsos.ai'), /https/);
  assert.throws(() => assertSafeApiUrl('http://localhost.evil.example'), /https/);
  assert.throws(() => assertSafeApiUrl('nonsense'), /Invalid/);
});

test('only 401 runner_revoked counts as a revocation', () => {
  assert.equal(new PulseError('x', { status: 401, code: 'runner_revoked' }).revoked, true);
  assert.equal(new PulseError('x', { status: 401, code: 'invalid_credential' }).revoked, false);
  assert.equal(new PulseError('x', { status: 403, code: 'runner_revoked' }).revoked, false);
  assert.equal(new PulseError('x', { status: 502, code: 'http_502' }).retryable, true);
  assert.equal(new PulseError('x', { status: 400, code: 'invalid_request' }).retryable, false);
});

test('validation accepts a good job and defaults to read-only', () => {
  const { profile, dryRun, approval: a } = validateJob(makeJob({ profile: undefined }), context);
  assert.deepEqual([profile, dryRun, a], ['read-only', false, null]);
});

test('validation rejects bad jobs with the documented codes', () => {
  rejects(makeJob({ id: '../../etc' }), 'invalid_job');
  rejects(makeJob({ orgId: 'org_other' }), 'org_mismatch');
  rejects(makeJob({ kind: 'bash' }), 'invalid_job');
  rejects(makeJob({ prompt: '   ' }), 'invalid_job');
  rejects(makeJob({ prompt: 'x'.repeat(1024 * 1024 + 1) }), 'invalid_job');
  rejects(makeJob({ profile: 'god-mode' }), 'invalid_job');
  rejects(makeJob({ limits: { costCapUsd: 1 } }), 'invalid_job');
  rejects(makeJob({ limits: { timeLimitSec: 999999, costCapUsd: 1 } }), 'invalid_job');
  rejects(makeJob({ limits: { timeLimitSec: 5 } }), 'invalid_job');
  rejects(makeJob({ limits: { timeLimitSec: 5, costCapUsd: -1 } }), 'invalid_job');
  rejects(makeJob({ requestedBy: undefined }), 'invalid_job');
  rejects(makeJob({ model: '--dangerously-skip-permissions x' }), 'invalid_job');
  rejects(makeJob({ command: ['df'] }), 'invalid_job');
  rejects(makeJob({ outputs: [{ path: '../secret' }] }), 'invalid_job');
});

test('write and shell need approval, and respect the local ceiling', () => {
  rejects(makeJob({ profile: 'write' }), 'approval_required');
  rejects(makeJob({ profile: 'shell', approval: {} }), 'approval_required');
  assert.equal(validateJob(makeJob({ profile: 'shell', approval }), context).profile, 'shell');
  const capped = { ...context, config: { ...DEFAULT_CONFIG, maxProfile: 'read-only' } };
  rejects(makeJob({ profile: 'write', approval }), 'profile_not_allowed', capped);
  assert.equal(profileWithinCeiling('read-only', 'unknown-value'), true);
  assert.equal(profileWithinCeiling('shell', 'unknown-value'), false);
});

test('MCP block must be present, unexpired and point at the configured server', () => {
  rejects(makeJob({ mcp: undefined }), 'mcp_invalid');
  const good = makeJob().mcp;
  rejects(makeJob({ mcp: { ...good, url: 'https://evil.example/mcp' } }), 'mcp_invalid');
  rejects(makeJob({ mcp: { ...good, expiresAt: '2020-01-01T00:00:00Z' } }), 'mcp_invalid');
});

test('shell-safe allows only listed commands, as argv', () => {
  const shell = (command) => makeJob({ kind: 'shell-safe', prompt: undefined, mcp: undefined, limits: { timeLimitSec: 5 }, command });
  assert.equal(validateJob(shell(['df', '-h']), context).kind, 'shell-safe');
  rejects(shell(['bash', '-c', 'id']), 'command_not_allowed');
  rejects(shell(['/bin/sh']), 'command_not_allowed');
  rejects(shell(['cat', '/etc/passwd']), 'command_not_allowed');
  rejects(shell([]), 'invalid_job');
  rejects(shell('df -h'), 'invalid_job');
});

test('output paths must stay inside the workdir', () => {
  for (const good of ['a.txt', 'out/report.md', 'a/b/c..d']) assert.equal(validateOutputPath(good), true, good);
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../b', 'a//b', './a', 'a\\b', 'a\0b', null]) assert.equal(validateOutputPath(bad), false, String(bad));
});

function commandFor(t, overrides) {
  const dir = makeTmp(t);
  const bin = path.join(dir, 'bin');
  installFakes(bin);
  const paths = pathsFor(path.join(dir, 'state'));
  const job = validateJob(makeJob(overrides), context);
  return { job, paths, plan: buildCommand(job, { paths, dirs: jobDirs(paths, job.id), pathValue: fakePath(bin) }) };
}

const flag = (args, name) => args[args.indexOf(name) + 1];

test('claude read-only: headless, read-only tools plus Pulse MCP, nothing secret in argv', (t) => {
  const { job, plan, paths } = commandFor(t, { prompt: 'PROMPT-TEXT' });
  const { args } = plan;
  assert.ok(args.includes('-p'));
  assert.equal(flag(args, '--output-format'), 'stream-json');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(flag(args, '--tools'), 'Read,Glob,Grep');
  assert.equal(flag(args, '--allowedTools'), 'Read,Glob,Grep,mcp__pulse');
  assert.equal(flag(args, '--permission-mode'), 'dontAsk');
  assert.equal(flag(args, '--max-budget-usd'), '1');
  assert.ok(flag(args, '--disallowedTools').includes(`Read(/${paths.configDir}/**)`));
  const joined = args.join(' ');
  assert.ok(!joined.includes('PROMPT-TEXT'), 'prompt goes on stdin');
  assert.ok(!joined.includes(job.mcp.token), 'token goes in a private file');
  assert.equal(plan.stdin, 'PROMPT-TEXT');
  assert.equal(JSON.parse(plan.files[0].content).mcpServers.pulse.headers.Authorization, `Bearer ${job.mcp.token}`);
  assert.ok(plan.files[0].path.includes(`${path.sep}private${path.sep}`));
});

test('claude tools grow only with the profile', (t) => {
  assert.ok(!flag(commandFor(t, { profile: 'write', approval }).plan.args, '--tools').includes('Bash'));
  assert.ok(flag(commandFor(t, { profile: 'write', approval }).plan.args, '--tools').includes('Edit'));
  assert.ok(flag(commandFor(t, { profile: 'shell', approval }).plan.args, '--tools').includes('Bash'));
});

test('job environment is built from nothing and never holds an API key or credential path', (t) => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-pass';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  const { plan } = commandFor(t, {});
  assert.deepEqual(Object.keys(plan.env).sort(), ['CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'PULSE_JOB_ID', 'TMPDIR']);
  assert.ok(!JSON.stringify(plan.env).includes('credential'));
});

test('codex: json, sandbox from the profile, token by env var, cost cap flagged as unenforced', (t) => {
  const { job, plan } = commandFor(t, { kind: 'codex' });
  assert.deepEqual(plan.args.slice(0, 2), ['exec', '--json']);
  assert.equal(flag(plan.args, '--sandbox'), 'read-only');
  assert.equal(plan.args.at(-1), '-');
  assert.ok(!plan.args.join(' ').includes(job.mcp.token));
  assert.equal(plan.env.PULSE_MCP_TOKEN, job.mcp.token);
  assert.equal(plan.costCapEnforced, false);
  assert.equal(flag(commandFor(t, { kind: 'codex', profile: 'shell', approval }).plan.args, '--sandbox'), 'workspace-write');
});

test('bubblewrap: the job sees no runner state beyond its own directories', () => {
  const paths = pathsFor('/var/lib/pulse-runner');
  const dirs = jobDirs(paths, 'job1');
  const args = buildBwrapArgs({ cwd: dirs.work, jobDir: dirs.root, privateDir: dirs.private, rwBinds: [paths.claudeConfigDir] });
  for (const required of ['--die-with-parent', '--unshare-pid', '--unshare-user', '--new-session']) assert.ok(args.includes(required), required);
  // The root is bwrap's empty tmpfs, so only what is bound exists. "/" must never be bound.
  const bound = [];
  args.forEach((arg, i) => { if (/^--(ro-)?bind(-try)?$/.test(arg)) bound.push(args[i + 2]); });
  for (const target of bound) {
    assert.notEqual(target, '/');
    assert.ok(!paths.configFile.startsWith(`${target}/`), `${target} would expose the config directory`);
    assert.ok(!paths.credentialFile.startsWith(`${target}/`), `${target} would expose the credential`);
    assert.ok(!target.startsWith('/home'), target);
  }
  assert.ok(bound.includes(dirs.root));
  assert.ok(!bound.includes('/etc'), 'only named /etc entries are visible');
  assert.ok(!bound.includes('/var'), 'other applications\' data is not visible');
  assert.ok(!bound.includes('/opt'));
});

test('sandbox refuses a program directory that overlaps the runner state', (t) => {
  const dir = makeTmp(t);
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(dir, 'tool'), '');
  assert.throws(() => programBinds(path.join(dir, 'tool'), pathsFor(state)), /overlaps/);
});

test('isolation fails closed: no bwrap means no jobs', async (t) => {
  const paths = pathsFor(path.join(makeTmp(t), 'state'));
  ensureStateDirs(paths);
  const isolation = new Isolation({ mode: 'bwrap', paths, pathValue: '/nonexistent' });
  assert.equal(isolation.canRunJobs, false, 'not proven before the probe');
  const status = await isolation.probe();
  assert.deepEqual([status.available, status.verified], [false, false]);
  assert.equal(isolation.canRunJobs, false);
});

test('isolation fails closed: a sandbox that exposes the credential is refused', async (t) => {
  const dir = makeTmp(t);
  const bin = path.join(dir, 'bin');
  installFakes(bin, { bwrap: true });
  const paths = pathsFor(path.join(dir, 'state'));
  ensureStateDirs(paths);
  const isolation = new Isolation({ mode: 'bwrap', paths, pathValue: fakePath(bin) });
  const status = await isolation.probe();
  assert.equal(status.verified, false);
  assert.match(status.reason, /could see the credential/);
  assert.equal(isolation.canRunJobs, false);
});

test('isolation fails closed: an unknown mode in the config is refused', async (t) => {
  const paths = pathsFor(path.join(makeTmp(t), 'state'));
  ensureStateDirs(paths);
  const isolation = new Isolation({ mode: 'off-please', paths });
  await isolation.probe();
  assert.equal(isolation.canRunJobs, false);
});

function outputDir(t) {
  const dir = makeTmp(t);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(dir, 'credential.json'), 'SECRET');
  return { dir, work };
}
const refused = (fn, code) => assert.throws(fn, (err) => err instanceof OutputRefused && err.code === code);

test('outputs: a regular file is read with its hash', (t) => {
  const { work } = outputDir(t);
  fs.mkdirSync(path.join(work, 'out'));
  fs.writeFileSync(path.join(work, 'out/a.txt'), 'hello');
  const { bytes, sha256 } = readOutput(work, 'out/a.txt', 100);
  assert.equal(bytes.toString(), 'hello');
  assert.equal(sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('outputs: a symlink to the credential is refused', (t) => {
  const { dir, work } = outputDir(t);
  fs.symlinkSync(path.join(dir, 'credential.json'), path.join(work, 'leak'));
  refused(() => readOutput(work, 'leak', 100), 'symlink');
});

test('outputs: a symlinked parent directory is refused', (t) => {
  const { dir, work } = outputDir(t);
  fs.symlinkSync(dir, path.join(work, 'up'));
  refused(() => readOutput(work, 'up/credential.json', 100), 'symlink');
});

test('outputs: a hard link to the credential is refused', (t) => {
  const { dir, work } = outputDir(t);
  fs.linkSync(path.join(dir, 'credential.json'), path.join(work, 'leak'));
  refused(() => readOutput(work, 'leak', 100), 'hard_link');
});

test('outputs: a FIFO is refused without hanging', (t) => {
  const { work } = outputDir(t);
  execFileSync('mkfifo', [path.join(work, 'pipe')]);
  refused(() => readOutput(work, 'pipe', 100), 'not_regular');
});

test('outputs: too large and missing files are refused', (t) => {
  const { work } = outputDir(t);
  fs.writeFileSync(path.join(work, 'big'), 'x'.repeat(101));
  refused(() => readOutput(work, 'big', 100), 'too_large');
  refused(() => readOutput(work, 'nope', 100), 'missing');
  refused(() => readOutput(work, '../credential.json', 100), 'outside');
});

test('usage is read from Claude and Codex output', () => {
  const claude = parseAgentLine('claude', { type: 'result', subtype: 'success', total_cost_usd: 0.5, num_turns: 2, usage: { input_tokens: 1, output_tokens: 2 } });
  assert.equal(claude.usage.costUsd, 0.5);
  assert.equal(claude.usage.inputTokens, 1);
  assert.equal(claude.budgetExceeded, false);
  assert.equal(parseAgentLine('claude', { type: 'result', subtype: 'error_max_budget_usd' }).budgetExceeded, true);
  assert.deepEqual(parseAgentLine('claude', { type: 'rate_limit_event', rate_limit_info: { a: 1 } }).limits, { a: 1 });
  assert.deepEqual(parseAgentLine('claude', { type: 'assistant' }), {});
  const one = parseAgentLine('codex', { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }).usage;
  const two = parseAgentLine('codex', { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } }, one).usage;
  assert.deepEqual([two.inputTokens, two.outputTokens, two.numTurns, two.costUsd], [4, 6, 2, null]);
  assert.equal(parseAgentLine('codex', { type: 'turn.failed' }).isError, true);
});

test('capabilities report no emails, ids, paths or raw CLI output', async (t) => {
  const dir = makeTmp(t);
  const bin = path.join(dir, 'bin');
  installFakes(bin);
  const paths = pathsFor(path.join(dir, 'state'));
  ensureStateDirs(paths);
  const report = await collectCapabilities({
    paths, config: DEFAULT_CONFIG, isolationStatus: { mode: 'bwrap', available: false, verified: false, reason: 'x' }, pathValue: fakePath(bin),
  });
  assert.deepEqual(report.ai.claude, { installed: true, version: '2.9.9', loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
  assert.deepEqual(report.ai.codex, { installed: true, version: '0.50.1', loggedIn: true });
  assert.ok(report.system.cpu.cores > 0);
  assert.ok(report.system.ram.totalBytes > 0);
  assert.ok(report.system.disk.totalBytes > 0);
  const text = JSON.stringify(report);
  assert.ok(!text.includes('secret-person'));
  assert.ok(!text.includes('SECRET-ORG-ID'));
  assert.ok(!text.includes(dir), 'no local paths');
});

test('capabilities report a missing CLI as not installed', async (t) => {
  const paths = pathsFor(path.join(makeTmp(t), 'state'));
  ensureStateDirs(paths);
  const report = await collectCapabilities({ paths, config: DEFAULT_CONFIG, isolationStatus: {}, pathValue: '/nonexistent' });
  assert.deepEqual(report.ai.claude, { installed: false, version: null, loggedIn: false });
  assert.equal(report.tools.git, null);
});

test('systemd unit: dedicated user, restart, log limits, no restart after revoke', () => {
  const unit = renderUnit({ nodePath: '/usr/local/bin/node' });
  for (const line of [
    'User=pulse-runner', 'Restart=always', 'RestartPreventExitStatus=78', 'LogRateLimitBurst=2000',
    'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'ReadWritePaths=/var/lib/pulse-runner',
    'ExecStart=/usr/local/bin/node /opt/pulse-runner/bin/pulse-runner.js run',
  ]) assert.ok(unit.includes(`${line}\n`), line);
  // Any of these would stop bubblewrap mounting /proc or creating namespaces.
  for (const setting of ['ProtectKernelTunables=', 'ProtectKernelLogs=', 'ProtectProc=', 'RestrictNamespaces=', 'PrivateUsers=']) {
    assert.ok(!unit.includes(`\n${setting}`), setting);
  }
});

test('install plan creates the user, unit and directories, without running anything', () => {
  const steps = installPlan({ nodePath: '/usr/local/bin/node' });
  const described = steps.map(describeStep).join('\n');
  assert.match(described, /useradd --system .* pulse-runner/);
  assert.match(described, /write \/etc\/systemd\/system\/pulse-runner\.service/);
  assert.match(described, /systemctl enable --now pulse-runner\.service/);
  assert.ok(!installPlan({ nodePath: '/usr/local/bin/node', userExists: true }).map(describeStep).join('\n').includes('useradd'));
});

test('reinstalling from the installed copy does not delete the running program', () => {
  const steps = installPlan({ nodePath: '/usr/local/bin/node', packageRoot: '/opt/pulse-runner/' });
  assert.ok(!steps.some((s) => s.cmd === 'rm'));
  assert.ok(!steps.some((s) => s.type === 'copy-if-exists'));
  assert.ok(installPlan({ nodePath: '/usr/local/bin/node', packageRoot: '/tmp/npx/pkg' }).some((s) => s.cmd === 'rm'));
});

test('uninstall plan removes only known paths', () => {
  const steps = uninstallPlan();
  const removed = steps.filter((s) => s.cmd === 'rm').flatMap((s) => s.args.filter((a) => !a.startsWith('-')));
  assert.deepEqual(removed.sort(), ['/etc/systemd/system/pulse-runner.service', '/opt/pulse-runner', '/usr/local/bin/pulse-runner', '/var/lib/pulse-runner'].sort());
  assert.ok(steps.some((s) => s.cmd === 'userdel' && s.args[0] === 'pulse-runner'));
});

test('executePlan stops at a failed step unless failure is allowed', () => {
  const ran = [];
  const run = (cmd) => { ran.push(cmd); if (cmd === 'bad') throw new Error('boom'); };
  const step = (cmd, allowFailure) => ({ type: 'run', cmd, args: [], allowFailure });
  executePlan([step('bad', true), step('good')], { run });
  assert.deepEqual(ran, ['bad', 'good']);
  assert.throws(() => executePlan([step('bad'), step('never')], { run }), /Step failed/);
  assert.ok(!ran.includes('never'));
});

test('a node inside a home directory is refused for the service', () => {
  assert.throws(() => checkNodePath('/home/x/.nvm/node'), /system-wide/);
  assert.throws(() => checkNodePath('/root/node'), /system-wide/);
  assert.doesNotThrow(() => checkNodePath('/usr/local/bin/node'));
});

// RUNNERS-FULL: what a login's output gives Pulse (the link and device code only) and what a pasted code may be.
test('readLoginOutput finds the sign-in link and device code, and nothing else', async () => {
  const { readLoginOutput, cleanPastedCode } = await import('../src/login.js');
  const claude = "Opening browser to sign in…\nIf the browser didn't open, visit: \u001b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc\u0007https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc\u001b]8;;\u0007\nPaste code here if prompted > ";
  assert.deepEqual(readLoginOutput(claude), { url: 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc', userCode: null, needsCode: true });
  const codex = 'Follow these steps to sign in with ChatGPT using device code authorization:\n1. Open this link in your browser\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n2. Enter this one-time code\n   \u001b[94mABCD-12345\u001b[0m\n';
  assert.deepEqual(readLoginOutput(codex), { url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345', needsCode: false });
  assert.deepEqual(readLoginOutput('starting…'), { url: null, userCode: null, needsCode: false });
  assert.equal(readLoginOutput('see http://insecure.example/x').url, null, 'plain http is never a sign-in link');
  assert.equal(cleanPastedCode('  abc123#state  '), 'abc123#state');
  for (const bad of ['', 'ab', 'two words', 'a\nb', 'x'.repeat(600), 42]) assert.equal(cleanPastedCode(bad), null);
});

test('a job\'s access block is kept only in its known shape', () => {
  const config = { ...DEFAULT_CONFIG };
  const ok = validateJob(makeJob({ access: { level: 'read-write', sandbox: false } }), { config, orgId: 'org_test' });
  assert.deepEqual(ok.access, { level: 'read-write', sandbox: false });
  assert.equal(validateJob(makeJob({ access: { level: 'root', sandbox: false } }), { config, orgId: 'org_test' }).access, null);
  assert.equal(validateJob(makeJob(), { config, orgId: 'org_test' }).access, null);
  assert.equal(DEFAULT_CONFIG.allowNoSandbox, false);
});

test('a CLI reached through a symlink runs in the sandbox by its real path (only that folder is bound)', (t) => {
  const dir = makeTmp(t);
  const bin = path.join(dir, 'bin');
  installFakes(bin, { bwrap: true });
  const links = path.join(dir, 'links');
  fs.mkdirSync(links);
  fs.symlinkSync(path.join(bin, 'claude'), path.join(links, 'claude'));
  const isolation = new Isolation({ mode: 'bwrap', paths: pathsFor(path.join(dir, 'state')), pathValue: fakePath(bin) });
  const wrapped = isolation.wrap({ cmd: path.join(links, 'claude'), args: ['-p'], cwd: dir, jobDir: dir });
  const after = wrapped.args.slice(wrapped.args.indexOf('--') + 1);
  assert.deepEqual(after, [fs.realpathSync(path.join(bin, 'claude')), '-p']);
  assert.ok(wrapped.args.includes(fs.realpathSync(bin)), 'the real folder is bound read-only');
});
