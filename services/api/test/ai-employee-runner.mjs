// EST-1733 (AI employees 2/8): admin-only add, the scoped profile, the Team projection and employee IDs in chats and
// the audit, through the real app against a synthetic company. Driven by tests/core/test_ai_employee_api.py.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const env = process.env, pool = new Pool(JSON.parse(env.TEST_API_CONFIG)), app = createApp(pool, pool);
const as = email => ({ 'cf-access-authenticated-user-email': email });
const admin = as(env.TEST_ADMIN), hr = as(env.TEST_HR), leader = as(env.TEST_LEADER), staff = as(env.TEST_STAFF), key = { 'x-pulse-agent-key': env.TEST_KEY };
const seen = [];   // every response, checked for keys and the model at the end
const call = async (url, headers, payload) => {
  const r = await app.inject({ url, method: payload ? 'POST' : 'GET', headers, ...(payload ? { payload } : {}) });
  seen.push({ url, body: r.body }); return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const team = async () => (await call('/api/v0/agents/team', admin)).body.agents;
const ai = n => `${env.TEST_CODE}-AI-00${n}`;
const add = { name: 'Synthetic Review Helper', title: 'Checks drafts', ownerId: env.TEST_OWNER, lane: 'thinking' };
const people = async () => (await app.inject({ url: '/api/v0/people', headers: admin })).json().people.map(p => p.id).sort();
const headcount = async () => (await app.inject({ url: '/api/v0/hr/desk', headers: hr })).json().counts.headcount;
const before = await team(), peopleBefore = await people(), headcountBefore = await headcount();

// Forged adds (HR, a leader who isn't an admin, plain staff, a co-worker key) are refused and write nothing.
for (const h of [hr, leader, staff]) assert.deepEqual(await call('/api/v0/agents', h, add), { status: 403, body: { error: 'Admins add AI employees' } });
for (const h of [key, { ...admin, ...key }]) assert.equal((await call('/api/v0/agents', h, add)).status, 401);   // refused before the route
for (const field of Object.keys(add)) assert.equal((await call('/api/v0/agents', admin, { ...add, [field]: undefined })).status, 400, field);
assert.equal((await call('/api/v0/agents', admin, { ...add, lane: 'slow' })).status, 400);
const foreign = await call('/api/v0/agents', admin, { ...add, ownerId: env.TEST_FOREIGN_OWNER });
assert.equal(foreign.status, 400); assert.match(foreign.body.error, /owner in this company/);
assert.deepEqual(await team(), before);

// An admin adds one: {id, employeeId} only, the next company ID, a username made like a person's.
const made = await call('/api/v0/agents', admin, add), again = await call('/api/v0/agents', admin, add);
assert.equal(made.status, 200); assert.deepEqual(Object.keys(made.body).sort(), ['employeeId', 'id']);
assert.match(made.body.employeeId, new RegExp(`^${env.TEST_CODE}-AI-\\d{3,}$`));
assert.deepEqual([made.body.employeeId, again.body.employeeId], [ai(2), ai(3)]);
const usernames = (await app.inject({ url: '/api/v0/agents', headers: admin })).json().agents;
assert.deepEqual([made, again].map(x => usernames.find(a => a.id === x.body.id).username), ['synthetic.helper', 'synthetic.helper2']);
assert.deepEqual(await people(), peopleBefore); assert.equal(await headcount(), headcountBefore);

// The Team projection: leaders and admins only.
assert.deepEqual((await team()).find(a => a.id === made.body.id), { id: made.body.id, employeeId: ai(2), name: add.name, title: add.title,
  ownerName: 'Pod Manager', lane: 'thinking', status: 'on', budgetLeft: 160000 });
assert.equal((await call('/api/v0/agents/team', leader)).status, 200);
for (const h of [staff, hr]) assert.equal((await call('/api/v0/agents/team', h)).status, 403);

// A profile exists for a non-leader only where the AI employee already appears to them (their chat).
assert.deepEqual(await call(`/api/v0/agents/${made.body.id}`, staff), { status: 404, body: { error: 'Not found' } });
assert.equal((await call(`/api/v0/agents/${crypto.randomUUID()}`, admin)).status, 404);
const profile = await call(`/api/v0/agents/${env.TEST_AGENT}`, staff);
assert.equal(profile.status, 200); assert.equal(profile.body.employeeId, ai(1)); assert.equal(profile.body.model, 'synthetic-runtime-x');
assert.equal((await call(`/api/v0/agents/${made.body.id}`, admin)).body.lane, 'thinking');

// Chats: the author, the members and everyone carry the employee ID (null for people), never the model.
const thread = (await call(`/api/v0/chats/${env.TEST_CHAT}/messages`, staff)).body;
const ids = rows => Object.fromEntries(rows.map(r => [r.authorId ?? r.id, r.employeeId]));
assert.deepEqual(ids(thread.messages.filter(m => m.kind === 'text')), { [env.TEST_AGENT]: ai(1), [env.TEST_STAFF_ID]: null });
assert.equal(ids(thread.members)[env.TEST_AGENT], ai(1)); assert.equal(ids(thread.members)[env.TEST_STAFF_ID], null);
const list = (await call('/api/v0/chats', admin)).body, everyone = ids([...list.people, ...list.searchOnly]);
assert.equal(everyone[env.TEST_AGENT], ai(1)); assert.equal(everyone[env.TEST_OWNER], null);

// The audit labels an AI employee's own action "<name> · <ID>" and finds it by ID; people read as before.
const audit = (await call(`/api/v0/audit?actor=${ai(1)}`, admin)).body.rows;
assert.deepEqual(audit.map(r => [r.action, r.actorName, r.actorEmployeeId]), [['agent_synthetic_action', `Synthetic Crew · ${ai(1)}`, ai(1)]]);
const human = (await call('/api/v0/audit', admin)).body.rows.find(r => r.actor_id === env.TEST_OWNER);
assert.equal(human.actorName, 'Pod Manager'); assert.equal(human.actorEmployeeId, null);

// No key anywhere; the model only on a profile (the audit keeps its own change record, so it is left out here).
for (const { url, body } of seen.filter(s => !s.url.startsWith('/api/v0/audit'))) {
  assert.ok(!body.includes('pak_'), url); assert.doesNotMatch(body, /"(keys?|keyHash|hash|token|secret|runtime)"\s*:/i, url);
  if (!/^\/api\/v0\/agents\/[0-9a-f-]{36}$/.test(url)) assert.ok(!body.includes('synthetic-runtime-x'), url);
}
await app.close(); await pool.end();
