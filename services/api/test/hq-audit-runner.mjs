// PostgreSQL-backed route acceptance with synthetic people and two forced-RLS tenants.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool), org = process.env.PULSE_ORG_ID, person = process.env.TEST_PERSON;
async function read(sql, args = [], tenant = org, viewer = person) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('pulse.org_id',$1,true), set_config('pulse.viewer_id',$2,true)", [tenant, viewer]);
    const r = await c.query(sql, args); await c.query('rollback'); return r.rows;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
async function call(url, payload) {
  const r = await app.inject({ url, method: payload === undefined ? 'GET' : 'POST', payload,
    headers: { 'cf-access-authenticated-user-email': process.env.TEST_EMAIL } });
  assert.equal(r.statusCode, 200, r.body); return r.json();
}
async function event(resource, resourceId, action) {
  const events = await read(`select * from pulse.audit_event where resource=$1 and resource_id=$2 and action=$3`, [resource, resourceId, action]);
  assert.equal(events.length, 1, `${resource} ${action} audited exactly once`);
  const row = events[0];
  assert.equal(row.org_id, org); assert.equal(row.actor_id, person); assert.equal(row.source, 'pulse');
  return row;
}
try {
  assert.equal((await event('tenant_config', 'tenant/modules', 'insert')).resource_id, 'tenant/modules');
  assert.equal((await call('/api/v0/hq')).canEdit, true);

  const feature = await call('/api/v0/hq/features', { name: 'Synthetic feature', category: 'work' });
  await event('hq_feature', feature.id, 'insert');
  // Existing HQ partial-update transport is POST; no API contract change is needed.
  await call(`/api/v0/hq/features/${feature.id}`, { name: 'Renamed feature', promise: 'Metadata only' });
  const changed = await event('hq_feature', feature.id, 'update');
  assert.ok(changed.fields.includes('name')); assert.ok(changed.fields.includes('promise'));
  assert.deepEqual(changed.changes, { name: { before: 'Synthetic feature', after: 'Renamed feature' } });
  const edited = await call('/api/v0/hq/features', { name: 'Synthetic flags', category: 'work', status: 'live' });
  await call(`/api/v0/hq/features/${edited.id}`, { category: 'home', status: 'beta', draft: true, archived: true });
  assert.deepEqual((await event('hq_feature', edited.id, 'update')).changes, {
    category: { before: 'work', after: 'home' }, status: { before: 'live', after: 'beta' },
    draft: { before: false, after: true }, archived: { before: false, after: true },
  });

  const offer = await call('/api/v0/hq/offers', { name: 'Synthetic offer', positioning: 'Metadata only' });
  assert.deepEqual((await event('hq_offer', offer.id, 'insert')).changes, {});
  await call(`/api/v0/hq/offers/${offer.id}`, { name: 'Updated offer' });
  assert.ok((await event('hq_offer', offer.id, 'update')).fields.includes('name'));
  const idea = await call('/api/v0/hq/ideas', { title: 'Synthetic idea', problem: 'Metadata only' });
  assert.deepEqual((await event('hq_idea', idea.id, 'insert')).changes, {});
  await call(`/api/v0/hq/ideas/${idea.id}/vote`, { on: true });
  assert.deepEqual((await event('hq_idea_vote', person, 'insert')).changes, {});
  await call(`/api/v0/hq/ideas/${idea.id}/vote`, { on: true });
  await event('hq_idea_vote', person, 'insert'); // ON CONFLICT does not manufacture a second event.
  await call(`/api/v0/hq/ideas/${idea.id}/vote`, { on: false });
  await event('hq_idea_vote', person, 'delete');

  await call('/api/v0/hq/brand', { title: 'Synthetic HQ', voice: 'Metadata only' });
  assert.deepEqual((await event('hq_brand', org, 'insert')).changes, {});
  const version = (await call('/api/v0/hq')).brandVersions[0].id;
  assert.deepEqual((await event('hq_brand_version', version, 'insert')).changes, {});
  await call('/api/v0/hq/brand', { title: 'Updated HQ' });
  assert.ok((await event('hq_brand', org, 'update')).fields.includes('body'));
  await call(`/api/v0/hq/features/${feature.id}/remove`, {});
  assert.deepEqual((await event('hq_feature', feature.id, 'delete')).changes.name, { before: 'Renamed feature', after: null });

  // The other tenant's admin can read no HQ audit rows or feature/version records from this tenant.
  const other = process.env.TEST_OTHER_ORG, otherPerson = process.env.TEST_OTHER_PERSON;
  const ids = (await read("select id from pulse.audit_event where resource like 'hq_%' or resource='tenant_config'")).map((r) => r.id);
  assert.ok(ids.length > 0);
  assert.equal((await read('select id from pulse.audit_event where id=any($1::uuid[])', [ids], other, otherPerson)).length, 0);
  assert.equal((await read('select id from pulse.hq_feature where id=$1', [edited.id], other, otherPerson)).length, 0);
  assert.equal((await read('select id from pulse.hq_brand_version where id=$1', [version], other, otherPerson)).length, 0);
  const configs = await read("select resource_id, changes from pulse.audit_event where resource='tenant_config'");
  assert.ok(configs.length > 0);
  assert.deepEqual([...new Set(configs.map((r) => r.resource_id))].sort(), ['folder_rules/default', 'role_pack/video_editor', 'tenant/modules']);
  assert.ok(configs.every((r) => Object.keys(r.changes).length === 0));
  await writeFile(process.env.TEST_REPORT, JSON.stringify({ ok: true }));
} finally { await app.close(); await pool.end(); }
