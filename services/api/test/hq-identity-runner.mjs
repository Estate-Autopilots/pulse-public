// Synthetic tenants only. Real route serialization, forced RLS and the migrated href constraint.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { readHqIdentity } from '../dist/pulse-hq.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const owner = new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const app = createApp(pool, pool), org = process.env.PULSE_ORG_ID, other = process.env.TEST_OTHER_ORG;
async function own(sql, args = []) {
  const c = await owner.connect();
  try {
    await c.query('begin'); await c.query('set local role pulse_owner');
    await c.query("select set_config('pulse.org_id',$1,true)", [org]);
    const r = await c.query(sql, args); await c.query('commit'); return r.rows;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
async function call(url, payload) {
  const r = await app.inject({ url, method: payload === undefined ? 'GET' : 'POST', payload,
    headers: { 'cf-access-authenticated-user-email': process.env.TEST_EMAIL } });
  assert.equal(r.statusCode, 200, r.body); return r.json();
}
const hq = () => call('/api/v0/hq'), me = () => call('/api/v0/me');
try {
  assert.equal((await me()).hqTitle, null, 'HQ off: null title');
  assert.equal((await app.inject({ url: '/api/v0/hq' })).statusCode, 404);
  await own(`insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active)
    values($1,'tenant','modules',1,'{"off":[],"on":["pulse_hq"]}',true)`, [org]);
  assert.equal((await hq()).title, 'Synthetic Studio HQ');
  assert.equal((await me()).hqTitle, 'Synthetic Studio HQ');
  assert.equal((await hq()).platform, false);
  assert.equal((await hq()).brand, null, 'other tenant brand is invisible');
  assert.equal((await hq()).features.length, 0, 'other tenant feature is invisible');
  await call('/api/v0/hq/brand', { title: ' Studio control ', tagline: 'Synthetic tagline' });
  assert.equal((await hq()).title, 'Studio control');
  assert.equal((await me()).hqTitle, 'Studio control');
  const version = (await hq()).brandVersions[0].id;
  await call('/api/v0/hq/brand', { title: 'x'.repeat(41) });
  assert.equal((await hq()).title, 'x'.repeat(40));
  await call(`/api/v0/hq/brand/versions/${version}/restore`, {});
  assert.equal((await me()).hqTitle, 'Studio control');
  await call('/api/v0/hq/brand', { title: '  ' });
  assert.equal((await me()).hqTitle, 'Synthetic Studio HQ');

  const external = 'https://salesxray.example.com/calls';
  const feature = await call('/api/v0/hq/features', { name: 'Synthetic calls', category: 'work', href: external });
  assert.equal((await hq()).features[0].href, external, 'create accepts HTTPS');
  const valid = ['/', '/hq/features?area=work', external, 'https://salesxray.example.com:8443/calls?q=ok#proof',
    'https://example.com/' + 'a'.repeat(280)];
  const invalid = ['http://example.com/calls', 'javascript:alert(1)', 'https://u:p@host', '//host', '//host.example',
    'https://u:p@host.example/calls', 'https://example.com@evil.example/calls', 'https://localhost/calls',
    'https://example.com/a b', 'https://example.com/calls\n', 'https://example.com\\@evil.example',
    'https://example.com:65536/calls', 'https://example.com/' + 'a'.repeat(281), null];
  for (const href of [...valid, ...invalid]) {
    await call(`/api/v0/hq/features/${feature.id}`, { href });
    assert.equal((await hq()).features[0].href, valid.includes(href) ? href : null, String(href));
    if (href === null) continue;
    if (valid.includes(href)) await own('update pulse.hq_feature set href=$1 where id=$2', [href, feature.id]);
    else await assert.rejects(own('update pulse.hq_feature set href=$1 where id=$2', [href, feature.id]), { code: '23514' });
  }
  await own("update pulse.org set name='Pulse', handle='pulsehq' where id=$1", [org]);
  assert.equal((await hq()).title, 'Pulse HQ');
  assert.equal((await me()).hqTitle, 'Pulse HQ');
  assert.equal((await hq()).platform, true);
  // Same company name, different handle: not the platform; RLS hides the first tenant's new feature and brand.
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [other]);
    assert.deepEqual(await readHqIdentity(c, other), { title: 'Other tenant HQ', platform: false });
    assert.equal((await c.query('select id from pulse.hq_feature where id=$1', [feature.id])).rowCount, 0);
    await c.query('rollback');
  } finally { c.release(); }
  await own(`update pulse.tenant_config set body='{"off":["pulse_hq"],"on":["pulse_hq"]}'
    where org_id=$1 and doc_key='modules' and is_active`, [org]);
  assert.equal((await me()).hqTitle, null, 'off wins even with a saved brand and on entry');
  await writeFile(process.env.TEST_REPORT, JSON.stringify({ ok: true }));
} finally { await app.close(); await pool.end(); await owner.end(); }
