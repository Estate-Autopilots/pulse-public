import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { registerPersonalResolver } from '../dist/v1.js';
import { verifyMcp } from './mcp-runner.mjs';
const w = JSON.parse(process.env.TEST_WORK), foreign = JSON.parse(process.env.TEST_FOREIGN);
// Test-only authentication stub on the real transaction/RLS. This is not EST-1617's production resolver.
const personal = new Map([w.staff, w.member].map(viewer => ['fixture_person_' + randomUUID().replaceAll('-', ''), { viewer, id: randomUUID() }]));
registerPersonalResolver({ pattern: /^fixture_person_[0-9a-f]{32}$/,
  resolve: async (c, token) => {
    const principal = personal.get(token);
    if (!principal || (await c.query('select pulse.current_org() id')).rows[0].id !== w.org) return null;
    await c.query("select set_config('pulse.viewer_id',$1,true),set_config('pulse.actor_account','synthetic-person',true)", [principal.viewer]);
    return principal.id;
  }, live: async (_c, token) => personal.has(token) });
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 2 }), owner = new Pool({ ...JSON.parse(process.env.TEST_OWNER_CONFIG), max: 1 }), app = createApp(pool, pool);
const call = async (key, path, status = 200) => {
  const r = await app.inject({ url: '/api/v1/' + path, headers: { authorization: `Bearer ${key}` } });
  assert.equal(r.statusCode, status, r.body); assert.match(r.headers['cache-control'], /(?:^|,\s*)no-store(?:,|$)/);
  assert.match(r.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  if (status >= 400) { assert.match(r.headers['content-type'], /^application\/problem\+json/); assert.equal(r.json().requestId, r.headers['x-request-id']); }
  return r.json();
};
const traverse = async (key, area, expected) => {
  const ids = []; let cursor, attempts = 0;
  do {
    const page = await call(key, `${area}?limit=1${cursor ? '&cursor=' + cursor : ''}`);
    assert.equal(page.items.length, 1); ids.push(page.items[0].id); cursor = page.nextCursor;
    assert.ok(++attempts <= expected.length);
  } while (cursor !== null);
  assert.deepEqual(ids, [...expected].sort()); assert.equal(new Set(ids).size, ids.length);
};
try {
  for (const key of [w.keys.ai, w.keys.app]) {
    await traverse(key, 'tasks', w.tasks.slice(0, 4)); await traverse(key, 'projects', w.projects.slice(0, 2));
    const freelanceTask = await call(key, 'tasks/' + w.tasks[0]);
    assert.deepEqual([freelanceTask.id, freelanceTask.assigneeId, freelanceTask.assigneeKind], [w.tasks[0], w.freelancer, 'staff']);
    assert.equal((await call(key, 'projects/' + w.projects[0])).id, w.projects[0]);
    for (const [area, ids] of [['tasks', [w.tasks[4], foreign.tasks[0]]], ['projects', [w.projects[2], foreign.projects[0]]]]) {
      for (const id of ids) await call(key, `${area}/${id}`, 404);
      await call(key, area + '?unknown=x', 400); await call(key, area + '?limit=0', 400);
      await call(key, area + '?cursor=not-a-cursor', 400);
    }
    await call(key, 'tasks?projectId=' + w.projects[2], 404);
    const filtered = await call(key, 'tasks?projectId=' + w.projects[0]);
    assert.deepEqual(filtered.items.map(t => t.id), [...w.tasks.slice(0, 2)].sort()); assert.equal(filtered.nextCursor, null);
    const listedFreelancer = filtered.items.find(t => t.id === w.tasks[0]);
    assert.deepEqual([listedFreelancer.assigneeId, listedFreelancer.assigneeKind], [w.freelancer, 'staff']);
    const first = await call(key, 'tasks?limit=1'), cursor = first.nextCursor;
    await call(key, 'projects?cursor=' + cursor, 400);
    await call(key, 'tasks?status=open&cursor=' + cursor, 400);
    await call(w.keys.ai2, 'tasks?cursor=' + cursor, 400);
    await call(foreign.keys.ai, 'tasks?cursor=' + cursor, 401);
  }
  await call(w.keys.writeOnly, 'tasks', 403); await call(w.keys.writeOnly, 'projects', 403);
  // Production app/AI scopes cannot bypass staff-only guards, including retries and foreign assignees.
  for (const key of [w.keys.app, w.keys.writer]) for (const area of ['tasks', 'projects']) {
    const payload = area === 'tasks' ? { title: 'Synthetic refused', projectId: w.projects[0], assigneeId: foreign.agent } : { name: 'Synthetic refused' };
    for (const method of ['POST', 'PATCH']) for (const extra of [{}, { unexpected: true }]) {
      const id = area === 'tasks' ? w.tasks[0] : w.projects[0];
      const r = await app.inject({ method, url: '/api/v1/' + area + (method === 'PATCH' ? '/' + id : ''), payload: { ...payload, ...extra },
        headers: { authorization: `Bearer ${key}`, 'idempotency-key': '00000000-0000-4000-8000-000000001614' } });
      assert.equal(r.statusCode, extra.unexpected ? 400 : 403, r.body);
      if (!extra.unexpected) assert.equal(r.json().detail, 'Staff task permission required');
    }
  }
  // Positive screen regressions use the actual staff session and the same exported saves, never a fake personal resolver.
  const screen = async (path, payload, status = 200) => {
    const r = await app.inject({ method: 'POST', url: '/api/v0/' + path, payload, headers: { 'cf-access-authenticated-user-email': w.staffEmail } });
    assert.equal(r.statusCode, status, r.body); return r.json();
  };
  const saved = await screen('tasks', { title: 'Synthetic shared task', projectId: w.projects[0] });
  await screen('tasks/' + saved.id, { title: 'Synthetic changed task', status: 'in_progress' });
  for (const assigneeId of [w.agent, foreign.agent]) await screen('tasks', { title: 'Synthetic invalid assignment', assigneeId }, 400);
  const savedProject = await screen('work/projects', { name: 'Synthetic shared project' });
  await screen('work/projects/' + savedProject.id, { summary: 'Synthetic changed summary' });
  const [staffToken, memberToken] = personal.keys();
  const write = async (area, payload, status = 200, key = randomUUID(), token = staffToken, id) => {
    const r = await app.inject({ method: id ? 'PATCH' : 'POST', url: '/api/v1/' + area + (id ? '/' + id : ''), payload,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key } });
    assert.equal(r.statusCode, status, r.body); assert.match(r.headers['cache-control'], /(?:^|,\s*)no-store(?:,|$)/); return r.json();
  };
  for (const area of ['tasks', 'projects']) {
    const key = randomUUID(), payload = area === 'tasks' ? { title: 'Synthetic v1 task', projectId: w.projects[0] } : { name: 'Synthetic v1 project' };
    const a = await write(area, payload, 200, key), b = await write(area, payload, 200, key);
    assert.deepEqual(a, b); await write(area, { ...payload, ...(area === 'tasks' ? { title: 'Changed' } : { name: 'Changed' }) }, 409, key);
    await write(area, area === 'tasks' ? { status: 'in_progress' } : { summary: 'Changed' }, 200, randomUUID(), staffToken, a.id);
    await write(area, payload, 404, randomUUID(), staffToken, (area === 'tasks' ? foreign.tasks : foreign.projects)[0]);
    await write(area, payload, area === 'tasks' ? 404 : 403, randomUUID(), memberToken, a.id);
    await write(area, { ...payload, unexpected: true }, 400);
  }
  for (const field of ['assigneeId', 'reviewerId']) for (const value of [w.agent, foreign.agent])
    await write('tasks', { title: 'Synthetic denied assignment', [field]: value }, 400);
  await write('tasks', { title: 'Synthetic denied pod', assigneeId: w.outsider }, 403, randomUUID(), memberToken);
  await write('tasks', { title: 'Synthetic self task' }, 200, randomUUID(), memberToken);
  await write('projects', { name: 'Synthetic denied creation' }, 403, randomUUID(), memberToken);
  const reference = (await app.inject({ url: '/api/v1/openapi.json' })).json();
  for (const [area, operationId] of [['tasks', 'listTasks'], ['projects', 'listProjects']]) {
    const op = reference.paths['/api/v1/' + area].get;
    assert.equal(op.operationId, operationId); assert.deepEqual(op.security, [{ bearer: [area + '.read'] }]);
  }
  await verifyMcp(app, w, foreign, staffToken, owner);
  console.log('v1 work: production app/AI reads and write denials; synthetic-person saves, replay and access matrix pass');
} finally { await app.close(); await pool.end(); await owner.end(); }
