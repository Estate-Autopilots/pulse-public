// AI-EMPLOYEE-POWER: direct shell jobs (bash in the sandbox with a read-only view of the server) and root jobs (only with
// allowRoot here and the owner's grant in Pulse, through the root helper), and secret shapes hidden in what leaves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateJob } from '../src/job-validate.js';
import { buildCommand } from '../src/commands.js';
import { buildBwrapArgs } from '../src/sandbox.js';
import { Redactor } from '../src/redact.js';

const config = { maxTimeLimitSec: 14400, maxProfile: 'write', mcpUrl: 'https://mcp.example/mcp', allowRoot: false };
const base = { id: 'job_1', orgId: 'org', requestedBy: { type: 'ai-employee', id: 'a' }, limits: { timeLimitSec: 60 } };
const appr = { approvedBy: { id: 'p' }, approvedAt: '2026-11-06T00:00:00Z' };
const ok = (job, c = config) => validateJob({ ...base, ...job }, { config: c, orgId: 'org' });

test('a shell job is one command line, read-only or write within the ceiling, root only where allowed', () => {
  assert.equal(ok({ kind: 'shell', command: ['ls -la /var/log | head'], profile: 'read-only' }).kind, 'shell');
  assert.throws(() => ok({ kind: 'shell', command: ['ls', '-la'], profile: 'read-only' }), /one command line/);
  assert.throws(() => ok({ kind: 'shell', command: ['ls'], prompt: 'x', profile: 'read-only' }), /not prompt/);
  assert.throws(() => ok({ kind: 'shell', command: ['touch x'], profile: 'write' }), (e) => e.code === 'approval_required');
  assert.equal(ok({ kind: 'shell', command: ['touch x'], profile: 'write', approval: appr }).profile, 'write');
  assert.throws(() => ok({ kind: 'shell', command: ['id'], profile: 'root', approval: appr }), (e) => e.code === 'root_not_allowed');
  assert.throws(() => ok({ kind: 'shell', command: ['id'], profile: 'root' }, { ...config, allowRoot: true }), (e) => e.code === 'approval_required');
  assert.equal(ok({ kind: 'shell', command: ['id'], profile: 'root', approval: appr }, { ...config, allowRoot: true }).profile, 'root');
  assert.throws(() => ok({ kind: 'claude', prompt: 'x', profile: 'root', approval: appr }, { ...config, allowRoot: true }), /profile is unknown/);
});

test('bash in the sandbox sees the server read-only; root goes through the helper with the command on stdin', () => {
  const dirs = { home: '/s/jobs/j/home', tmp: '/s/jobs/j/tmp' };
  const sh = buildCommand({ ...base, kind: 'shell', command: ['ls /'], profile: 'read-only' }, { dirs, pathValue: '/usr/bin:/bin' });
  assert.deepEqual([sh.cmd, sh.args, sh.hostView, sh.stdin], ['/bin/bash', ['-c', 'ls /'], true, null]);
  const root = buildCommand({ ...base, kind: 'shell', command: ['id'], profile: 'root', limits: { timeLimitSec: 99999 } }, { dirs, pathValue: '', config: {} });
  assert.deepEqual(root.args, ['-n', '/usr/local/sbin/pulse-runner-root', '1800', 'job_1']);
  assert.equal(root.stdin, 'id'); assert.equal(root.root, true);
  const a = buildBwrapArgs({ cwd: '/s/jobs/j/work', jobDir: '/s/jobs/j', hostView: { hide: ['/s', '/home/u'] } });
  const i = a.indexOf('--ro-bind');
  assert.deepEqual(a.slice(i, i + 7), ['--ro-bind', '/', '/', '--tmpfs', '/s', '--tmpfs', '/home/u']);
  assert.ok(a.indexOf('--bind') > a.indexOf('--tmpfs'), 'the job folder is bound after the state is hidden');
});

test('secret shapes never leave the runner', () => {
  const r = new Redactor();
  assert.equal(r.string(`token ghp_${'a'.repeat(30)} end`), 'token [REDACTED] end');
  // Synthetic shapes, built at runtime so no fixture looks like a real credential.
  const placeholder = ['not', 'a', 'password'].join('-');
  const dbUrl = ['postgres', '://example-user:', placeholder, '@db.invalid:5432/x'].join('');
  assert.equal(r.string(dbUrl), '[REDACTED]db.invalid:5432/x');
  const awsShaped = 'AKIA' + 'EXAMPLE'.padEnd(16, '0');
  assert.equal(r.string(awsShaped), '[REDACTED]');
});
