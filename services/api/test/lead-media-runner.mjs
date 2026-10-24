import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const ids = JSON.parse(process.env.TEST_IDS), [lead, sibling, foreign] = ids.leads;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), owner = new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const app = createApp(pool, pool, undefined, { readOrg: async () => ids.org });
const path = id => `/api/v0/acquisition/leads/${id}/photos`;
const call = (url = path(lead), payload, who = 'owner', headers = {}) => app.inject({ url, method: payload ? 'POST' : 'GET',
  headers: { 'cf-access-authenticated-user-email': `${who}@${ids.domain}`, ...headers }, ...(payload ? { payload } : {}) });
const sql = async (query, params = [], org = ids.org, viewer = ids.person) => {
  const c = await owner.connect();
  try { await c.query('begin'); await c.query("select set_config('role','pulse_owner',true),set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [org, viewer]);
    const r = await c.query(query, params); await c.query('commit'); return r.rows;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
};
try {
  const jpeg = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#aaccee' } }).jpeg()
    .withExif({ IFD0: { Artist: 'Synthetic EXIF sentinel', Orientation: '6' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '18/1 31/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '73/1 51/1 0/1' } }).toBuffer();
  assert.ok((await sharp(jpeg).metadata()).exif);
  const payload = { requestKey: randomUUID(), mime: 'image/jpeg', data: jpeg.toString('base64'), source: 'camera', takenAt: '2026-10-01T10:00:00Z' };
  let r = await call(path(lead), payload); assert.equal(r.statusCode, 200, r.body); const photo = r.json();
  assert.deepEqual(Object.keys(photo).sort(), ['id','leadId','uploader','uploadedAt','takenAt','source','mime','size','width','height'].sort());
  assert.equal(photo.leadId, lead); assert.equal(photo.uploader, ids.person); assert.equal(photo.source, 'camera');
  const read = await call(path(lead) + '/' + photo.id); assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.headers['content-type'], 'image/webp'); assert.equal(read.headers['cache-control'], 'private, no-store');
  const meta = await sharp(read.rawPayload).metadata(); assert.equal(meta.exif, undefined); assert.equal(meta.xmp, undefined); assert.equal(meta.icc, undefined);
  assert.ok(!read.rawPayload.includes(Buffer.from('sentinel')));
  assert.deepEqual((await call(path(lead), payload)).json(), photo);
  assert.equal((await call(path(lead), { ...payload, takenAt: '2026-10-02T10:00:00Z' })).statusCode, 409);
  assert.equal((await call()).json().photos.length, 1);
  assert.equal((await call(path(lead), undefined, 'manager')).statusCode, 200);
  assert.equal((await call(path(lead), { ...payload, requestKey: randomUUID() }, 'manager')).statusCode, 200);
  for (const url of [path(lead), path(lead) + '/' + photo.id]) assert.equal((await call(url, undefined, 'peer')).statusCode, 404);
  assert.equal((await call(path(lead), payload, 'peer')).statusCode, 404);
  for (const url of [path(sibling) + '/' + photo.id, path(lead) + '/' + randomUUID(), path(foreign), path(foreign) + '/' + photo.id]) assert.equal((await call(url)).statusCode, 404);
  assert.equal((await call(path(foreign), payload)).statusCode, 404);
  assert.equal((await call(path(lead), undefined, 'owner', { authorization: 'Bearer psvc_' + randomUUID() + '_' + 'a'.repeat(43) })).statusCode, 403);
  assert.equal((await call(path(lead), payload, 'owner', { authorization: 'Bearer psvc_' + randomUUID() + '_' + 'a'.repeat(43) })).statusCode, 403);
  const requests = [
    { url: path(lead) }, { url: path(lead) + '/' + photo.id }, { url: path(lead), method: 'POST', payload },
    { url: path('bad') }, { url: path('bad') + '/bad' }, { url: path('bad'), method: 'POST', payload: {} },
    { url: path(lead) + '/bad' }, { url: path(lead), method: 'POST', payload: {} },
    { url: path(randomUUID()) }, { url: path(randomUUID()) + '/' + randomUUID() },
    { url: path(randomUUID()), method: 'POST', payload },
  ];
  for (const request of requests) {
    assert.equal((await app.inject(request)).statusCode, 401, 'anonymous authenticates before photo validation');
    assert.equal((await app.inject({ ...request, headers: { 'cf-access-authenticated-user-email': `hr@${ids.domain}` } })).statusCode, 403, 'HR is refused before validation or lead lookup');
  }
  for (const url of [path('bad'), path('bad') + '/bad', path(lead) + '/bad']) assert.equal((await call(url)).statusCode, 400);
  for (const invalid of [{}, [], { ...payload, requestKey: 123 }, { ...payload, source: ['camera'] }]) {
    assert.equal((await call(path(lead), invalid)).statusCode, 400, 'required fields and types are never coerced');
  }
  assert.equal((await call(path('bad'), payload)).statusCode, 400);
  assert.equal((await call(path(lead), { ...payload, data: 'a'.repeat(6_668_000) })).statusCode, 413, 'body limit stays in force');
  const failures = [{ mime: 'image/png' }, { data: Buffer.from('not an image').toString('base64') }, { data: '!!!!' }, { lat: 18 }, { verified: true }, { takenAt: 'bad' }, { takenAt: '2026-02-30T10:00:00Z' }, { source: 'verified_visit' },
    { data: Buffer.alloc(5_000_001).toString('base64') }];
  for (const change of failures) { r = await call(path(lead), { ...payload, requestKey: randomUUID(), ...change }); assert.equal(r.statusCode, 400, JSON.stringify(Object.keys(change)) + r.body); }
  assert.equal((await call()).json().photos.length, 2, 'validation failures leave no stored files');
  const keyFile = process.env.PULSE_DOCUMENT_KEY_FILE; process.env.PULSE_DOCUMENT_KEY_FILE = keyFile + '.missing';
  assert.equal((await call(path(lead), { ...payload, requestKey: randomUUID() })).statusCode, 503);
  process.env.PULSE_DOCUMENT_KEY_FILE = keyFile;
  for (const format of ['png','webp']) {
    const data = await sharp(jpeg).toFormat(format).toBuffer();
    r = await call(path(lead), { requestKey: randomUUID(), mime: 'image/' + format, data: data.toString('base64') }); assert.equal(r.statusCode, 200, r.body);
  }
  const key = randomUUID(), pair = await Promise.all([call(path(lead), { ...payload, requestKey: key }), call(path(lead), { ...payload, requestKey: key })]);
  assert.ok(pair.every(r => r.statusCode === 200)); assert.equal(pair[0].json().id, pair[1].json().id);
  for (let i = 0; i < 4; i++) assert.equal((await call(path(lead), { ...payload, requestKey: randomUUID() })).statusCode, 200);
  const last = await Promise.all([call(path(lead), { ...payload, requestKey: randomUUID() }), call(path(lead), { ...payload, requestKey: randomUUID() })]);
  assert.deepEqual(last.map(r => r.statusCode).sort(), [200,409]); assert.equal((await call()).json().photos.length, 10);
  assert.deepEqual((await call(path(lead), payload)).json(), photo, 'retry still succeeds at the cap');
  const [stored] = await sql('select bytes,key_id from pulse_priv.acq_lead_media where id=$1', [photo.id]);
  assert.equal(stored.key_id, 'synthetic'); assert.ok(!stored.bytes.equals(read.rawPayload));
  assert.deepEqual((await sql('select pulse.acq_media_list($1)', [lead], ids.other).then(() => false).catch(e => e.code)), 'P0002');
  await assert.rejects(pool.query('select * from pulse_priv.acq_lead_media'), { code: '42501' });
  await sql('update pulse_priv.acq_enquiry set owner_id=(select holder_person_id from pulse.account where handle=$1) where id=$2', [`peer@${ids.domain}`, lead]);
  assert.equal((await call(path(lead) + '/' + photo.id)).statusCode, 404, 'read permission is rechecked after reassignment');
  assert.equal((await call(path(lead) + '/' + photo.id, undefined, 'peer')).statusCode, 200);
  await sql('update pulse_priv.acq_enquiry set withdrawn=true where id=$1', [lead]);
  assert.equal((await call(path(lead), undefined, 'manager')).statusCode, 404);
  await sql("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) values($1,'tenant','modules',1,'{\"off\":[\"acquisition\"]}',true)", [ids.org]);
  for (const url of [path(sibling), path(sibling) + '/' + photo.id]) assert.equal((await call(url)).statusCode, 404);
  assert.equal((await call(path(sibling), payload)).statusCode, 404);
  assert.equal(await sql('select pulse.acq_media_list($1)', [sibling]).then(() => false).catch(e => e.code), 'P0002');
  console.log('Lead media: upload/list/read, encryption, retries/cap races, decoding/EXIF stripping, ownership/tenant/module denials passed');
} finally { await app.close(); await pool.end(); await owner.end(); }
