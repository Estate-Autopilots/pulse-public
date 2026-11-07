// SERVERS-AI: the pure half of Pulse Runner (src/runner-model.ts) against docs/runner/PROTOCOL.md v1.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as M from '../dist/runner-model.js';

const invalid = (fn) => assert.throws(fn, (e) => e instanceof M.RunnerError && e.status === 400 && e.code === 'invalid_request');

test('pairing codes look like ABCD-1234, are typed loosely and hashed with a purpose prefix', () => {
  for (let i = 0; i < 200; i++) { const c = M.makeCode(); assert.match(c, M.CODE); assert.doesNotMatch(c, /[IO01]/); }
  assert.equal(M.normalCode('abcd 2345'), 'ABCD-2345');
  assert.equal(M.normalCode('ABCD2345'), 'ABCD-2345');
  assert.equal(M.normalCode('ABCD-1234'), 'ABCD-1234');
  for (const bad of ['ABC-1234', 'ABCD-12345', 'AB$D-1234', '', null, 42, 'x'.repeat(30)]) assert.equal(M.normalCode(bad), null, String(bad));
  assert.match(M.codeHash('ABCD-1234'), /^[0-9a-f]{64}$/);
  assert.notEqual(M.codeHash('ABCD-1234'), M.sha256('ABCD-1234'));
  assert.equal(M.installCommand('ABCD-1234', 'https://api.vitalsos.ai/'), 'sudo npx --yes @vitalsos/pulse-runner connect --code ABCD-1234');
  assert.equal(M.installCommand('ABCD-1234', 'https://api.example.test'), 'sudo npx --yes @vitalsos/pulse-runner connect --code ABCD-1234 --api-url https://api.example.test');
});

test('credentials start with prc_, MCP tokens with pmt_, both 256-bit and only accepted as a bearer', () => {
  const c = M.makeCredential(), t = M.makeMcpToken();
  assert.match(c, M.CREDENTIAL); assert.ok(c.length >= 36); assert.match(t, M.MCP_TOKEN);
  assert.notEqual(M.makeCredential(), c);
  assert.equal(M.bearer(`Bearer ${c}`), c);
  for (const h of [c, `Bearer ${t}`, 'Bearer prc_short', `bearer ${c}`, `Bearer ${c} x`, undefined, ['Bearer ' + c]]) assert.equal(M.bearer(h), null);
  assert.match(M.jobId(), M.JOB_ID); assert.match(M.outputId(), /^out_[0-9a-f]{32}$/);
});

test('capabilities keep exactly the protocol list and drop anything else', () => {
  const caps = M.cleanCapabilities({
    runnerVersion: '0.1.0', reportedAt: '2026-11-05T10:00:00Z', secret: 'fixture-api-key-not-kept', email: 'owner@example.test',
    system: { os: 'linux', arch: 'x64', home: '/root', cpu: { model: 'AMD EPYC', cores: 8, loadAvg1: 0.42 }, ram: { totalBytes: 34359738368, freeBytes: 12884901888 }, disk: { totalBytes: 5e11, freeBytes: 2.5e11, mounts: ['/'] } },
    ai: { claude: { installed: true, version: '2.1.0', loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', accountId: 'acct_1', email: 'x@y.z' },
      codex: { installed: false, version: null, loggedIn: false }, gemini: { installed: true } },
    tools: { node: '24.1.0', python: '3.14.4', git: '2.53.0', docker: null, ssh: '9.0' },
    isolation: { mode: 'bwrap', available: true, verified: false, reason: 'userns disabled', path: '/usr/bin/bwrap' },
    limits: { maxConcurrent: 2, maxProfile: 'shell' }, files: ['/etc/passwd'],
  });
  const text = JSON.stringify(caps);
  for (const leak of ['fixture-api-key', 'owner@example', 'acct_1', 'x@y.z', '/root', 'mounts', 'gemini', 'ssh', '/usr/bin/bwrap', '/etc/passwd']) assert.ok(!text.includes(leak), leak);
  assert.deepEqual(caps.ai.claude, { installed: true, version: '2.1.0', loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
  assert.deepEqual(caps.isolation, { mode: 'bwrap', available: true, verified: false, reason: 'userns disabled' });
  assert.deepEqual(caps.limits, { maxConcurrent: 2, maxProfile: 'shell', allowNoSandbox: false });
  assert.equal(caps.tools.docker, null);
  assert.equal(caps.system.cpu.cores, 8);
  // Wrong types become null / false, never an error (the runner reports what it can).
  const odd = M.cleanCapabilities({ ai: { claude: { loggedIn: 'yes' } }, limits: { maxProfile: 'root', maxConcurrent: 1e9 }, system: { cpu: { cores: -1 } } });
  assert.equal(odd.ai.claude.loggedIn, false); assert.equal(odd.limits.maxProfile, null); assert.equal(odd.limits.maxConcurrent, null); assert.equal(odd.system.cpu.cores, null);
  invalid(() => M.cleanCapabilities([]));
});

test('heartbeat and poll are bounded: waitSec at most 25, slots 0-64, job ids only', () => {
  assert.deepEqual(M.cleanPoll({ waitSec: 25, slots: 1, runningJobs: ['job_123'] }), { waitSec: 25, slots: 1, runningJobs: ['job_123'] });
  assert.equal(M.cleanPoll({ waitSec: 600 }).waitSec, M.MAX_WAIT_SEC);
  assert.equal(M.cleanPoll({}).slots, 0);
  assert.deepEqual(M.cleanPoll({ slots: 2, runningJobs: ['ok_1', 'bad id', 7, 'ok_1'] }).runningJobs, ['ok_1']);
  invalid(() => M.cleanPoll({ runningJobs: 'job_1' }));
  const h = M.cleanHeartbeat({ version: '0.1.0', status: 'draining', runningJobs: [], maxConcurrent: 2, uptimeSec: 3600 });
  assert.deepEqual(h, { version: '0.1.0', status: 'draining', runningJobs: [], maxConcurrent: 2, uptimeSec: 3600 });
  assert.equal(M.cleanHeartbeat({ status: 'anything' }).status, 'ready');
});

test('events: up to 100 per batch, seq from 1, unknown types skipped, big data cut', () => {
  const e = M.cleanEvents({ events: [
    { seq: 1, ts: '2026-11-05T10:00:00.100Z', type: 'status', data: { state: 'running', extra: 1 } },
    { seq: 2, ts: 'nonsense', type: 'agent', data: { type: 'assistant', message: {} } },
    { seq: 3, type: 'future_kind', data: {} },
    { seq: 4, type: 'log', data: { stream: 'stderr', line: 'x'.repeat(20000) } },
    { seq: 5, type: 'usage', data: { costUsd: 0.4, inputTokens: 10, outputTokens: 5, source: 'claude', secret: 'k' } },
    { seq: 6, type: 'agent', data: { blob: 'y'.repeat(40000) } },
  ] });
  assert.deepEqual(e.map((x) => x.seq), [1, 2, 4, 5, 6]);
  assert.deepEqual(e[0].data, { state: 'running' }); assert.equal(e[0].ts, '2026-11-05T10:00:00.100Z'); assert.equal(e[1].ts, null);
  assert.equal(e[2].data.line.length, 8000); assert.equal(e[2].data.stream, 'stderr');
  assert.deepEqual(e[3].data, { costUsd: 0.4, inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, numTurns: null, source: 'claude' });
  assert.equal(e[4].data.truncated, true);
  invalid(() => M.cleanEvents({ events: Array.from({ length: 101 }, (_, i) => ({ seq: i + 1, type: 'log', data: {} })) }));
  invalid(() => M.cleanEvents({ events: [{ seq: 0, type: 'log' }] }));
  invalid(() => M.cleanEvents({ events: [{ seq: 1.5, type: 'log' }] }));
  invalid(() => M.cleanEvents({}));
});

test('results: the five statuses, error codes and outputs cleaned', () => {
  const r = M.cleanResult({ status: 'succeeded', dryRun: false, exitCode: 0, signal: null, error: null, startedAt: '2026-11-05T10:00:00Z', finishedAt: '2026-11-05T10:03:00Z', durationMs: 180000,
    usage: { costUsd: 0.42, inputTokens: 1200, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0, numTurns: 3, source: 'claude' },
    outputs: [{ path: 'out/report.md', bytes: 1024, sha256: 'AB12', outputId: 'out_' + 'a'.repeat(32) }],
    audit: { requestedBy: { type: 'person', id: 'p1', name: 'Akabod' }, kind: 'claude', profile: 'read-only', approval: null, isolation: 'bwrap', promptSha256: 'cd34' } });
  assert.equal(r.status, 'succeeded'); assert.equal(r.exitCode, 0); assert.equal(r.durationMs, 180000); assert.equal(r.usage.costUsd, 0.42);
  assert.deepEqual(r.outputs, [{ path: 'out/report.md', bytes: 1024, sha256: 'ab12', outputId: 'out_' + 'a'.repeat(32) }]);
  assert.equal(r.audit.promptSha256, 'cd34'); assert.equal(r.audit.approval, null);
  const f = M.cleanResult({ status: 'rejected', error: { code: 'capacity', message: 'No free slot' } });
  assert.deepEqual(f.error, { code: 'capacity', message: 'No free slot' });
  assert.equal(M.cleanResult({ status: 'failed', error: { code: 'Weird Code!' } }).error.code, 'internal_error');
  invalid(() => M.cleanResult({ status: 'done' }));
});

test('output paths stay inside the job folder', () => {
  assert.equal(M.outputPath('out/report.md'), 'out/report.md');
  for (const bad of ['../x', 'out/../../etc/passwd', '/etc/passwd', 'a//b', './a', 'a\\b', 'a\u0000b', '', 'x'.repeat(513), null]) assert.equal(M.outputPath(bad), null, String(bad));
});

test('a job request is checked as the runner will check it; write and shell need approval', () => {
  const shell = M.cleanJobRequest({ kind: 'shell-safe', command: ['df', '-h'] });
  assert.deepEqual([shell.kind, shell.command, shell.profile, shell.prompt, shell.costCapUsd, shell.timeLimitSec], ['shell-safe', ['df', '-h'], 'read-only', null, null, 120]);
  const ai = M.cleanJobRequest({ kind: 'claude', prompt: 'Draft the follow-ups', model: 'claude-sonnet-5-5', outputs: [{ path: 'out/report.md', required: true }] });
  assert.deepEqual([ai.profile, ai.costCapUsd, ai.timeLimitSec, ai.outputs], ['read-only', 1, 900, [{ path: 'out/report.md', required: true }]]);
  invalid(() => M.cleanJobRequest({ kind: 'shell-safe', command: ['rm', '-rf', '/'] }));
  invalid(() => M.cleanJobRequest({ kind: 'shell-safe', command: ['sleep', '9999'] }));
  invalid(() => M.cleanJobRequest({ kind: 'shell-safe', command: ['echo', 'hi'], prompt: 'x' }));
  invalid(() => M.cleanJobRequest({ kind: 'claude', prompt: 'x', command: ['echo'] }));
  invalid(() => M.cleanJobRequest({ kind: 'claude', prompt: '  ' }));
  invalid(() => M.cleanJobRequest({ kind: 'claude', prompt: 'x', profile: 'write' }));
  invalid(() => M.cleanJobRequest({ kind: 'claude', prompt: 'x', profile: 'root', approve: true }));
  invalid(() => M.cleanJobRequest({ kind: 'claude', prompt: 'x', model: 'bad model!' }));
  invalid(() => M.cleanJobRequest({ kind: 'claude', prompt: 'x', timeLimitSec: 4 * 3600 + 1 }));
  invalid(() => M.cleanJobRequest({ kind: 'claude', prompt: 'x', outputs: [{ path: '../secret' }] }));
  invalid(() => M.cleanJobRequest({ kind: 'bash', prompt: 'x' }));
  invalid(() => M.cleanJobRequest({ kind: 'claude', prompt: 'x'.repeat(1024 * 1024 + 1) }));
  assert.equal(M.cleanJobRequest({ kind: 'codex', prompt: 'x', profile: 'write', approve: true }).approve, true);
});

test('the Job object carries mcp only for AI jobs, and orgId, limits and requestedBy as the protocol says', () => {
  const base = { id: 'job_' + 'b'.repeat(32), org_id: 'org-1', profile: 'read-only', approval: null, model: null, time_limit_sec: 600, cost_cap_usd: '2.50',
    outputs: [], dry_run: false, requested_by: 'person-1', requester_name: 'Akabod Soniba' };
  const ai = M.jobObject({ ...base, kind: 'claude', prompt: 'Hi', command: null }, { token: 'pmt_x', expiresAt: '2026-11-05T10:30:00.000Z' });
  assert.deepEqual(ai, { id: base.id, orgId: 'org-1', kind: 'claude', prompt: 'Hi', profile: 'read-only', approval: null, limits: { timeLimitSec: 600, costCapUsd: 2.5 }, outputs: [],
    mcp: { url: M.mcpUrl(), token: 'pmt_x', expiresAt: '2026-11-05T10:30:00.000Z' }, requestedBy: { type: 'person', id: 'person-1', name: 'Akabod Soniba' }, dryRun: false });
  const sh = M.jobObject({ ...base, kind: 'shell-safe', prompt: null, command: ['uptime'], cost_cap_usd: null }, null);
  assert.deepEqual([sh.command, sh.prompt, sh.mcp, sh.limits], [['uptime'], undefined, undefined, { timeLimitSec: 600 }]);
  assert.match(sh.id, /^[A-Za-z0-9_-]{1,64}$/);
});

test('a server is online for 90 seconds after its last call', () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  assert.ok(M.online('2026-11-05T09:58:31Z', now)); assert.ok(!M.online('2026-11-05T09:58:29Z', now)); assert.ok(!M.online(null, now));
});

// RUNNERS-FULL: access levels, subscription logins (PROTOCOL.md §10) and the lapsed-login alert.
test('an access level allows profiles up to itself, and Settings sends exactly level, sandbox and AI employees', () => {
  assert.ok(M.levelAllows('read-only', 'read-only') && !M.levelAllows('read-only', 'write') && !M.levelAllows('read-only', 'shell'));
  assert.ok(M.levelAllows('read-write', 'write') && !M.levelAllows('read-write', 'shell'));
  assert.ok(M.levelAllows('full', 'shell') && !M.levelAllows('nonsense', 'write'));
  assert.deepEqual(M.cleanAccess({ level: 'read-write' }), { level: 'read-write', sandbox: true, aiEmployees: false, reason: null });
  assert.deepEqual(M.cleanAccess({ level: 'full', sandbox: false, aiEmployees: true, reason: ' ok ' }), { level: 'full', sandbox: false, aiEmployees: true, reason: 'ok' });
  invalid(() => M.cleanAccess({ level: 'root' }));
  invalid(() => M.cleanAccess({ level: 'full', sandbox: 'no' }));
});

test('a login report keeps a state, and only while waiting an https link and a device code', () => {
  assert.match(M.loginId(), M.LOGIN_ID);
  assert.deepEqual(M.cleanLoginReport({ state: 'waiting', url: 'https://claude.com/cai/oauth/authorize?code=true', userCode: null, needsCode: true }),
    { state: 'waiting', url: 'https://claude.com/cai/oauth/authorize?code=true', userCode: null, needsCode: true, error: null });
  assert.deepEqual(M.cleanLoginReport({ state: 'waiting', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345' }).userCode, 'ABCD-12345');
  assert.equal(M.cleanLoginReport({ state: 'waiting', url: 'http://plain.example/x' }).url, null);
  assert.equal(M.cleanLoginReport({ state: 'waiting', url: 'https://a.example/x y' }).url, null);
  assert.equal(M.cleanLoginReport({ state: 'succeeded', url: 'https://a.example/x', userCode: 'ABCD-1234' }).url, null);
  assert.deepEqual(M.cleanLoginReport({ state: 'failed', error: { code: 'login_timeout', message: 'late' } }).error, { code: 'login_timeout', message: 'late' });
  invalid(() => M.cleanLoginReport({ state: 'token', token: 'x' }));
  assert.equal(M.cleanPastedCode(' abc#def '), 'abc#def');
  for (const bad of ['ab', 'a b c d', 'x'.repeat(513), null]) assert.equal(M.cleanPastedCode(bad), null);
});

test('a CLI that was signed in and now is not needs a new login; one never signed in does not', () => {
  const caps = (claude, codex = { installed: false, loggedIn: false }) => M.cleanCapabilities({ ai: { claude, codex } });
  const first = M.nextAiLogins({}, caps({ installed: true, loggedIn: true, subscriptionType: 'max' }), '2026-11-06T00:00:00.000Z');
  assert.deepEqual(first, { claude: { lastLoggedInAt: '2026-11-06T00:00:00.000Z', lapsedAt: null, plan: 'max' } });
  const lapsed = M.nextAiLogins(first, caps({ installed: true, loggedIn: false }), '2026-11-06T01:00:00.000Z');
  assert.equal(lapsed.claude.lapsedAt, '2026-11-06T01:00:00.000Z');
  assert.equal(M.nextAiLogins(lapsed, caps({ installed: true, loggedIn: false }), '2026-11-06T02:00:00.000Z').claude.lapsedAt, '2026-11-06T01:00:00.000Z', 'since the first time');
  assert.ok(M.needsLogin({ installed: true, loggedIn: false }, lapsed.claude));
  assert.ok(!M.needsLogin({ installed: true, loggedIn: false }, undefined));
  assert.ok(!M.needsLogin({ installed: true, loggedIn: true }, lapsed.claude));
  assert.equal(M.cleanCapabilities({ limits: { allowNoSandbox: true } }).limits.allowNoSandbox, true);
});

test('a job carries its level and sandbox, and says when an AI employee asked', () => {
  const row = { id: 'job_1', org_id: 'o', kind: 'claude', prompt: 'p', command: null, profile: 'write', approval: { a: 1 }, model: null, time_limit_sec: 60,
    cost_cap_usd: '1', outputs: [], dry_run: false, requested_by: 'u', requester_name: 'Synthetic AI helper', requested_by_type: 'ai-employee', access_level: 'read-write', sandbox: false };
  const j = M.jobObject(row, { token: 't', expiresAt: 'e' });
  assert.deepEqual(j.access, { level: 'read-write', sandbox: false });
  assert.equal(j.requestedBy.type, 'ai-employee');
  assert.equal(M.jobObject({ ...row, access_level: null, requested_by_type: 'person' }, null).access, undefined);
});
