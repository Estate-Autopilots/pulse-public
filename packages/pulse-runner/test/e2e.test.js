import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MockPulse, makeJob } from './mock-pulse.js';
import { fakePath, installFakes, makeTmp, runCli, startDaemon, writeTestConfig } from './helpers.js';

const approval = { approvedBy: { id: 'usr_1', name: 'Admin' }, approvedAt: '2026-11-05T10:00:00Z' };

/** Fresh server, state directory and paired runner. Each test gets its own. */
async function setup(t, { config = {}, fakes = {}, start = true } = {}) {
  const mock = await new MockPulse().start();
  t.after(() => mock.stop());
  const dir = makeTmp(t);
  const home = path.join(dir, 'state');
  const bin = path.join(dir, 'bin');
  installFakes(bin, fakes);
  const pathValue = fakePath(bin);
  const code = mock.issueCode();
  const paired = await runCli(['connect', '--code', code, '--api-url', mock.url], { home, pathValue });
  assert.equal(paired.code, 0, paired.stderr);
  writeTestConfig(home, config);
  const context = { mock, home, bin, pathValue, paired };
  if (start) {
    context.daemon = startDaemon({ home, pathValue });
    t.after(async () => {
      context.daemon.child.kill('SIGKILL');
      await context.daemon.exited;
    });
    await mock.waitFor(() => mock.polls.length > 0, { label: 'first poll' });
  }
  return context;
}

const invocationOutput = [{ path: 'invocation.json', required: true }];
const uploaded = (mock, id, file = 'invocation.json') => JSON.parse(mock.uploads.get(id).get(file).toString());
const eventTypes = (mock, id) => mock.eventsOf(id).map((e) => e.type);
const leftovers = (home) => fs.readdirSync(path.join(home, 'jobs')).filter((name) => !name.startsWith('.probe'));

describe('pairing', () => {
  test('a good code stores a 0600 credential and never prints it', async (t) => {
    const { mock, home, paired } = await setup(t, { start: false });
    const file = path.join(home, 'config', 'credential.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, 'config')).mode & 0o777, 0o700);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).credential, mock.lastCredential);
    assert.ok(!paired.stdout.includes(mock.lastCredential));
    assert.ok(!paired.stderr.includes(mock.lastCredential));
    assert.match(paired.stdout, /Connected to Test Org as run_1/);
    assert.ok(!fs.readFileSync(path.join(home, 'config', 'config.json'), 'utf8').includes(mock.lastCredential));
  });

  test('bad, used and expired codes fail with a clear message', async (t) => {
    const mock = await new MockPulse().start();
    t.after(() => mock.stop());
    const home = path.join(makeTmp(t), 'state');
    const connect = (code) => runCli(['connect', '--code', code, '--api-url', mock.url], { home });

    const malformed = await connect('nope');
    assert.equal(malformed.code, 1);
    assert.match(malformed.stderr, /ABCD-1234/);
    assert.equal(mock.requests.length, 0, 'not sent to Pulse');

    assert.match((await connect('ZZZZ-9999')).stderr, /invalid_code/);
    mock.issueCode({ code: 'EXPI-RED1', expiresInMs: -1 });
    assert.match((await connect('EXPI-RED1')).stderr, /expired_code/);
    assert.ok(!fs.existsSync(path.join(home, 'config', 'credential.json')));

    mock.issueCode({ code: 'GOOD-CODE' });
    assert.equal((await connect('good-code')).code, 0, 'lower case is accepted');
    mock.issueCode({ code: 'NEXT-CODE' });
    const again = await connect('NEXT-CODE');
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already paired/);
  });

  test('plain http to a non-loopback API is refused before sending anything', async (t) => {
    const home = path.join(makeTmp(t), 'state');
    const result = await runCli(['connect', '--code', 'ABCD-1234', '--api-url', 'http://api.vitalsos.ai'], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /https/);
  });

  test('run without a pairing exits with the no-restart code', async (t) => {
    const home = path.join(makeTmp(t), 'state');
    assert.equal((await runCli(['run'], { home })).code, 78);
  });
});

describe('heartbeat and capabilities', () => {
  test('both are sent on start, and heartbeats repeat', async (t) => {
    const { mock, daemon } = await setup(t, { config: { maxConcurrent: 3 } });
    await mock.waitFor(() => mock.heartbeats.length >= 2, { label: 'second heartbeat' });
    const beat = mock.heartbeats[0];
    assert.equal(beat.status, 'ready');
    assert.equal(beat.maxConcurrent, 3);
    assert.deepEqual(beat.runningJobs, []);
    const [caps] = mock.capabilities;
    assert.equal(caps.ai.claude.loggedIn, true);
    assert.equal(caps.ai.claude.version, '2.9.9');
    assert.equal(caps.ai.codex.installed, true);
    assert.equal(caps.limits.maxConcurrent, 3);
    assert.equal(caps.isolation.mode, 'none');
    const sent = JSON.stringify(mock.capabilities);
    assert.ok(!sent.includes('secret-person'));
    assert.ok(!daemon.output.text.includes(mock.lastCredential));
  });

  test('capabilities repeat on their timer', async (t) => {
    const { mock } = await setup(t, { config: { capabilitiesSec: 1 } });
    await mock.waitFor(() => mock.capabilities.length >= 2, { label: 'second report' });
  });

  test('every call after pairing carries the credential', async (t) => {
    const { mock } = await setup(t);
    await mock.waitFor(() => mock.heartbeats.length >= 1);
    for (const request of mock.requests.filter((r) => r.route !== '/pair')) {
      assert.equal(request.authorization, `Bearer ${mock.lastCredential}`);
    }
  });

  test('report and status work, and status prints no secret', async (t) => {
    const { mock, home, pathValue } = await setup(t, { start: false });
    assert.equal((await runCli(['report'], { home, pathValue })).code, 0);
    assert.equal(mock.capabilities.length, 1);
    const status = await runCli(['status'], { home, pathValue });
    assert.equal(status.code, 0);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.paired, true);
    assert.equal(parsed.runnerId, 'run_1');
    assert.ok(!status.stdout.includes(mock.lastCredential));
  });
});

describe('login helpers', () => {
  test('login runs the official command with the runner\'s own config and reports to Pulse', async (t) => {
    const { mock, home, pathValue } = await setup(t, { start: false });
    const login = await runCli(['login', 'claude'], { home, pathValue });
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, new RegExp(`LOGIN_RAN ${home}/auth/claude`));
    assert.equal(mock.capabilities.at(-1).ai.claude.loggedIn, true);
    const codex = await runCli(['login', 'codex'], { home, pathValue });
    assert.match(codex.stdout, /CODEX_LOGIN_RAN/);
    assert.equal((await runCli(['login', 'nope'], { home, pathValue })).code, 2);
  });

  test('login explains a missing CLI', async (t) => {
    const { home, pathValue } = await setup(t, { start: false, fakes: { claude: false } });
    const result = await runCli(['login', 'claude'], { home, pathValue });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not installed/);
  });
});

describe('dry run', () => {
  test('plans without executing, and leaks neither prompt nor token', async (t) => {
    const { mock, home } = await setup(t);
    const job = makeJob({ dryRun: true, prompt: 'DRYPROMPT MARKER', outputs: invocationOutput });
    mock.enqueue(job);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.dryRun, true);
    assert.equal(mock.acks.includes(job.id), true);
    const plan = mock.eventsOf(job.id).find((e) => e.type === 'dry_run').data;
    assert.equal(plan.kind, 'claude');
    assert.equal(plan.profile, 'read-only');
    assert.equal(plan.binaryFound, true);
    assert.equal(plan.promptBytes, 16);
    assert.ok(plan.command.includes('--strict-mcp-config'));
    assert.ok(!mock.uploads.has(job.id), 'nothing ran, so nothing was uploaded');
    assert.ok(!fs.existsSync(path.join(home, `ran-${job.id}`)), 'the CLI was not started');
    const sent = JSON.stringify(mock.eventsOf(job.id)) + JSON.stringify(result);
    assert.ok(!sent.includes('DRYPROMPT'));
    assert.ok(!sent.includes(job.mcp.token));
  });

  test('reports a missing binary', async (t) => {
    const { mock } = await setup(t, { fakes: { claude: false } });
    const job = makeJob({ dryRun: true });
    mock.enqueue(job);
    await mock.waitForResult(job.id);
    assert.equal(mock.eventsOf(job.id).find((e) => e.type === 'dry_run').data.binaryFound, false);
  });
});

describe('claude jobs', () => {
  test('streams events and usage, uploads outputs, reports an audit record, cleans up', async (t) => {
    const { mock, home } = await setup(t);
    const job = makeJob({ prompt: 'OUTPUTS STDERR', outputs: [{ path: 'out/report.md', required: true }, { path: 'not-made.txt' }] });
    mock.enqueue(job);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    assert.equal(result.exitCode, 0);
    assert.equal(result.usage.costUsd, 0.25);
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.cacheWriteTokens, 4);
    assert.equal(result.usage.numTurns, 2);

    assert.equal(mock.uploads.get(job.id).get('out/report.md').toString(), '# Report\n');
    assert.deepEqual(result.outputs.map((o) => o.path), ['out/report.md']);
    assert.equal(result.outputs[0].outputId, 'out_1');

    const events = mock.eventsOf(job.id);
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), 'seq has no gaps');
    const types = eventTypes(mock, job.id);
    for (const type of ['status', 'agent', 'usage', 'limits', 'log']) assert.ok(types.includes(type), type);
    assert.ok(events.some((e) => e.type === 'log' && e.data.stream === 'stderr' && e.data.line.includes('a warning')));
    assert.deepEqual(events.find((e) => e.type === 'limits').data, { status: 'allowed', resetsAt: 123 });

    assert.deepEqual(result.audit.requestedBy, job.requestedBy);
    assert.equal(result.audit.kind, 'claude');
    assert.equal(result.audit.profile, 'read-only');
    assert.match(result.audit.promptSha256, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(result).includes('OUTPUTS STDERR'));

    assert.deepEqual(leftovers(home), [], 'the job directory is removed');
    const audit = fs.readFileSync(path.join(home, 'config', 'audit.log'), 'utf8');
    assert.match(audit, new RegExp(job.id));
    assert.ok(!audit.includes(job.mcp.token));
    assert.ok(!audit.includes('OUTPUTS STDERR'));
  });

  test('the job gets its prompt on stdin, a clean environment and an isolated workdir', async (t) => {
    const { mock, home, daemon } = await setup(t);
    const job = makeJob({ prompt: 'INSPECT', outputs: invocationOutput });
    mock.enqueue(job);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    const seen = uploaded(mock, job.id);
    assert.equal(seen.prompt, 'INSPECT');
    assert.ok(!seen.args.includes('INSPECT'));
    assert.equal(seen.cwd, path.join(home, 'jobs', job.id, 'work'));
    assert.equal(seen.env.CLAUDE_CONFIG_DIR, path.join(home, 'auth', 'claude'));
    const envText = JSON.stringify(seen.env);
    assert.ok(!envText.includes(mock.lastCredential), 'credential is not in the environment');
    assert.ok(!seen.envNames.includes('PULSE_RUNNER_HOME'), 'the state location is not advertised');
    assert.ok(!envText.includes('credential.json'));
    assert.ok(!seen.args.join(' ').includes(mock.lastCredential));
    assert.ok(!daemon.output.text.includes(mock.lastCredential));
    assert.ok(!daemon.output.text.includes(job.mcp.token));
  });

  test('the per-job MCP config points at Pulse with that job\'s token', async (t) => {
    const { mock } = await setup(t);
    const job = makeJob({ prompt: 'INSPECT', outputs: invocationOutput });
    mock.enqueue(job);
    await mock.waitForResult(job.id);
    const { args } = uploaded(mock, job.id);
    assert.equal(args[args.indexOf('--mcp-config') + 1].endsWith(`${job.id}/private/mcp.json`), true);
    assert.ok(args.join(' ').includes('mcp__pulse'));
    assert.ok(!args.join(' ').includes(job.mcp.token));
  });

  test('secret-shaped output is masked before it reaches Pulse', async (t) => {
    const { mock } = await setup(t);
    const job = makeJob({ prompt: 'SECRET_ECHO' });
    mock.enqueue(job);
    await mock.waitForResult(job.id);
    const sent = JSON.stringify(mock.eventsOf(job.id));
    assert.ok(!sent.includes('abc123def456'));
    assert.ok(sent.includes('Bearer [REDACTED]'));
  });

  test('symlink and hard-link outputs aimed at the real credential are not uploaded', async (t) => {
    const { mock } = await setup(t, { config: { maxConcurrent: 2 } });
    const links = [makeJob({ prompt: 'SYMLINK', outputs: [{ path: 'leak.txt', required: true }] }), makeJob({ prompt: 'HARDLINK', outputs: [{ path: 'leak.txt', required: true }] })];
    for (const job of links) mock.enqueue(job);
    for (const job of links) {
      const result = await mock.waitForResult(job.id);
      assert.equal(result.status, 'failed', job.prompt);
      assert.equal(result.error.code, 'output_missing', job.prompt);
      assert.ok(!mock.uploads.has(job.id), job.prompt);
      assert.ok(mock.eventsOf(job.id).some((e) => e.type === 'warning' && e.data.code === 'output_skipped'), job.prompt);
    }
    const bodies = mock.requests.filter((r) => r.route !== '/pair').map((r) => r.raw).join('');
    assert.ok(!bodies.includes(mock.lastCredential), 'the credential was never sent in a body');
  });

  test('failures are reported with the right code', async (t) => {
    const { mock } = await setup(t, { config: { maxConcurrent: 4 } });
    const cases = [
      [makeJob({ prompt: 'EXIT3' }), 'failed', 'nonzero_exit'],
      [makeJob({ prompt: 'AGENTERROR' }), 'failed', 'agent_error'],
      [makeJob({ prompt: 'OVERBUDGET' }), 'failed', 'cost_cap_exceeded'],
      [makeJob({ prompt: 'plain', outputs: [{ path: 'missing.txt', required: true }] }), 'failed', 'output_missing'],
    ];
    for (const [job] of cases) mock.enqueue(job);
    for (const [job, status, code] of cases) {
      const result = await mock.waitForResult(job.id);
      assert.equal(result.status, status, job.prompt);
      assert.equal(result.error.code, code, job.prompt);
    }
  });

  test('a missing CLI fails the job cleanly', async (t) => {
    const { mock } = await setup(t, { fakes: { claude: false } });
    const job = makeJob();
    mock.enqueue(job);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'binary_not_found');
  });
});

describe('other kinds', () => {
  test('codex runs headless and warns that the cost cap is not enforced', async (t) => {
    const { mock } = await setup(t);
    const job = makeJob({ kind: 'codex', prompt: 'do it', outputs: invocationOutput });
    mock.enqueue(job);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    assert.equal(result.usage.inputTokens, 5);
    assert.equal(result.usage.costUsd, null);
    assert.equal(uploaded(mock, job.id).prompt, 'do it');
    assert.ok(mock.eventsOf(job.id).some((e) => e.type === 'warning' && e.data.code === 'cost_cap_not_enforced'));
  });

  test('shell-safe runs an allowed command without a shell', async (t) => {
    const { mock } = await setup(t);
    const job = makeJob({ kind: 'shell-safe', prompt: undefined, mcp: undefined, limits: { timeLimitSec: 5 }, command: ['echo', '$(id) ; hello'] });
    mock.enqueue(job);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    assert.ok(mock.eventsOf(job.id).some((e) => e.type === 'log' && e.data.line === '$(id) ; hello'));
  });
});

describe('limits and cancellation', () => {
  test('cancel stops a running job', async (t) => {
    const { mock, home } = await setup(t);
    const job = makeJob({ prompt: 'BLOCK', outputs: invocationOutput });
    mock.enqueue(job);
    await mock.waitFor(() => mock.eventsOf(job.id).some((e) => e.type === 'agent' && e.data.type === 'assistant'), { label: 'job running' });
    mock.cancel(job.id);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.error.code, 'cancelled');
    assert.equal(result.signal, 'SIGTERM');
    assert.ok(!mock.uploads.has(job.id), 'a cancelled job uploads nothing');
    assert.deepEqual(leftovers(home), []);
  });

  test('cancel reaches a runner with no free slots', async (t) => {
    const { mock } = await setup(t, { config: { maxConcurrent: 1 } });
    const job = makeJob({ prompt: 'BLOCK' });
    mock.enqueue(job);
    await mock.waitFor(() => mock.polls.some((p) => p.slots === 0 && p.runningJobs.includes(job.id)), { label: 'full poll' });
    mock.cancel(job.id);
    assert.equal((await mock.waitForResult(job.id)).status, 'cancelled');
  });

  test('a job that ignores SIGTERM is killed', async (t) => {
    const { mock } = await setup(t);
    const job = makeJob({ prompt: 'STUBBORN' });
    mock.enqueue(job);
    await mock.waitFor(() => mock.eventsOf(job.id).some((e) => e.type === 'agent' && e.data.type === 'assistant'), { label: 'job running' });
    mock.cancel(job.id);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.signal, 'SIGKILL');
  });

  test('the time limit is enforced', async (t) => {
    const { mock } = await setup(t);
    const job = makeJob({ prompt: 'BLOCK', limits: { timeLimitSec: 1, costCapUsd: 1 } });
    mock.enqueue(job);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'timed_out');
    assert.equal(result.error.code, 'time_limit_exceeded');
    assert.ok(result.durationMs >= 1000);
  });

  test('never runs more than N jobs at once', async (t) => {
    const { mock } = await setup(t, { config: { maxConcurrent: 2 } });
    const jobs = [1, 2, 3, 4].map(() => makeJob({ prompt: 'BLOCK', limits: { timeLimitSec: 2, costCapUsd: 1 } }));
    for (const job of jobs) mock.enqueue(job);
    for (const job of jobs) assert.equal((await mock.waitForResult(job.id, { timeoutMs: 20_000 })).status, 'timed_out');
    assert.ok(mock.polls.every((p) => p.runningJobs.length <= 2 && p.slots <= 2));
    assert.ok(mock.heartbeats.every((h) => h.runningJobs.length <= 2));
    assert.ok(mock.polls.some((p) => p.runningJobs.length === 2), 'it did use both slots');
  });

  test('extra jobs from Pulse are rejected as capacity, and accepted when requeued', async (t) => {
    const { mock } = await setup(t, { config: { maxConcurrent: 1 } });
    mock.overDeliver = true;
    const first = makeJob({ prompt: 'BLOCK', limits: { timeLimitSec: 2, costCapUsd: 1 } });
    const extra = makeJob({ prompt: 'plain' });
    mock.enqueue(first, extra);
    const rejected = await mock.waitForResult(extra.id);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.error.code, 'capacity');
    assert.ok(!mock.results.has(first.id), 'the first job was still running');
    await mock.waitForResult(first.id);
    mock.overDeliver = false;
    mock.results.delete(extra.id);
    mock.enqueue(extra);
    assert.equal((await mock.waitForResult(extra.id)).status, 'succeeded');
  });

  test('a cancel in an events response stops the job', async (t) => {
    const { mock } = await setup(t);
    const job = makeJob({ prompt: 'BLOCK' });
    mock.cancelOnEvents.add(job.id);
    mock.enqueue(job);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'cancelled');
  });

  test('a 409 job_not_active from Pulse stops the job', async (t) => {
    const { mock, home } = await setup(t);
    const job = makeJob({ prompt: 'BLOCK' });
    mock.goneJobs.add(job.id);
    mock.enqueue(job);
    await mock.waitFor(() => mock.goneHits > 0, { label: 'job_not_active response' });
    await mock.waitFor(() => leftovers(home).length === 0, { label: 'job stopped' });
  });

  test('a duplicate delivery of a job runs it only once', async (t) => {
    const { mock } = await setup(t);
    const job = makeJob({ prompt: 'plain' });
    mock.enqueue(job);
    await mock.waitForResult(job.id);
    mock.enqueue(job);
    await mock.waitFor(() => mock.polls.length > 3 && mock.queue.length === 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(mock.acks.filter((id) => id === job.id).length, 1);
  });
});

describe('safety', () => {
  test('default profile: an elevated job with no approval is rejected and audited', async (t) => {
    const { mock } = await setup(t);
    const job = makeJob({ profile: 'shell' });
    mock.enqueue(job);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, 'approval_required');
    assert.deepEqual(result.audit.requestedBy, job.requestedBy);
    assert.ok(!mock.uploads.has(job.id));
  });

  test('an approved elevated job runs, and its approval is in the audit', async (t) => {
    const { mock } = await setup(t);
    const job = makeJob({ profile: 'shell', approval, prompt: 'INSPECT', outputs: invocationOutput });
    mock.enqueue(job);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    assert.deepEqual(result.audit.approval, approval);
    assert.ok(uploaded(mock, job.id).args.join(' ').includes('Bash'));
  });

  test('a local ceiling beats Pulse', async (t) => {
    const { mock } = await setup(t, { config: { maxProfile: 'read-only' } });
    const job = makeJob({ profile: 'shell', approval });
    mock.enqueue(job);
    assert.equal((await mock.waitForResult(job.id)).error.code, 'profile_not_allowed');
  });

  test('a job for another organisation is rejected', async (t) => {
    const { mock } = await setup(t);
    const job = makeJob({ orgId: 'org_other' });
    mock.enqueue(job);
    assert.equal((await mock.waitForResult(job.id)).error.code, 'org_mismatch');
  });

  test('default config with no bubblewrap: jobs are rejected, dry runs still work', async (t) => {
    // The test PATH keeps /usr/bin and /bin, so a host with bubblewrap installed there cannot play "no bubblewrap"
    // (real bwrap is covered by sandbox-real.test.js).
    if (['/usr/bin/bwrap', '/bin/bwrap'].some((f) => fs.existsSync(f))) return t.skip('bubblewrap is installed on this host');
    const { mock, home } = await setup(t, { config: { isolation: 'bwrap' } });
    await mock.waitFor(() => mock.capabilities.length > 0);
    assert.deepEqual([mock.capabilities[0].isolation.available, mock.capabilities[0].isolation.verified], [false, false]);
    const job = makeJob({ prompt: 'MARKER' });
    mock.enqueue(job);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, 'isolation_unavailable');
    assert.ok(!fs.existsSync(path.join(home, `ran-${job.id}`)));
    const dry = makeJob({ dryRun: true });
    mock.enqueue(dry);
    assert.equal((await mock.waitForResult(dry.id)).status, 'succeeded');
  });

  test('a sandbox that fails its self-test blocks jobs', async (t) => {
    const { mock } = await setup(t, { config: { isolation: 'bwrap' }, fakes: { bwrap: true } });
    await mock.waitFor(() => mock.capabilities.length > 0);
    assert.equal(mock.capabilities[0].isolation.verified, false);
    const job = makeJob();
    mock.enqueue(job);
    assert.equal((await mock.waitForResult(job.id)).error.code, 'isolation_unavailable');
  });

  test('wiring: with a passing sandbox, jobs run through bwrap and the credential is not bound', async (t) => {
    const { mock, home, bin } = await setup(t, { config: { isolation: 'bwrap' }, fakes: { bwrap: true, bwrapHides: true } });
    await mock.waitFor(() => mock.capabilities.length > 0);
    assert.equal(mock.capabilities[0].isolation.verified, true);
    const job = makeJob({ prompt: 'plain' });
    mock.enqueue(job);
    const result = await mock.waitForResult(job.id);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    assert.equal(result.audit.isolation, 'bwrap');
    const calls = fs.readFileSync(path.join(bin, 'bwrap-calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const jobCall = calls.find((args) => args.join(' ').includes('--max-budget-usd'));
    assert.ok(jobCall, 'the job went through bwrap');
    const sandboxArgs = jobCall.slice(0, jobCall.indexOf('--'));
    assert.ok(!sandboxArgs.includes(path.join(home, 'config')));
    assert.ok(!sandboxArgs.includes(home));
    assert.ok(sandboxArgs.includes(path.join(home, 'jobs', job.id)));
    assert.ok(sandboxArgs.includes(path.join(home, 'auth', 'claude')));
  });
});

describe('revoke', () => {
  test('stops running jobs, deletes the credential and exits 78', async (t) => {
    const { mock, home, daemon } = await setup(t);
    const job = makeJob({ prompt: 'BLOCK' });
    mock.enqueue(job);
    await mock.waitFor(() => mock.eventsOf(job.id).some((e) => e.type === 'agent' && e.data.type === 'assistant'), { label: 'job running' });
    mock.revokeAll();
    const { code } = await daemon.exited;
    assert.equal(code, 78);
    assert.ok(!fs.existsSync(path.join(home, 'config', 'credential.json')));
    assert.deepEqual(leftovers(home), [], 'the job was stopped and cleaned up');
    assert.match(daemon.output.text, /revoked/);
    assert.ok(!daemon.output.text.includes(mock.lastCredential));
    assert.equal((await runCli(['run'], { home })).code, 78, 'it stays stopped');
  });

  test('other 401s keep the credential', async (t) => {
    const { mock, home, daemon } = await setup(t);
    mock.runners.delete(mock.lastCredential);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(daemon.child.exitCode, null, 'still running');
    assert.ok(fs.existsSync(path.join(home, 'config', 'credential.json')));
  });
});

describe('lifecycle', () => {
  test('SIGTERM ends running jobs, reports them, and exits 0', async (t) => {
    const { mock, daemon } = await setup(t);
    const job = makeJob({ prompt: 'BLOCK' });
    mock.enqueue(job);
    await mock.waitFor(() => mock.eventsOf(job.id).some((e) => e.type === 'agent' && e.data.type === 'assistant'), { label: 'job running' });
    daemon.child.kill('SIGTERM');
    const { code } = await daemon.exited;
    assert.equal(code, 0);
    const result = mock.results.get(job.id);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'runner_shutdown');
  });

  test('the runner keeps working through a Pulse outage', async (t) => {
    const { mock, daemon } = await setup(t);
    const { port } = mock.server.address();
    await mock.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(daemon.child.exitCode, null, 'still running');
    await new Promise((resolve) => mock.server.listen(port, '127.0.0.1', resolve));
    const before = mock.polls.length;
    await mock.waitFor(() => mock.polls.length > before, { label: 'poll after recovery', timeoutMs: 10_000 });
  });

  test('uninstall tells Pulse and removes the state directory', async (t) => {
    const { mock, home, pathValue } = await setup(t, { start: false });
    const result = await runCli(['uninstall'], { home, pathValue });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(mock.deregistered, ['run_1']);
    assert.ok(!fs.existsSync(home));
  });

  test('uninstall will not delete a directory that is not its own', async (t) => {
    const dir = makeTmp(t);
    const precious = path.join(dir, 'precious');
    fs.mkdirSync(precious);
    fs.writeFileSync(path.join(precious, 'data.txt'), 'keep me');
    const result = await runCli(['uninstall'], { home: precious });
    assert.equal(result.code, 0);
    assert.equal(fs.readFileSync(path.join(precious, 'data.txt'), 'utf8'), 'keep me');
  });

  test('install-service needs root, and --dry-run shows the plan and changes nothing', async (t) => {
    const home = path.join(makeTmp(t), 'state');
    const real = await runCli(['install-service'], { home });
    assert.equal(real.code, 1);
    assert.match(real.stderr, /needs root/);
    const dry = await runCli(['install-service', '--dry-run'], { home });
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /systemctl enable --now pulse-runner\.service/);
    assert.ok(!fs.existsSync(home));
  });
});

// RUNNERS-FULL: PROTOCOL.md §10 (subscription logins started from Pulse) and the job's access block.
describe('logins from Pulse', () => {
  const LGN = (n) => `lgn_${String(n).repeat(32).slice(0, 32)}`;
  const link = 'https://claude.example/cai/oauth/authorize?code=true&state=s1';
  const states = (mock, id) => mock.loginsOf(id).map((r) => r.state);

  test('Connect Claude: the CLI\'s own flow, the link reaches Pulse, the pasted code goes back, the token stays here', async (t) => {
    const { mock, bin } = await setup(t, { fakes: { loginFlow: true } });
    await mock.waitFor(() => mock.capabilities.length > 0);
    const before = mock.capabilities.length;
    mock.sendLogin({ id: LGN(1), tool: 'claude', action: 'start' });
    const waiting = await mock.waitFor(() => mock.loginsOf(LGN(1)).find((r) => r.state === 'waiting' && r.needsCode), { label: 'login link' });
    assert.equal(waiting.url, link, 'the link, without the terminal escape codes');
    assert.equal(waiting.needsCode, true);
    mock.sendLogin({ id: LGN(1), action: 'code', code: 'GOOD-CODE#s1' });
    await mock.waitFor(() => states(mock, LGN(1)).includes('succeeded'), { label: 'login done' });
    assert.deepEqual([...new Set(states(mock, LGN(1)))].sort(), ['starting', 'succeeded', 'verifying', 'waiting']);
    await mock.waitFor(() => mock.capabilities.length > before, { label: 'capabilities after login' });
    // Nothing Pulse was sent holds the pasted code, and the CLI ran with the runner's own login folder only.
    const sent = mock.requests.filter((r) => r.route?.startsWith('/logins/')).map((r) => r.raw).join('\n');
    assert.ok(!sent.includes('GOOD-CODE'));
    const env = JSON.parse(fs.readFileSync(path.join(bin, 'login-env'), 'utf8'));
    assert.ok(env.includes('CLAUDE_CONFIG_DIR'));
    assert.ok(!env.some((k) => /ANTHROPIC|OAUTH_TOKEN|PULSE/.test(k)), env.join(','));
  });

  test('a wrong code fails the login; cancel and logout report back', async (t) => {
    const { mock, bin } = await setup(t, { fakes: { loginFlow: true } });
    mock.sendLogin({ id: LGN(2), tool: 'claude', action: 'start' });
    await mock.waitFor(() => states(mock, LGN(2)).includes('waiting'));
    mock.sendLogin({ id: LGN(2), action: 'code', code: 'WRONG#s1' });
    await mock.waitFor(() => states(mock, LGN(2)).includes('failed'));
    assert.equal(mock.loginsOf(LGN(2)).at(-1).error.code, 'login_failed');

    mock.sendLogin({ id: LGN(3), tool: 'claude', action: 'start' });
    await mock.waitFor(() => states(mock, LGN(3)).includes('waiting'));
    mock.sendLogin({ id: LGN(3), action: 'cancel' });
    await mock.waitFor(() => states(mock, LGN(3)).includes('cancelled'));

    mock.sendLogin({ id: LGN(4), tool: 'claude', action: 'logout' });
    await mock.waitFor(() => states(mock, LGN(4)).includes('succeeded'));
    assert.ok(fs.existsSync(path.join(bin, 'logged-out')));

    mock.sendLogin({ id: LGN(5), tool: 'gemini', action: 'start' });
    await mock.waitFor(() => states(mock, LGN(5)).includes('failed'));
    assert.equal(mock.violations.length, 0, mock.violations.join(', '));
  });
});

describe('access from Pulse', () => {
  test('sandbox off in Pulse runs a job outside a failing sandbox only when the server also allows it', async (t) => {
    const { mock } = await setup(t, { config: { isolation: 'bwrap', allowNoSandbox: true }, fakes: { bwrap: true } });
    await mock.waitFor(() => mock.capabilities.length > 0);
    assert.equal(mock.capabilities[0].limits.allowNoSandbox, true);
    const off = makeJob({ prompt: 'plain', access: { level: 'full', sandbox: false } });
    mock.enqueue(off);
    const result = await mock.waitForResult(off.id);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    assert.equal(result.audit.isolation, 'none');
    const on = makeJob({ prompt: 'plain', access: { level: 'read-write', sandbox: true } });
    mock.enqueue(on);
    assert.equal((await mock.waitForResult(on.id)).error.code, 'isolation_unavailable');
  });

  test('sandbox off in Pulse alone changes nothing', async (t) => {
    const { mock } = await setup(t, { config: { isolation: 'bwrap' }, fakes: { bwrap: true } });
    const job = makeJob({ access: { level: 'full', sandbox: false } });
    mock.enqueue(job);
    assert.equal((await mock.waitForResult(job.id)).error.code, 'isolation_unavailable');
  });
});
