// CLI unit tests: the operation table matches the v1 reference, arguments become the right requests, hosts and the
// credentials file are handled safely, output is readable, and the tarball is a valid npm package.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { operations, readSpec, render } from '../scripts/generate.mjs';

process.env.PULSE_CLI_NO_MAIN = '1';
const { OPERATIONS } = await import('../dist/operations.generated.js');
const { commands, NAMED, buildRequest, specFor, commandHelp, title } = await import('../dist/commands.js');
const { parse } = await import('../dist/args.js');
const { normalizeHost, configDir, resolveHost, resolveProfile, profileKey, writeStore, readStore, DEFAULT_HOST } = await import('../dist/config.js');
const { main } = await import('../dist/cli.js');
const { human, table } = await import('../dist/output.js');
const { redact, secret, CliError } = await import('../dist/errors.js');
const { readAnswer } = await import('../dist/auth.js');

const UUID = '0b6c2f1e-1d2c-4a5b-8c9d-0e1f2a3b4c5d';
const cmd = (group, name) => commands().find(c => c.group === group && c.name === name);
const req = (c, tokens) => buildRequest(c, parse(tokens, specFor(c.op)));
const code = fn => { try { fn(); } catch (e) { assert.ok(e instanceof CliError, String(e)); return e.exitCode; } return 0; };

test('the generated table is current with services/api/openapi/v1.yaml', () => {
  const spec = readSpec();
  assert.equal(readFileSync(new URL('../src/operations.generated.ts', import.meta.url), 'utf8'), render(spec));
  assert.deepEqual(OPERATIONS.map(o => o.operationId), operations(spec).map(o => o.operationId));
});

test('every bearer v1 operation is a command, and every friendly name points at a real operation', () => {
  const spec = readSpec(), ids = [];
  for (const item of Object.values(spec.paths)) for (const op of Object.values(item))
    if (op?.operationId && (op.security ?? []).some(s => s.bearer)) ids.push(op.operationId);
  assert.ok(ids.length >= 15);
  const list = commands();
  for (const id of ids) assert.ok(list.some(c => c.operationId === id), `${id} has no command`);
  for (const n of NAMED) assert.ok(ids.includes(n.operationId), `NAMED ${n.operationId} is not in the v1 reference`);
  const titles = list.map(title);
  assert.equal(new Set(titles).size, titles.length, 'command names are unique');
  for (const c of list) assert.match(commandHelp(c), /Usage: pulse /);
});

test('arguments become the request: positionals, flags, enums, ids, arrays, null and the idempotency key', () => {
  const correct = req(cmd('hr', 'correct'), [UUID, '--field', 'joinedOn', '--value', '2026-08-01', '--reason', 'Offer letter says so']);
  assert.equal(correct.method, 'POST');
  assert.equal(correct.path, `/api/v1/people/${UUID}/corrections`);
  assert.deepEqual(correct.body, { field: 'joinedOn', value: '2026-08-01', reason: 'Offer letter says so' });
  assert.match(correct.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  assert.equal(req(cmd('hr', 'correct'), [UUID, '--field', 'pod', '--no-value', '--reason', 'Left the pod']).body.value, null);
  assert.equal(req(cmd('hr', 'correct'), [UUID, '--field=pod', '--value=x', '--reason=Moved pods', '--idempotency-key', UUID]).headers['Idempotency-Key'], UUID);
  assert.equal(code(() => req(cmd('hr', 'correct'), [UUID, '--field', 'salary', '--value', '1', '--reason', 'nope nope'])), 4);
  assert.equal(code(() => req(cmd('hr', 'correct'), ['asha', '--field', 'pod', '--value', 'x', '--reason', 'Moved pods'])), 4);
  assert.equal(code(() => req(cmd('hr', 'correct'), [UUID, '--field', 'pod', '--value', 'x'])), 4, 'reason is required');
  assert.equal(code(() => req(cmd('hr', 'correct'), [UUID, '--feild', 'pod'])), 4, 'a typo is an error');

  const search = req(cmd('people', 'search'), ['asha', '--status', 'all']);
  assert.deepEqual([search.method, search.path, search.query, search.body], ['GET', '/api/v1/people', { query: 'asha', status: 'all' }, undefined]);
  assert.deepEqual(req(cmd('people', 'search'), []).query, {});
  assert.equal(code(() => req(cmd('people', 'search'), ['a', 'b'])), 4);

  const group = req(cmd('groups', 'create'), ['Launch team', '--member-ids', `${UUID},${UUID.replace('0b', '1b')}`, '--all-active-staff']);
  assert.deepEqual(group.body, { name: 'Launch team', memberIds: [UUID, UUID.replace('0b', '1b')], allActiveStaff: true });
  assert.deepEqual(req(cmd('groups', 'members'), [UUID, '--add', UUID, '--add', UUID.replace('0b', '2b')]).body, { add: [UUID, UUID.replace('0b', '2b')] });
  assert.deepEqual(req(cmd('bugs', 'set-status'), [UUID, 'done']).body, { status: 'done' });
  assert.deepEqual(req(cmd('hr', 'sign-in-email'), [UUID, '--kind', 'reset']).body, { kind: 'reset' });
  assert.deepEqual(req(cmd('changes', 'undo'), [UUID]).body, {});
  assert.deepEqual(req(cmd('groups', 'create'), ['--data', '{"name":"From data","allActiveStaff":true}']).body, { name: 'From data', allActiveStaff: true });
  assert.equal(code(() => req(cmd('groups', 'create'), ['--data', '{nope'])), 4);
  assert.equal(req(cmd(undefined, 'fetch'), [`person:${UUID}`]).path, `/api/v1/search/person%3A${UUID}`);
});

test('hosts: https origins only (http on loopback), and the order flag > PULSE_HOST > last login > default', () => {
  assert.equal(normalizeHost('pulse.example.com'), 'https://pulse.example.com');
  assert.equal(normalizeHost('https://pulse.example.com/'), 'https://pulse.example.com');
  assert.equal(normalizeHost('localhost:3000'), 'http://localhost:3000');
  for (const bad of ['http://pulse.example.com', 'https://pulse.example.com/app', 'https://u:p@pulse.example.com', 'ftp://x']) assert.equal(code(() => normalizeHost(bad)), 4, bad);
  assert.equal(resolveHost('a.example.com', { PULSE_HOST: 'b.example.com' }, { version: 1, hosts: {} }), 'https://a.example.com');
  assert.equal(resolveHost(undefined, { PULSE_HOST: 'b.example.com' }, { version: 1, defaultHost: 'https://c.example.com', hosts: {} }), 'https://b.example.com');
  assert.equal(resolveHost(undefined, {}, { version: 1, defaultHost: 'https://c.example.com', hosts: {} }), 'https://c.example.com');
  assert.equal(resolveHost(undefined, {}, { version: 1, hosts: {} }), DEFAULT_HOST);
});

// AGENT-API (owner, 5 Nov 2026: "org switch"): two companies on one address are two sign-ins, side by side.
test('profiles: two organisations on one address, --org / PULSE_ORG, and pulse org switch', async () => {
  const S = 'https://pulse.example.com', W = profileKey(S, 'Willow Lane'), I = profileKey(S, 'I-Solar Energy');
  assert.equal(W, 'https://pulse.example.com#willow-lane');
  const store = { version: 1, defaultHost: W, hosts: { [W]: { kind: 'token', token: 'ppt_w', org: 'Willow Lane', savedAt: 'now' }, [I]: { kind: 'token', token: 'ppt_i', org: 'I-Solar Energy', savedAt: 'now' } } };
  assert.equal(resolveProfile(undefined, undefined, {}, store), W);
  assert.equal(resolveProfile(undefined, 'i-solar energy', {}, store), I);
  assert.equal(resolveProfile(undefined, undefined, { PULSE_ORG: 'I-Solar Energy' }, store), I);
  assert.equal(resolveProfile(S, undefined, {}, store), W, 'the default on that address');
  assert.equal(resolveHost(undefined, {}, store), S, 'a login goes to the address, not the profile');
  assert.equal(code(() => resolveProfile(undefined, 'Bhrata Corp', {}, store)), 2);
  assert.equal(code(() => resolveProfile(S, undefined, {}, { ...store, defaultHost: undefined })), 4, 'two there and no default: ask which');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-cli-org-'));
  process.env.PULSE_CONFIG_DIR = join(dir, 'cfg');
  const out = process.stdout.write; let printed = '';
  try {
    writeStore(store);
    process.stdout.write = (t) => { printed += t; return true; };
    assert.equal(await main(['org', 'switch', 'I-Solar', 'Energy']), 0);
    assert.equal(readStore().defaultHost, I);
    assert.equal(await main(['orgs', 'use', 'willow-lane']), 0);
    assert.equal(readStore().defaultHost, W);
    assert.equal(await main(['auth', 'status', '--json']), 0);
    process.stdout.write = out;
    assert.match(printed, /Commands now go to I-Solar Energy at https:\/\/pulse\.example\.com/);
    assert.ok(!printed.includes('ppt_'), 'tokens never printed');
    await assert.rejects(main(['org', 'switch', 'Nobody']), e => e instanceof CliError && e.exitCode === 2);
  } finally { process.stdout.write = out; delete process.env.PULSE_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }); }
});

test('the credentials file lives in the OS config directory, readable by its owner only', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  assert.match(configDir({}, 'darwin'), /Library\/Application Support\/pulse$/);
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux'), '/x/cfg/pulse');
  assert.equal(code(() => configDir({ XDG_CONFIG_HOME: 'relative' }, 'linux')), 4);
  const dir = mkdtempSync(join(tmpdir(), 'pulse-cli-unit-'));
  process.env.PULSE_CONFIG_DIR = join(dir, 'cfg');
  try {
    writeStore({ version: 1, defaultHost: 'https://pulse.example.com', hosts: { 'https://pulse.example.com': { kind: 'token', token: 'pat_x', savedAt: 'now' } } });
    assert.equal(statSync(join(dir, 'cfg', 'credentials.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'cfg')).mode & 0o777, 0o700);
    assert.equal(readStore().hosts['https://pulse.example.com'].token, 'pat_x');
  } finally { delete process.env.PULSE_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }); }
});

test('tokens never reach output; the consent answer is checked (state, issuer, Cancel)', () => {
  secret('custom-secret-value-123');
  assert.equal(redact('a pat_abcdefghijklmnop b custom-secret-value-123 c prt_ZZZZZZZZZZZZ'), 'a [redacted] b [redacted] c [redacted]');
  assert.equal(readAnswer('http://127.0.0.1:5/callback?code=abc&state=s1&iss=https%3A%2F%2Fp.example', 's1', 'https://p.example'), 'abc');
  assert.equal(code(() => readAnswer('http://127.0.0.1:5/callback?code=abc&state=other', 's1', 'https://p.example')), 2);
  assert.equal(code(() => readAnswer('http://127.0.0.1:5/callback?code=abc&state=s1&iss=https%3A%2F%2Fevil.example', 's1', 'https://p.example')), 2);
  assert.equal(code(() => readAnswer('http://127.0.0.1:5/callback?error=access_denied&state=s1', 's1', 'https://p.example')), 2);
  assert.equal(code(() => readAnswer('not a url', 's1', 'https://p.example')), 4);
});

test('output: lists are tables, records are aligned fields with nested blocks', () => {
  const t = table([{ id: 'a', name: 'Asha Rao', roles: ['hr', 'admin'], ok: true, gone: null }], undefined, 200).split('\n');
  assert.deepEqual(t, ['ID  NAME      ROLES      OK   GONE', 'a   Asha Rao  hr, admin  yes  -']);
  assert.equal(human({ items: [] }), 'No results.');
  const r = human({ person: { id: 'p1', name: 'Asha' }, changes: [{ field: 'pod', to: 'B' }] });
  assert.match(r, /^person:\n {2}id {4}p1\n {2}name {2}Asha/);
  assert.match(r, /changes:\n  FIELD  TO\n  pod    B/);
  assert.match(human({ items: [{ id: 1 }], nextCursor: 'c2' }), /--cursor c2/);
  assert.ok(table([{ text: 'x'.repeat(300) }], undefined, 60).split('\n').every(l => l.length <= 60));
});

test('the tarball is an npm package with the pulse bin', () => {
  const tar = gunzipSync(readFileSync(new URL('../dist/pulse-cli.tgz', import.meta.url)));
  const names = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.subarray(at, at + 100).toString().replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(at + 124, at + 136).toString().replace(/\0.*$/s, ''), 8);
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : tar[at + i];
    assert.equal(parseInt(tar.subarray(at + 148, at + 156).toString(), 8), sum, `${name} checksum`);
    names.push(name);
    if (name === 'package/package.json') {
      const pkg = JSON.parse(tar.subarray(at + 512, at + 512 + size).toString());
      assert.deepEqual(pkg.bin, { pulse: 'dist/cli.js' });
      assert.equal(pkg.dependencies, undefined);
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  for (const n of ['package/package.json', 'package/README.md', 'package/dist/cli.js', 'package/dist/operations.generated.js']) assert.ok(names.includes(n), n);
  assert.ok(readFileSync(new URL('../dist/cli.js', import.meta.url), 'utf8').startsWith('#!/usr/bin/env node'));
});
