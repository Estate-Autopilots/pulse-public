// End-to-end on a running Pulse (dev): a synthetic person pairs an app through the real native gateway, checks in,
// takes a break, comes back with a queued tap, checks out, sees the same day on My desk, revokes the device; then
// every synthetic row is deleted and the deletion verified. No real person's record is touched.
//   set -a; . /etc/estate-autopilots/db/pulse_dev.env; set +a
//   PULSE_WEB=http://127.0.0.1:3200 node services/api/test/companion-dev-e2e.mjs > receipt.json
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import { createClient } from '../../../packages/companion/src/index.js';

const web = process.env.PULSE_WEB ?? 'http://127.0.0.1:3200';
const environment = process.env.PULSE_E2E_ENV ?? 'dev';
if(!['staging','dev'].includes(environment))throw Error('Synthetic E2E is forbidden on production');
const publicOrigin=process.env.PULSE_PUBLIC_ORIGIN ?? new URL(web).origin;
const browserToken=randomBytes(32).toString('base64url');
const org = process.env.PULSE_ORG_ID ?? '6f1a455d-ced2-504d-b8d5-5ae0efbe7c75';
const person = randomUUID(), email = `companion-e2e-${person.slice(0, 8)}@synthetic.estateautopilots.test`;
const checks = [];
const ok = (label, value) => { assert.ok(value, label); checks.push({ label, passed: true }); };
const eq = (label, a, b) => { assert.deepEqual(a, b, label); checks.push({ label, passed: true }); };
const db = async (role, sql, args = []) => {
  const c = new pg.Client({ connectionString: role === 'owner' ? process.env.MIGRATE_DATABASE_URL : process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('begin');
    if (role !== 'owner' && environment !== 'staging') await c.query(`set local role ${role}`);
    await c.query("select set_config('pulse.org_id',$1,true)", [org]);
    const r = await c.query(sql, args); await c.query('commit'); return r.rows;
  } catch (e) { await c.query('rollback'); throw e; } finally { await c.end(); }
};
const asPerson = async (path, body) => {
  const r = await fetch(`${web}/api/v0/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie:'pulse_session='+browserToken, origin:publicOrigin, host:new URL(publicOrigin).host }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let tokens = null;
const store = { get: async () => tokens, set: async (t) => { tokens = t; }, clear: async () => { tokens = null; } };
const app = createClient({ base: `${web}/api/native/v0`, store, client: 'e2e/0.2.0' });

const started = Date.now();
let deviceId = null, pairId = null, cleaned = null;
let priorAttendanceGate = null;
try {
  if (environment === 'dev') {
    await db('owner', 'select pulse.hr_defaults()');
    priorAttendanceGate = (await db('owner', 'select attendance_enabled from pulse.hr_policy where org_id=$1', [org]))[0].attendance_enabled;
    await db('owner', 'update pulse.hr_policy set attendance_enabled=true where org_id=$1', [org]);
  }
  await db('pulse_worker', "insert into pulse.person(id,org_id,display_name,side,status) values($1,$2,'Companion E2E (synthetic)','staff','active')", [person, org]);
  await db('pulse_worker', "insert into pulse.people_profile(org_id,person_id,role,evidence) values($1,$2,'person','{}')", [org, person]);
  await db('pulse_worker', "insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values($1,'google',$2,$3,'Workspace account (synthetic e2e)')", [org, email, person]);

  await db('owner',"insert into pulse.login_credential(org_id,person_id,password_hash,must_change,status) values($1,$2,crypt($3,gen_salt('bf',4)),false,'active')",[org,person,randomBytes(32).toString('base64url')]);
  await db('owner',"insert into pulse.login_session(org_id,person_id,token_hash,expires_at) values($1,$2,$3,now()+interval '30 minutes')",[org,person,createHash('sha256').update(browserToken).digest('hex')]);

  // 1. Browser pairing through the real gateway and web app.
  const pair = await app.pairStart('windows', 'Companion E2E laptop (synthetic)');
  pairId = pair.pairId;
  ok('pairing starts without an account', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pair.code));
  eq('pending before approval', (await app.pairPoll(pair.pairId, pair.pollSecret)).status, 'pending');
  const peek = await asPerson(`native/pair/${pair.code}`);
  eq('the person sees the request on /connect', peek.data?.name, 'Companion E2E laptop (synthetic)');
  eq('the person approves', (await asPerson('native/pair/decide', { code: pair.code, approve: true })).data?.status, 'approved');
  const done = await app.pairPoll(pair.pairId, pair.pollSecret);
  eq('the app receives its device credential', done.status, 'approved');
  deviceId = done.deviceId;
  ok('credential stored by the client only', tokens?.accessToken?.length === 43 && tokens?.refreshToken?.length === 43);

  // The phone's post-pair handshake uses these routes before rendering Today.
  eq('paired phone receives its own identity', (await app.call('me')).person, person);
  ok('paired phone finds its existing device', (await app.call('devices')).devices.some(d=>d.id===deviceId));
  ok('paired phone can read notification and presence policy', Array.isArray((await app.call('devices/policy')).notices));
  eq('paired phone can report explicit unknown OS capabilities', (await app.call(`devices/${deviceId}/health`,{health:'healthy',appVersion:'0.3.0',capabilities:{foreground_location:'unknown',background_location:'unknown',push:'unknown'}})).ok, true);

  eq('server receives device presence opt-out through the gateway', (await app.call('companion/presence',{consent:false,autoConsent:false})).enabled, false);

  // 2. The day and one-click actions through the gateway.
  let day = await app.companion();
  eq('own day', day.person.id, person);
  ok('not checked in yet', ['out', 'off', 'holiday', 'leave'].includes(day.state));
  if (day.attendanceEnabled) {
    await app.act('check-in', { mode: 'office', via: 'desktop', trigger: 'manual' });
    day = await app.companion(); eq('checked in', day.state, 'in');
    await app.act('break-start', { via: 'desktop' });
    day = await app.companion(); eq('on a break', day.state, 'break');
    const back = { via: 'mobile', at: new Date().toISOString(), queueId: `e2e-${randomUUID()}` };
    await app.act('break-end', back);
    eq('a retried queued tap is applied once', (await app.call('attendance/break', { action: 'end', ...back })).replayed, true);
    day = await app.companion(); eq('back from the break', day.state, 'in');
    await app.act('check-out', { via: 'chrome' });
    day = await app.companion(); eq('done for the day', day.state, 'done');
    ok('worked time and the break are counted', day.entry.closedBreakSeconds >= 0 && Date.parse(day.entry.out) >= Date.parse(day.entry.in));

    // 3. The same day on My desk, and the attendance rows say which app and trigger.
    eq('My desk shows the same day', (await asPerson('hr/self')).data?.now?.state, 'done');
    const rows = await db('owner', "select e.client,e.out_client,(select jsonb_agg(b.end_client) from pulse.attendance_break b where b.entry_id=e.id) breaks from pulse.attendance_entry e where e.person_id=$1", [person]);
    eq('check-in recorded from the desktop app', [rows[0].client.via, rows[0].client.device], ['desktop', deviceId]);
    eq('check-out recorded from Chrome', rows[0].out_client.via, 'chrome');
    ok('the queued back-from-break is marked as synced later', rows[0].breaks.some((b) => b?.queued === true));
    ok('no coordinates stored', !JSON.stringify(rows).match(/"lat"|"lng"|latitude/));
  } else {
    const before = Number((await db('owner', 'select count(*)::int n from pulse.attendance_entry where person_id=$1', [person]))[0].n);
    const refused = await fetch(`${web}/api/native/v0/attendance/check-in`, { method:'POST', headers:{authorization:`Bearer ${tokens.accessToken}`,'content-type':'application/json',origin:publicOrigin,host:new URL(publicOrigin).host}, body:JSON.stringify({mode:'office',via:'desktop'}) });
    const message = (await refused.json()).error;
    eq('attendance-off app check-in refuses with 403', refused.status, 403);
    eq('attendance-off app check-in shows the organisation message', message, 'Attendance is off for your organisation.');
    const after = Number((await db('owner', 'select count(*)::int n from pulse.attendance_entry where person_id=$1', [person]))[0].n);
    eq('attendance-off app check-in writes no row', after, before);
  }

  // Published installers are checked through the same authenticated Settings/download routes.
  if(process.env.PULSE_DOWNLOAD_MANIFEST){
    const manifest=JSON.parse(await readFile(process.env.PULSE_DOWNLOAD_MANIFEST,'utf8'));
    const headers={cookie:'pulse_session='+browserToken,host:new URL(publicOrigin).host,origin:publicOrigin};
    const settings=await fetch(`${web}/settings?tab=devices`,{headers});
    eq('Settings Devices loads for the synthetic person',settings.status,200);
    const html=await settings.text();
    ok('Get the apps is visible',html.includes('Get the apps'));
    for(const file of manifest.files)ok(`Settings offers ${file.platform} ${file.kind}`,html.includes(file.name));
    const file=manifest.files.find(f=>f.platform==='chrome');
    assert.ok(file);
    const download=await fetch(`${web}/api/downloads/${file.name}`,{headers});
    eq('published Chrome ZIP downloads through the authenticated route',download.status,200);
    const bytes=Buffer.from(await download.arrayBuffer());
    eq('download size matches the runner manifest',bytes.length,file.size);
    eq('download SHA256 matches the runner manifest',createHash('sha256').update(bytes).digest('hex'),file.sha256);
    eq('signed-out downloads are refused',(await fetch(`${web}/api/downloads/${file.name}`)).status,401);
  }

  // 4. Token-only gateway: Access identity cannot stand in for a device; revocation signs the app out.
  const forged = await fetch(`${web}/api/native/v0/companion`, { headers: { 'cf-access-authenticated-user-email': email } });
  eq('the gateway refuses an Access identity without a device credential', forged.status, 401);
  eq('the person revokes the app in Settings → Devices', (await asPerson(`devices/${deviceId}/revoke`, {})).status, 200);
  await assert.rejects(app.companion(), (e) => e.status === 401 && e.signedOut === true);
  checks.push({ label: 'a revoked app is signed out', passed: true });
} finally {
  // 5. Delete every synthetic row, then prove nothing is left.
  if((await db('owner',"select to_regclass('pulse.companion_presence') is not null ready"))[0].ready)await db('owner','delete from pulse.companion_presence where person_id=$1',[person]);
  const statements = [
    'delete from pulse.attendance_break where person_id=$1', 'delete from pulse.attendance_entry where person_id=$1',
    'delete from pulse.native_event where person_id=$1', 'delete from pulse_priv.native_token where person_id=$1',
    'delete from pulse_priv.native_pair where person_id=$1 or id=$2', 'delete from pulse.native_permission where person_id=$1',
    'delete from pulse.native_device where person_id=$1', 'delete from pulse_priv.auth_event where actor=$1',
    'delete from pulse.audit_event where actor_id=$1', 'delete from pulse.account where holder_person_id=$1',
    'delete from pulse.login_session where person_id=$1','delete from pulse.login_credential where person_id=$1','delete from pulse.people_profile where person_id=$1', 'delete from pulse.person where id=$1',
  ];
  for (const sql of statements) await db('owner', sql, sql.includes('id=$2') ? [person, pairId] : [person]);
  if (environment === 'dev' && priorAttendanceGate !== null)
    await db('owner', 'update pulse.hr_policy set attendance_enabled=$2 where org_id=$1', [org, priorAttendanceGate]);
  const left = await db('owner', `select (select count(*) from pulse.person where id=$1)+(select count(*) from pulse.attendance_entry where person_id=$1)+(select count(*) from pulse.native_device where person_id=$1)
    +(select count(*) from pulse_priv.native_token where person_id=$1)+(select count(*) from pulse.account where holder_person_id=$1)+(select count(*) from pulse.audit_event where actor_id=$1) n`, [person]);
  cleaned = Number(left[0].n) === 0;
}
eq('every synthetic row was deleted', cleaned, true);
console.log(JSON.stringify({ environment, target: web, gateway: `${web}/api/native/v0`, ranAt: new Date(started).toISOString(), seconds: Math.round((Date.now() - started) / 1000), checks: checks.length, receipts: checks, syntheticPerson: 'deleted' }, null, 2));
