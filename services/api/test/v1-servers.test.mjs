// AI-SERVER-TOOLS: how run_on_server turns a request into a runner job (src/v1-servers.ts planJob).
import assert from 'node:assert/strict';
import test from 'node:test';
import { jobUuid, planJob } from '../dist/v1-servers.js';

const both = { claude: true, codex: true, accessLevel: 'read-write' }, claudeOnly = { claude: true, codex: false, accessLevel: 'full' }, none = { claude: false, codex: false, accessLevel: 'read-only' };

test('an allow-listed command runs as shell-safe argv, read-only, whatever level was asked', () => {
  assert.deepEqual(planJob({ mode: 'shell', command: 'uname -a', level: 'write' }, none), { kind: 'shell-safe', command: ['uname', '-a'], prompt: null, profile: 'read-only' });
  assert.deepEqual(planJob({ mode: 'shell', command: '  df   -h ' }, none).command, ['df', '-h']);
});

test('any other command goes through the server CLI: Codex at the level, Claude Code only with its shell profile', () => {
  const c = planJob({ mode: 'shell', command: 'ls -la /var/log | head' }, both);
  assert.equal(c.kind, 'codex'); assert.equal(c.profile, 'read-only'); assert.match(c.prompt, /ls -la \/var\/log \| head$/);
  assert.equal(planJob({ mode: 'shell', command: 'uname -a; rm x' }, both).kind, 'codex', 'a shell character never runs as shell-safe');
  const k = planJob({ mode: 'shell', command: 'docker ps' }, claudeOnly);
  assert.equal(k.kind, 'claude'); assert.equal(k.profile, 'shell');
  assert.match(planJob({ mode: 'shell', command: 'docker ps' }, none).error, /sign in Claude or Codex/);
});

test('a task goes to the CLI named, at the level asked', () => {
  assert.deepEqual(planJob({ mode: 'claude', task: 'Check the disk', level: 'write' }, both), { kind: 'claude', command: null, prompt: 'Check the disk', profile: 'write' });
  assert.equal(planJob({ mode: 'codex', task: 'x', level: 'full' }, both).profile, 'shell');
  assert.match(planJob({ mode: 'codex', task: 'x' }, claudeOnly).error, /Codex is not signed in/);
  assert.match(planJob({ mode: 'claude' }, both).error, /Give the task/);
  assert.match(planJob({ mode: 'shell', command: 'uname', level: 'sudo' }, both).error, /level is/);
  assert.match(planJob({ mode: 'ssh', command: 'uname' }, both).error, /mode is/);
});

test('AI-EMPLOYEE-POWER: the job id becomes the uuid its hex spells for the change ledger (a bare job id was a 400)', () => {
  assert.equal(jobUuid('job_26d298651c7040c8254307f1f067f28a'), '26d29865-1c70-40c8-2543-07f1f067f28a');
  assert.throws(() => jobUuid('job_x'));
});

test('AI-EMPLOYEE-POWER: a direct shell where the runner runs one; root only as a shell job', () => {
  const direct = { ...both, directShell: true };
  assert.deepEqual(planJob({ mode: 'shell', command: 'ls -la /var/log | head' }, direct), { kind: 'shell', command: ['ls -la /var/log | head'], prompt: null, profile: 'read-only' });
  assert.equal(planJob({ mode: 'shell', command: 'touch x', level: 'full' }, direct).profile, 'write');
  assert.equal(planJob({ mode: 'shell', command: 'uname -a' }, direct).kind, 'shell-safe', 'the allow-list still runs without a shell');
  assert.deepEqual(planJob({ mode: 'shell', command: 'apt-get update', level: 'root' }, none), { kind: 'shell', command: ['apt-get update'], prompt: null, profile: 'root' });
  assert.match(planJob({ mode: 'claude', task: 'x', level: 'root' }, both).error, /Root runs shell/);
});
