import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createSyntheticMyTasks } from '../dist/synthetic-my-tasks.js';

const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 1 });
const worlds = JSON.parse(process.env.TEST_WORLDS);
const token = randomBytes(32).toString('base64url');
const principal = { id: 'synthetic:one', tokenSha256: createHash('sha256').update(token).digest(), active: true,
  memberships: new Map(worlds.slice(0, 2).map(w => [w.org, { org: w.org, person: w.person, active: true }])) };
const app = createSyntheticMyTasks(pool, principal);
const read = (suffix = '', headers = {}) => app.inject({ url: '/synthetic/my-tasks' + suffix,
  headers: { authorization: 'Bearer ' + token, ...headers } });
try {
  const response = await read();
  assert.equal(response.statusCode, 200, response.body);
  const expected = worlds.slice(0, 2).map((w, i) => ({ organization: w.name, title: 'Synthetic mine ' + i,
    status: 'open', dueAt: i ? null : '2026-10-19T12:00:00.000Z' }));
  assert.deepEqual(response.json(), expected);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  for (const row of response.json()) assert.deepEqual(Object.keys(row).sort(), ['dueAt', 'organization', 'status', 'title']);
  for (const suffix of ['?org=' + worlds[2].org, '?person=' + worlds[2].person,
    '?principal=synthetic:one', '?membership=active']) assert.equal((await read(suffix)).statusCode, 400);
  assert.deepEqual((await read('', { 'x-org-id': worlds[2].org, 'x-person-id': worlds[2].person,
    'cf-access-authenticated-user-email': 'outsider@synthetic.example' })).json(), expected);
  for (const credential of ['', 'Bearer synthetic:one', 'Bearer ' + randomBytes(32).toString('base64url')]) {
    assert.equal((await read('', { authorization: credential })).statusCode, 401);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/synthetic/my-tasks', payload: {} })).statusCode, 404);

  const first = principal.memberships.get(worlds[0].org), second = principal.memberships.get(worlds[1].org);
  first.active = false;
  assert.deepEqual((await read()).json(), expected.slice(1));
  second.active = false;
  assert.equal((await read()).statusCode, 403); // Valid credential, no active membership.
  first.active = second.active = true;
  const previous = second.person;
  second.person = worlds[0].person; // Wrong organization's person cannot authorize this tenant.
  assert.equal((await read()).statusCode, 403);
  second.person = worlds[1].inactive;
  assert.equal((await read()).statusCode, 403);
  second.person = previous;
  principal.active = false;
  assert.equal((await read()).statusCode, 401);
  principal.active = true;

  // Force revocation after discovery, while acquiring the second tenant's connection.
  const connect = pool.connect.bind(pool);
  let connections = 0;
  pool.connect = async () => {
    const c = await connect();
    if (++connections === 2) second.active = false;
    return c;
  };
  assert.equal((await read()).statusCode, 403);
  pool.connect = connect;
  second.active = true;
  for (const mutate of [() => { first.active = false; }, () => { first.person = worlds[2].person; }]) {
    connections = 0;
    pool.connect = async () => { const c = await connect(); if (++connections === 2) mutate(); return c; };
    assert.equal((await read()).statusCode, 403); // Discard earlier org results after revocation/remapping.
    pool.connect = connect;
    first.active = true; first.person = worlds[0].person;
  }
  assert.deepEqual((await read()).json(), expected); // No pooled tenant context leaks after denial.
  const c = await pool.connect();
  try {
    const context = (await c.query("select current_setting('pulse.org_id',true) org,current_setting('pulse.viewer_id',true) viewer")).rows[0];
    assert.ok(!context.org && !context.viewer);
    await c.query('begin read only');
    await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [worlds[0].org, worlds[0].person]);
    // Deliberately omit the SQL tenant filter: real RLS still hides every second/third-org task.
    assert.equal((await c.query('select count(*)::int n from pulse.task where org_id<>$1', [worlds[0].org])).rows[0].n, 0);
    await assert.rejects(c.query("update pulse.task set title='forbidden'"), e => e.code === '25006');
    await c.query('rollback');
  } finally { c.release(); }
  let taskReads = 0;
  const productionPool = { connect: async () => {
    const c = await connect();
    return { release: () => c.release(), query: async (sql, args) => {
      if (sql.includes('from pulse.task')) taskReads++;
      return sql === 'select current_database() db' ? { rows: [{ db: 'pulse_production' }] } : c.query(sql, args);
    } };
  } };
  const guarded = createSyntheticMyTasks(productionPool, principal);
  try {
    assert.equal((await guarded.inject({ url: '/synthetic/my-tasks', headers: { authorization: 'Bearer ' + token } })).statusCode, 403);
    assert.equal(taskReads, 0);
  } finally { await guarded.close(); }
  console.log('Synthetic My Tasks: authentication, four-field allowlist, two tenant reads, RLS, revocation and read-only checks passed');
} finally { await app.close(); await pool.end(); }
