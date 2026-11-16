import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createSyntheticInstall, pulseInstallSource, readFederatedMyTasks } from '../dist/synthetic-federation.js';

const config = JSON.parse(process.env.TEST_API_CONFIG);
const [wa, wb, wc] = JSON.parse(process.env.TEST_WORLDS);
const sha = s => createHash('sha256').update(s).digest();
const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
// Two installs on one scratch cluster: each has its own pool, HMAC key, link registry and owned org; RLS does the rest.
async function install(name, world, people) {
  const it = { label: 'Install ' + name.toUpperCase(), pool: new Pool({ ...config, max: 2 }), links: new Map(),
    creds: {}, skew: 0, mints: 0 };
  for (const [id, person] of Object.entries(people)) {
    const secret = randomBytes(32).toString('base64url');
    it.creds[id] = `${id}.${secret}`;
    it.links.set(id, { org: world.org, person, secretSha256: sha(secret), revoked: false });
  }
  it.cfg = { installId: 'synthetic:install-' + name, key: randomBytes(32), orgs: new Set([world.org]), links: it.links,
    now: () => Date.now() + it.skew };
  it.app = createSyntheticInstall(it.pool, it.cfg);
  it.app.addHook('onRequest', async request => { if (request.url.startsWith('/synthetic/federation/context')) it.mints++; });
  it.base = await it.app.listen({ host: '127.0.0.1', port: 0 });
  it.source = id => pulseInstallSource({ label: it.label, baseUrl: it.base, linkCredential: it.creds[id] });
  it.http = (path, bearer, init = {}) => fetch(it.base + path,
    { ...init, headers: { authorization: 'Bearer ' + bearer, ...init.headers } });
  return it;
}
const A = await install('a', wa, { 'a-member': wa.person, 'a-inactive': wa.inactive, 'a-foreign': wb.person });
const B = await install('b', wb, { 'b-member': wb.person });
const mine = (w, i) => ({ organization: w.name, title: 'Synthetic mine ' + i, status: 'open',
  dueAt: i ? null : '2026-10-19T12:00:00.000Z' });
const [rowA, rowB] = [mine(wa, 0), mine(wb, 1)];
const hub = (...sources) => readFederatedMyTasks(sources);
const state = (label, value = 'ok') => ({ label, state: value });
const tasks = (it, bearer, suffix = '', init) => it.http('/synthetic/federation/tasks' + suffix, bearer, init);
const rowsOf = async response => { // Every successful read is private and uncached.
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  return response.json();
};
try {
  // a. Member: each install returns only its own person's tasks as exact four-field rows.
  const view = await hub(A.source('a-member'), B.source('b-member'));
  assert.deepEqual(view, { tasks: [rowA, rowB], sources: [state(A.label), state(B.label)] });
  for (const t of view.tasks) console.log(`My Tasks | ${t.dueAt ?? 'no due date'} | ${t.organization} | ${t.title} | ${t.status}`);
  console.log('Sources | ' + view.sources.map(s => `${s.label}: ${s.state}`).join(' | '));
  await hub(A.source('a-member'));
  assert.equal(A.mints, 2); // A fresh context per read, never cached.

  // b. Non-member: the install denies an inactive person or another org's person; the other source stays ok.
  for (const id of ['a-inactive', 'a-foreign']) {
    assert.deepEqual(await hub(A.source(id), B.source('b-member')),
      { tasks: [rowB], sources: [state(A.label, 'denied'), state(B.label)] });
  }
  assert.throws(() => createSyntheticInstall(B.pool, { ...B.cfg, links: new Map([['c', { org: wc.org, person: wc.person,
    secretSha256: sha('x'), revoked: false }]]) }), /outside/);
  // Fail closed: one malformed row drops its whole source; an unreachable source hides nobody else.
  const broken = rows => ({ kind: 'pulse_install', label: 'Broken', read: async () => rows });
  for (const rows of [[{ ...rowA, extra: 1 }], [{ ...rowA, dueAt: 5 }], { tasks: [rowA] }]) {
    const down = pulseInstallSource({ label: 'Down', baseUrl: 'http://127.0.0.1:1', linkCredential: A.creds['a-member'] });
    assert.deepEqual(await hub(broken(rows), down, B.source('b-member')), { tasks: [rowB],
      sources: [state('Broken', 'unavailable'), state('Down', 'unavailable'), state(B.label)] });
  }

  // c. Revocation: a still-unexpired context dies with its link and works again once un-revoked.
  const minted = await rowsOf(await A.http('/synthetic/federation/context', A.creds['a-member'], post));
  const { context } = minted, [v, payload, sig] = context.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.deepEqual(Object.keys(claims).sort(), ['exp', 'iss', 'jti', 'lnk']);
  assert.ok(v === 'v1' && sig.length === 43 && claims.iss === A.cfg.installId && claims.lnk === 'a-member'
    && claims.exp * 1000 - Date.now() <= 300_000 && new Date(claims.exp * 1000).toISOString() === minted.expiresAt);
  assert.deepEqual(await rowsOf(await tasks(A, context)), [rowA]);
  const link = A.links.get('a-member');
  link.revoked = true;
  assert.equal((await tasks(A, context)).status, 401);
  assert.deepEqual((await hub(A.source('a-member'))).sources, [state(A.label, 'denied')]);
  link.revoked = false;
  assert.deepEqual(await rowsOf(await tasks(A, context)), [rowA]);
  const flip = i => context.slice(0, i) + (context[i] === 'A' ? 'B' : 'A') + context.slice(i + 1);
  const forge = changes => {
    const p = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url');
    return `v1.${p}.${createHmac('sha256', A.cfg.key).update('v1.' + p).digest('base64url')}`;
  };
  for (const bad of [flip(5), flip(context.length - 43), flip(context.length - 1), A.creds['a-member'], '',
    forge({ iss: B.cfg.installId }), forge({ lnk: 'unknown' }), forge({ exp: claims.exp + 100 })]) {
    assert.equal((await tasks(A, bad)).status, 401, bad);
  }
  assert.equal((await tasks(B, context)).status, 401); // Install A's context presented at B.
  assert.equal((await A.http('/synthetic/federation/context', context, post)).status, 401);
  A.skew = 301_000;
  assert.equal((await tasks(A, context)).status, 401); // Expired.
  A.skew = 0;
  // Revocation or remapping while the read is in flight discards it.
  const connect = A.pool.connect.bind(A.pool);
  for (const mutate of [() => { link.revoked = true; }, () => { link.person = wa.inactive; }]) {
    A.pool.connect = async () => { const c = await connect(); mutate(); return c; };
    assert.equal((await tasks(A, context)).status, 403);
    A.pool.connect = connect; link.revoked = false; link.person = wa.person;
  }

  // d. Selectors change nothing.
  for (const suffix of ['?org=' + wb.org, '?person=' + wb.person, '?link=a-foreign']) {
    assert.equal((await tasks(A, context, suffix)).status, 400);
    assert.equal((await A.http('/synthetic/federation/context' + suffix, A.creds['a-member'], post)).status, 400);
  }
  assert.equal((await A.http('/synthetic/federation/context', A.creds['a-member'],
    { ...post, body: JSON.stringify({ org: wb.org }) })).status, 400);
  assert.deepEqual(await rowsOf(await tasks(A, context, '', { headers: { 'x-org-id': wb.org, 'x-person-id': wb.person } })),
    [rowA]);

  // e. No writes through either install (the caller checks each org's task digest around this run).
  for (const it of [A, B]) for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await tasks(it, context, '', { ...post, method })).status, 404);
  }

  // f. A pool that reports a production database is refused before any task read.
  let taskReads = 0;
  const production = { connect: async () => {
    const c = await connect();
    return { release: () => c.release(), query: async (sql, args) => {
      if (sql.includes('from pulse.task')) taskReads++;
      return sql === 'select current_database() db' ? { rows: [{ db: 'pulse_production' }] } : c.query(sql, args);
    } };
  } };
  const guarded = createSyntheticInstall(production, A.cfg);
  try {
    const response = await guarded.inject({ url: '/synthetic/federation/tasks', headers: { authorization: 'Bearer ' + context } });
    assert.equal(response.statusCode, 403);
    assert.equal(taskReads, 0);
  } finally { await guarded.close(); }
  console.log('Federated My Tasks: two installs, per-read contexts, denial, revocation, selectors, no writes and scratch guard passed');
} finally {
  for (const it of [A, B]) { await it.app.close(); await it.pool.end(); }
}
