// KAZUK-REST slice 5 through the API (tests/core/test_kazuk_rest_s5.py): the Pulse dev organisation's leadership lists
// the routed report, triages it and makes its own task (once); a member there is refused; the reporting company's
// leadership sees no inbox. Synthetic people and reports only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS), source = process.env.TEST_SOURCE_ORG;
const call = async (method, url, who, payload) => {
  const r = await app.inject({ method, url, headers: { 'cf-access-authenticated-user-email': emails[who] }, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const phase = process.argv[2] ?? 'dev';
try {
  if (phase === 'reporter') {
    // The reporting company's leadership has no inbox and cannot reach the dev organisation's rows.
    const theirs = await call('GET', '/api/v0/bug-reports/dev-inbox', 'reporterLead');
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body)); assert.equal(theirs.body.devOrg, false); assert.deepEqual(theirs.body.rows, []);
    assert.equal((await call('POST', `/api/v0/bug-reports/dev-inbox/${process.env.TEST_ROW_ID ?? '00000000-0000-4000-8000-000000000001'}`, 'reporterLead', { status: 'fixed' })).status, 404);
    console.log('kazuk-rest-s5-runner reporter: passed');
  } else {
  const list = await call('GET', '/api/v0/bug-reports/dev-inbox', 'devLead');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.devOrg, true);
  assert.equal(list.body.rows.length, 1);
  const row = list.body.rows[0];
  assert.equal(row.sourceOrg, source); assert.equal(row.sourceNumber, 1); assert.equal(row.title, 'Bug on /tasks/:id');
  assert.equal(row.adminPath, `/bugs/${source}/${row.sourceReport}`);
  assert.equal(row.words, undefined, 'no words travel');
  assert.deepEqual([list.body.counts.new, list.body.counts.companies], [1, 1]);
  // A member of the dev organisation is not its triage.
  assert.equal((await call('GET', '/api/v0/bug-reports/dev-inbox', 'devMember')).status, 403);
  assert.equal((await call('POST', `/api/v0/bug-reports/dev-inbox/${row.id}`, 'devMember', { status: 'fixed' })).status, 403);
  // Triage and the dev organisation's own task, once.
  assert.equal((await call('POST', `/api/v0/bug-reports/dev-inbox/${row.id}`, 'devLead', { status: 'done' })).status, 400);
  const task = await call('POST', `/api/v0/bug-reports/dev-inbox/${row.id}/task`, 'devLead');
  assert.equal(task.status, 200, JSON.stringify(task.body)); assert.ok(task.body.taskId);
  const again = await call('POST', `/api/v0/bug-reports/dev-inbox/${row.id}/task`, 'devLead');
  assert.equal(again.body.taskId, task.body.taskId); assert.equal(again.body.existing, true);
  const set = await call('POST', `/api/v0/bug-reports/dev-inbox/${row.id}`, 'devLead', { status: 'fixing' });
  assert.equal(set.status, 200, JSON.stringify(set.body)); assert.equal(set.body.status, 'fixing');
  const fixing = await call('GET', '/api/v0/bug-reports/dev-inbox?status=fixing', 'devLead');
  assert.equal(fixing.body.rows.length, 1); assert.equal(fixing.body.rows[0].taskId, task.body.taskId);
  assert.equal((await call('GET', '/api/v0/bug-reports/dev-inbox?status=new', 'devLead')).body.rows.length, 0);
  console.log('kazuk-rest-s5-runner: passed');
  }
} catch (e) {
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
