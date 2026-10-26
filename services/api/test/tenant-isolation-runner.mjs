// UX-TENANT (ADR-0032): two companies on one Pulse, proven through the real API. The install's company (EA's stand-in)
// sets up a second company through the wizard's routes, its admin signs in at its own address and assigns work, and then
// every registered route is called as each company with the other company's ids: no response may carry the other
// company's names or ids, and the other company's rows may not change. Run by tests/core/test_tenant_isolation.py.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { drainNotificationChannel } from '../dist/notification-outbox.js';
import { zoneDay } from '../dist/org-time.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const routes = [];
const app = createApp(pool, pool, (r) => { for (const m of [r.method].flat()) if (m !== 'HEAD') routes.push({ method: m, url: r.url }); });
const EA = JSON.parse(process.env.TEST_EA);
const AC_HOST = 'acmark.example.test';
// R51: AC keeps its own calendar. Pago Pago (UTC-11, no summer time) is 16.5 hours behind India, so 18:00 there on a day
// is the next day in India: any API day still counted in India time shows up as a wrong date.
const AC_ZONE = 'Pacific/Pago_Pago';
let calls = 0;
const call = async (url, { token, host, payload, method, headers = {}, bearer } = {}) => {
  calls++;
  const r = await app.inject({ url, method: method ?? (payload ? 'POST' : 'GET'), payload,
    headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex'), ...(host ? { 'x-pulse-host': host } : {}), ...(token ? { 'x-pulse-session': token } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers } });
  let data = null; try { data = r.json(); } catch { /* bytes */ }
  return { status: r.statusCode, data, body: r.body };
};
const ok = (r, what) => { assert.ok(r.status < 400, `${what}: ${r.status} ${r.body.slice(0, 400)}`); return r.data; };
await app.ready();

// 1. The operator: an individual admin of the install's own company, on the install's address (no x-pulse-host).
let r = await call('/api/v0/auth/sign-in', { payload: { username: EA.admin.username, password: EA.admin.issued } });
const eaToken = ok(r, 'operator sign-in').token;
ok(await call('/api/v0/auth/change-password', { token: eaToken, payload: { current: EA.admin.issued, next: EA.admin.password } }), 'operator password');
const me = ok(await call('/api/v0/me', { token: eaToken }), 'operator me');
assert.equal(me.operator, true, 'an individual admin of the install company is the platform operator');
assert.equal(me.org, EA.org);

// 2. The wizard, step by step, previewing first.
const setupId = ok(await call('/api/v0/tenants', { token: eaToken, payload: { name: 'ACMARK Closers' } }), 'start').id;
const company = { name: 'ACMARK Closers', slug: 'acmark-closers', code: 'ACMK', timeZone: AC_ZONE, dataRegion: 'in', host: AC_HOST, rehearsal: true };
let check = ok(await call(`/api/v0/tenants/${setupId}/company`, { token: eaToken, payload: { ...company, check: true } }), 'check').check;
assert.equal(check.ok, true, JSON.stringify(check));
assert.equal((await call('/api/v0/host', { host: AC_HOST })).data.own, true, 'a preview creates nothing: the address is still unclaimed');
check = ok(await call(`/api/v0/tenants/${setupId}/company`, { token: eaToken, payload: { ...company, slug: EA.slug, check: true } }), 'collision').check;
assert.equal(check.ok, false); assert.match(check.problems.join(' '), /already uses this short name/);
let setup = ok(await call(`/api/v0/tenants/${setupId}/company`, { token: eaToken, payload: company }), 'create').setup;
assert.equal(setup.org.status, 'setup'); assert.equal(setup.org.host, AC_HOST);
const acOrg = setup.org.id; assert.notEqual(acOrg, EA.org);
// Rerunning the step updates the same company, it never makes a second one.
setup = ok(await call(`/api/v0/tenants/${setupId}/company`, { token: eaToken, payload: company }), 'rerun').setup;
assert.equal(setup.org.id, acOrg);
let host = (await call('/api/v0/host', { host: AC_HOST })).data;
assert.deepEqual([host.own, host.signIn, host.status, host.name], [false, 'password', 'setup', 'ACMARK Closers']);
assert.equal((await call('/api/v0/me', { token: eaToken, host: AC_HOST })).status, 503, 'a company being set up serves nothing but its name and logo');

assert.equal((await call(`/api/v0/tenants/${setupId}/brand`, { token: eaToken, payload: { accent: '#ffee00' } })).status, 400, 'an accent white text cannot sit on is refused');
setup = ok(await call(`/api/v0/tenants/${setupId}/brand`, { token: eaToken, payload: { accent: '#1d4ed8' } }), 'accent');
const mark = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1d4ed8"/><text x="16" y="21" fill="#fff">AC</text></svg>';
setup = ok(await call(`/api/v0/tenants/${setupId}/brand`, { token: eaToken, payload: { kind: 'mark', mime: 'image/svg+xml', data: Buffer.from(mark).toString('base64') } }), 'mark');
assert.equal(setup.brand.accent, '#1d4ed8'); assert.equal(setup.brand.mark, true);
assert.equal((await call(`/api/v0/tenants/${setupId}/brand`, { token: eaToken, payload: { kind: 'mark', mime: 'image/svg+xml', data: Buffer.from('<svg><script>x</script></svg>').toString('base64') } })).status, 400);
assert.equal((await call(`/api/v0/tenants/${setupId}/brand/mark`, { token: eaToken })).body, mark, 'the operator previews the saved mark');

setup = ok(await call(`/api/v0/tenants/${setupId}/admin`, { token: eaToken, payload: { name: 'Datup ACMARK', email: 'datup@acmark.example.test', title: 'Founder' } }), 'admin');
assert.equal(setup.admin.invitation, 'prepared'); assert.match(setup.admin.username, /^datup\.acmark/);
assert.equal(setup.mail.sendEnabled, false);
r = await call(`/api/v0/tenants/${setupId}/invite`, { token: eaToken, payload: { action: 'send', confirmed: true } });
assert.equal(r.status, 403, 'nothing is e-mailed: sending is not configured here, and a rehearsal never sends');

const csv = 'Name,Email,Title,Pod,Team,Manager,Access\nZara ACMARK,zara@acmark.example.test,Setter,Setters,Sales,datup@acmark.example.test,\n'
  + 'Ishan ACMARK,ishan@acmark.example.test,Closer,Closers,Sales,Datup ACMARK,manager\nMeera ACMARK,meera@acmark.example.test,People partner,,People,,hr\n'
  + 'Datup ACMARK,datup@acmark.example.test,Founder,,,,\n,nobody@acmark.example.test,No name,,,,\n';
let people = ok(await call(`/api/v0/tenants/${setupId}/people`, { token: eaToken, payload: { source: 'csv', csv, apply: false } }), 'people preview');
assert.deepEqual([people.new, people.update, people.skip, people.applied], [3, 1, 1, false]);
assert.deepEqual(people.newPods.sort(), ['Closers', 'Setters']);
assert.equal((await call(`/api/v0/tenants/${setupId}`, { token: eaToken })).data.counts.people, 1, 'a preview writes nothing');
assert.equal((await call(`/api/v0/tenants/${setupId}/people`, { token: eaToken, payload: { source: 'workspace' } })).status, 409, 'no Workspace connector for this company');
people = ok(await call(`/api/v0/tenants/${setupId}/people`, { token: eaToken, payload: { source: 'csv', csv, apply: true } }), 'people apply');
setup = people.setup; assert.equal(setup.counts.people, 4);
people = ok(await call(`/api/v0/tenants/${setupId}/people`, { token: eaToken, payload: { source: 'csv', csv, apply: true } }), 'people rerun');
assert.equal(people.new, 0, 'importing the same file again adds nobody'); assert.equal(people.setup.counts.people, 4);
const byName = Object.fromEntries(people.setup.people.map((p) => [p.name, p]));
assert.deepEqual(byName['Meera ACMARK'].roles, ['hr']); assert.deepEqual(byName['Ishan ACMARK'].roles, ['manager']);
assert.equal(byName['Zara ACMARK'].managerId, byName['Datup ACMARK'].id);
setup = ok(await call(`/api/v0/tenants/${setupId}/structure`, { token: eaToken, payload: { ops: [{ op: 'pod', name: 'Leadership' }, { op: 'place', personId: byName['Datup ACMARK'].id, pod: 'Leadership', team: 'Leadership' }, { op: 'role', personId: byName['Datup ACMARK'].id, role: 'leadership', grant: true }] } }), 'structure');
assert.equal(setup.counts.pods, 3);
assert.equal((await call(`/api/v0/tenants/${setupId}/structure`, { token: eaToken, payload: { ops: [{ op: 'role', personId: EA.ids.person, role: 'admin', grant: true }] } })).status, 400, 'the other company’s people cannot be placed');
assert.equal((await call(`/api/v0/tenants/${setupId}/structure`, { token: eaToken, payload: { ops: [{ op: 'role', personId: byName['Datup ACMARK'].id, role: 'admin', grant: false }] } })).status, 400, 'the company keeps an admin');
setup = ok(await call(`/api/v0/tenants/${setupId}/settings`, { token: eaToken, payload: { modules: { finance: false, chats: true, tasks: true, attendance: false }, rules: [{ role: 'member', action: 'task.assign', scope: 'pod' }] } }), 'settings');
assert.equal(setup.modules.finance, false);
assert.equal((await call(`/api/v0/tenants/${setupId}/settings`, { token: eaToken, payload: { rules: [{ role: 'member', action: 'task.assign', scope: 'anyone' }] } })).status, 400, 'a rule outside its limits is refused');

r = await call(`/api/v0/tenants/${setupId}/open`, { token: eaToken, payload: {} });
assert.equal(r.status, 409, 'the company does not open before the isolation check'); assert.match(r.data.error, /isolation check/);
const iso = ok(await call(`/api/v0/tenants/${setupId}/check`, { token: eaToken, payload: {} }), 'isolation check');
assert.deepEqual(iso.leaks, [], 'reading every company table as the new company finds nothing of another company');
assert.ok(iso.tables > 100, `tables read: ${iso.tables}`);
setup = ok(await call(`/api/v0/tenants/${setupId}/open`, { token: eaToken, payload: {} }), 'open');
assert.equal(setup.org.status, 'active'); assert.equal(setup.people, null, 'once open, the operator sees counts, not people');
assert.equal((await call(`/api/v0/tenants/${setupId}/people`, { token: eaToken, payload: { source: 'csv', csv, apply: true } })).status, 403, 'once open, setup writes stop');
const link = ok(await call(`/api/v0/tenants/${setupId}/invite`, { token: eaToken, payload: { action: 'link', confirmed: true } }), 'private link');
assert.ok(link.link.startsWith(`https://${AC_HOST}/login/set-password#`), link.link);
const linkToken = new URL(link.link).hash.slice(1);
const list = ok(await call('/api/v0/tenants', { token: eaToken }), 'companies list').companies;
// The operator also sees migrated companies, including worlds created by earlier tests in this DB cell.
assert.equal(list[0].own, true); assert.equal(list.filter((c) => c.own).length, 1);
const created = list.filter((c) => c.setupId === setupId);
assert.equal(created.length, 1); assert.equal(created[0].people, 4);
const migrated = list.filter((c) => c.code === EA.migratedCode);
assert.equal(migrated.length, 1, 'a company without a wizard record is listed exactly once');
assert.equal(migrated[0].own, false); assert.ok(migrated[0].setupId); assert.equal(migrated[0].people, 4);
assert.ok(!JSON.stringify(list).includes('Zara'), 'the list has counts only');

// 3. The new company's admin, at its own address only.
assert.equal((await call('/api/v0/auth/set-password', { payload: { token: linkToken, password: 'ACMARK-admin-2026!' } })).status, 400, 'the link does not work on the install company’s address');
r = await call('/api/v0/auth/set-password', { host: AC_HOST, payload: { token: linkToken, password: 'ACMARK-admin-2026!' } });
const acToken = ok(r, 'AC admin sets a password').token;
const acMe = ok(await call('/api/v0/me', { token: acToken, host: AC_HOST }), 'AC me');
assert.deepEqual([acMe.org, acMe.role, acMe.name, acMe.operator, acMe.companyModules.finance], [acOrg, 'admin', 'Datup ACMARK', false, false]);
assert.equal((await call('/api/v0/finance/desk', { token: acToken, host: AC_HOST })).status, 403, 'finance is off for this company');
assert.equal((await call('/api/v0/tenants', { token: acToken, host: AC_HOST })).status, 403, 'another company’s admin is not the platform operator');
// Datup creates a project and gives his people tasks.
const project = ok(await call('/api/v0/work/projects', { token: acToken, host: AC_HOST, payload: { type: 'internal', name: 'ACMARK Project', memberIds: [byName['Zara ACMARK'].id, byName['Ishan ACMARK'].id] } }), 'AC project');
const projectId = project.id ?? project.projectId;
assert.ok(projectId, JSON.stringify(project));
const task1 = ok(await call('/api/v0/tasks', { token: acToken, host: AC_HOST, payload: { title: 'ACMARK task: call the warm leads', assigneeId: byName['Zara ACMARK'].id, projectId, dueOn: '2026-10-20' } }), 'AC task 1');
const task2 = ok(await call('/api/v0/tasks', { token: acToken, host: AC_HOST, payload: { title: 'ACMARK task: close the Friday demos', assigneeId: byName['Ishan ACMARK'].id, projectId } }), 'AC task 2');
const acTasks = ok(await call(`/api/v0/tasks?project=${projectId}`, { token: acToken, host: AC_HOST }), 'AC tasks');
assert.ok(JSON.stringify(acTasks).includes('ACMARK task: call the warm leads'));
assert.equal((await call('/api/v0/tasks', { token: acToken, host: AC_HOST, payload: { title: 'ACMARK task for an EA person', assigneeId: EA.ids.person } })).status >= 400, true, 'nobody of the other company can be given work');

// R51: each company's days are its own. AC's task due on the 20th is due at 18:00 in Pago Pago (05:00 UTC on the 21st,
// India's 21st) and still reads as the 20th; EA's (India) reads as before. "Today" is each company's own date.
const acDue = JSON.stringify(ok(await call(`/api/v0/tasks/${task1.id}`, { token: acToken, host: AC_HOST }), 'AC task'));
assert.ok(acDue.includes('"dueOn":"2026-10-20"') && acDue.includes('"dueAt":"2026-10-21T05:00:00.000Z"'), `AC's due day is its own: ${acDue.slice(0, 600)}`);
const eaTask = ok(await call('/api/v0/tasks', { token: eaToken, payload: { title: 'EAMARK task: zone check', assigneeId: EA.ids.person, dueOn: '2026-10-20' } }), 'EA task');
const eaDue = JSON.stringify(ok(await call(`/api/v0/tasks/${eaTask.id}`, { token: eaToken }), 'EA task read'));
assert.ok(eaDue.includes('"dueOn":"2026-10-20"') && eaDue.includes('"dueAt":"2026-10-20T12:30:00.000Z"'), `EA keeps India's 18:00: ${eaDue.slice(0, 600)}`);
for (const [who, token, host, zone] of [['AC', acToken, AC_HOST, AC_ZONE], ['EA', eaToken, undefined, 'Asia/Kolkata']]) {
  const home = ok(await call('/api/v0/tasks/home', { token, host }), `${who} tasks home`);
  assert.equal(home.today, zoneDay(zone), `${who}'s today is its own date`);
  const companion = ok(await call('/api/v0/companion', { token, host }), `${who} companion`);
  assert.deepEqual([companion.timezone, companion.today], [zone, zoneDay(zone)], `${who}'s phone and desktop clock is its company's`);
  const rules = ok(await call('/api/v0/hr/rules', { token, host }), `${who} HR rules`);
  assert.deepEqual([rules.today, rules.proposals.half_day.timezone], [zoneDay(zone), zone], `${who}'s HR rules count in its zone`);
}

// 4. Crossing addresses: sessions, Access headers and device tokens belong to one company.
assert.equal((await call('/api/v0/me', { token: eaToken, host: AC_HOST })).status, 401, 'an EA session does not exist at AC’s address');
assert.equal((await call('/api/v0/me', { token: acToken })).status, 401, 'an AC session does not exist at EA’s address');
assert.equal((await call('/api/v0/me', { host: AC_HOST, headers: { 'cf-access-authenticated-user-email': EA.accessEmail } })).status, 401, 'an Access header is ignored at a company’s own address');
assert.equal((await call('/api/v0/me', { headers: { 'cf-access-authenticated-user-email': EA.accessEmail } })).status, 200, 'the install company keeps Access sign-in');
const deviceToken = randomBytes(32).toString('base64url');
// A paired phone of AC's admin, as the pairing flow leaves it: the API role, inside AC, with the admin as viewer.
{
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [acOrg, byName['Datup ACMARK'].id]);
    const dev = (await c.query("insert into pulse.native_device(org_id,person_id,name,platform) values ($1,$2,'Synthetic phone','android') returning id", [acOrg, byName['Datup ACMARK'].id])).rows[0].id;
    await c.query('select pulse.native_token_issue($1,$2,$3)', [dev, createHash('sha256').update(deviceToken).digest('hex'), createHash('sha256').update(randomBytes(32)).digest('hex')]);
    await c.query('commit');
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
assert.equal((await call('/api/v0/me', { bearer: deviceToken, host: AC_HOST })).status, 200, 'the device token works at its company’s address');
assert.equal((await call('/api/v0/me', { bearer: deviceToken })).status, 401, 'and not at the other company’s');
const acBrand = (await call('/api/v0/brand', { host: AC_HOST })).data, eaBrand = (await call('/api/v0/brand')).data;
assert.equal(acBrand.name, 'ACMARK Closers'); assert.equal(acBrand.accent, '#1d4ed8'); assert.equal(eaBrand.name, EA.name); assert.notEqual(eaBrand.accent, '#1d4ed8');

// 5. Every route, both ways. Ids in the path are the other company's; responses may not name it; its rows stay put.
const acIds = { org: acOrg, people: Object.values(byName).map((p) => p.id), project: projectId, tasks: [task1.id, task2.id] };
const markers = {
  ea: [EA.org, ...EA.ids.people, EA.ids.project, EA.ids.client, EA.ids.task, EA.ids.chat, EA.name, 'EAMARK'],
  ac: [acOrg, ...acIds.people, projectId, task1.id, task2.id, 'ACMARK'],
};
// EA's editor has a photo and EA has a group chat (both carry EAMARK): downloads and chat reads by id are swept too.
const idsOf = { ea: [EA.ids.person, EA.ids.project, EA.ids.client, EA.ids.task, EA.ids.chat], ac: [acIds.people[0], projectId, task1.id, acOrg] };
const skip = (p) => /^\/api\/v0\/(?:portal\/)?auth\/(sign-in|forgot|forgot-username|set-password|two-step|confirm-email|link-sign-in|sign-out)$/.test(p)
  || ['/healthz', '/api/v0/chats/events', '/api/v0/native/refresh', '/api/v0/native/pair/start', '/api/v0/native/pair/poll'].includes(p)
  || p.includes('/webhook/') || p.startsWith('/api/v0/policy-editor/') || p.startsWith('/api/v0/accept/')
  // The operator's own setup routes name the company it set up: checked above (counts only once open).
  || p.startsWith('/api/v0/tenants')
  // A test ping (once a minute per person) is sent and checked on purpose in step 7.
  || p === '/api/v0/companion/notification-test';
const fill = (p, id) => p.replace(/:id\b/g, id).replace(':kind', 'logo').replace(':code', 'HDFC0000001').replace(':token', 'synthetic-invalid-token').replace(':file', 'synthetic-missing-file')
  .replace(':account', 'unlinked@example.test').replace(':entity', 'project').replace(':source', id).replace(':binding', id).replace(':flag', id).replace(/:[a-zA-Z]+/g, id);
async function counts(org) {
  const c = await pool.connect();
  try {
    await c.query('begin read only'); await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id','',true)", [org]);
    const out = {};
    for (const t of (await c.query('select pulse.tenant_tables() t')).rows.map((x) => x.t)) {
      await c.query('savepoint s');
      try { out[t] = Number((await c.query(`select count(*) n from ${t}`)).rows[0].n); await c.query('release savepoint s'); } catch { await c.query('rollback to savepoint s'); }
    }
    await c.query('rollback'); return out;
  } finally { c.release(); }
}
const leaks = []; let swept = 0;
const CLEAN = '00000000-0000-4000-8000-00000000abcd';
// Four passes per company. Clean: ids in the path belong to nobody, and nothing of the other company may appear. Guessed:
// the other company's ids in the path: nothing of it may appear except the ids the caller typed (a company's own audit
// log rightly lists the addresses its admin opened). R51 search: every GET without an id, asked for the start of the
// other company's marker (so an echo of the question is not a find). R51 body: every POST names the other company in its
// body; the company comes from the address and the sign-in, never from the body.
// Guessed runs last: afterwards a company's own audit log rightly lists the other company's ids its admin typed.
const near = { ea: 'EAMAR', ac: 'ACMAR' };
async function sweep(side, token, hostName, other, mode) {
  const typed = new Set(mode === 'guessed' ? idsOf[other] : mode === 'body' ? [markers[other][0]] : []);
  const look = markers[other].filter((m) => !typed.has(m));
  for (const { method, url } of routes) {
    if (skip(url)) continue;
    if (mode === 'search' && (method !== 'GET' || url.includes(':'))) continue;
    if (mode === 'body' && method !== 'POST') continue;
    const ids = mode === 'guessed' ? (url.includes(':') ? idsOf[other] : []) : [url.includes(':') ? CLEAN : null];
    for (const id of ids) {
      const target = mode === 'search' ? `${url}?q=${near[other]}&query=${near[other]}&search=${near[other]}` : id ? fill(url, id) : url;
      const org = markers[other][0];
      const payload = method !== 'POST' ? undefined : mode === 'body' ? { orgId: org, org_id: org, org, companyId: org, tenant: org } : {};
      const res = await call(target, { token, host: hostName, method, payload });
      swept++;
      // The payroll-processed gate is closed on purpose (R27: 503 for every role), as in the access matrix.
      assert.ok(res.status < 500 || (url === '/api/v0/notifications/payroll-processed' && res.status === 503), `${side} ${method} ${target}: ${res.status} ${res.body.slice(0, 300)}`);
      for (const m of look) if (res.body.includes(m)) leaks.push({ side, mode, method, route: url, marker: m === EA.name ? 'EA name' : m.length === 36 ? 'an id of the other company' : m });
    }
  }
}
const eaBefore = await counts(EA.org);
for (const mode of ['clean', 'search', 'body', 'guessed']) await sweep('AC', acToken, AC_HOST, 'ea', mode);
const eaAfter = await counts(EA.org);
const acBefore = await counts(acOrg);
for (const mode of ['clean', 'search', 'body', 'guessed']) await sweep('EA', eaToken, undefined, 'ac', mode);
const acAfter = await counts(acOrg);
assert.deepEqual(leaks, [], 'no response names the other company');
const changed = (a, b) => Object.keys(a).filter((t) => a[t] !== b[t]);
assert.deepEqual(changed(eaBefore, eaAfter), [], 'AC’s requests changed no EA rows');
// EA's requests may write EA's own audit and session rows; none of AC's tables may move.
assert.deepEqual(changed(acBefore, acAfter), [], 'EA’s requests changed no AC rows');
// The operator's view after the sweep still has counts only.
assert.equal((await call(`/api/v0/tenants/${setupId}`, { token: eaToken })).data.people, null);

// 6. R51: a company's own admin gets no private payroll or private conversation by default. Datup was given leadership
// on purpose above (leadership reads pay by role, as at EA), so Ishan is made a plain admin here and signs in himself:
// no named salary or contact permission, no money grant, and a direct conversation between two colleagues stays theirs.
const worker = new Pool(JSON.parse(process.env.TEST_WORKER_CONFIG));
async function inCompany(org, run, viewer = '') {
  const c = await (viewer ? pool : worker).connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [org, viewer]); const r = await run(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
const zara = byName['Zara ACMARK'].id, ishan = byName['Ishan ACMARK'].id, meera = byName['Meera ACMARK'].id, datup = byName['Datup ACMARK'].id;
const direct = await inCompany(acOrg, async (c) => {
  await c.query("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values($1,$2,'admin','2020-01-01')", [acOrg, ishan]);
  const ch = (await c.query("insert into pulse.chat_channel(org_id,key,name,kind) values($1,'direct:acmark-private','ACMARK direct','direct') returning id", [acOrg])).rows[0].id;
  for (const p of [zara, meera]) await c.query('insert into pulse.chat_member(org_id,channel_id,person_id) values($1,$2,$3)', [acOrg, ch, p]);
  await c.query("insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values($1,$2,$3,'ACMARK private: only Zara and Meera read this',gen_random_uuid())", [acOrg, ch, zara]);
  return ch;
});
// Datup issues Ishan a temporary password, as an admin does under Account access; Ishan changes it at first sign-in.
const ishanLogin = await inCompany(acOrg, async (c) => {
  await c.query("select pulse.login_issue($1,'ACMARK-issued-2026!')", [ishan]);
  return (await c.query('select username from pulse.people_profile where person_id=$1', [ishan])).rows[0].username;
}, datup);
const ishanToken = ok(await call('/api/v0/auth/sign-in', { host: AC_HOST, payload: { username: ishanLogin, password: 'ACMARK-issued-2026!' } }), 'Ishan signs in').token;
ok(await call('/api/v0/auth/change-password', { token: ishanToken, host: AC_HOST, payload: { current: 'ACMARK-issued-2026!', next: 'ACMARK-ishan-2026!' } }), 'Ishan password');
assert.equal(ok(await call('/api/v0/me', { token: ishanToken, host: AC_HOST }), 'Ishan me').role, 'admin');
assert.equal((await call('/api/v0/hr/payroll', { token: ishanToken, host: AC_HOST })).status, 403, 'a company admin does not read salaries by default');
for (const url of [`/api/v0/chats/${direct}/messages`, '/api/v0/chats', '/api/v0/chats/search?q=only%20Zara']) {
  const r = await call(url, { token: ishanToken, host: AC_HOST });
  assert.ok(!r.body.includes('only Zara and Meera') && (url.includes('search') || !r.body.includes(direct) || r.status >= 400), `${url}: a direct conversation is not the admin's (${r.status})`);
}
const can = await inCompany(acOrg, async (c) => (await c.query("select pulse.hr_can('hr.salary.read') salary,pulse.hr_can('hr.contact.read') contact,pulse.money_can('money.read') money,pulse.chat_has($1) direct", [direct])).rows[0], ishan);
assert.deepEqual(can, { salary: false, contact: false, money: false, direct: false }, 'the database agrees: no salary, contact, money or direct chat for a plain company admin');

// 7. R51: pushes and phones. Each company's phone gets its own company's test ping and nothing else, and neither company
// can re-point the other's phone. The worker's real drain runs over both companies.
const eaDevice = ok(await call('/api/v0/devices', { token: eaToken, payload: { platform: 'android', name: 'EAMARK phone' } }), 'EA device').id;
const acDevice = ok(await call('/api/v0/devices', { token: acToken, host: AC_HOST, payload: { platform: 'android', name: 'ACMARK phone' } }), 'AC device').id;
const pushToken = { ea: `EAMARK-push-${randomBytes(12).toString('hex')}`, ac: `ACMARK-push-${randomBytes(12).toString('hex')}` };
ok(await call(`/api/v0/devices/${eaDevice}/push`, { token: eaToken, payload: { token: pushToken.ea } }), 'EA push token');
ok(await call(`/api/v0/devices/${acDevice}/push`, { token: acToken, host: AC_HOST, payload: { token: pushToken.ac } }), 'AC push token');
// The other company's phone does not exist for the caller: the route answers as for any unseen device (a no-op under
// row-level security), and the phone keeps its own token.
await call(`/api/v0/devices/${eaDevice}/push`, { token: acToken, host: AC_HOST, payload: { token: 'ACMARK-hijack-000000000000' } });
await call(`/api/v0/devices/${acDevice}/push`, { token: eaToken, payload: { token: 'EAMARK-hijack-000000000000' } });
for (const [org, device, kept] of [[EA.org, eaDevice, pushToken.ea], [acOrg, acDevice, pushToken.ac]]) {
  assert.equal(await inCompany(org, async (c) => (await c.query('select push_token t from pulse.native_device where id=$1', [device])).rows[0].t), kept, 'neither company can re-point the other\'s phone');
}
ok(await call('/api/v0/companion/notification-test', { token: eaToken, payload: {} }), 'EA test ping');
ok(await call('/api/v0/companion/notification-test', { token: acToken, host: AC_HOST, payload: {} }), 'AC test ping');
const pushed = [];
await drainNotificationChannel(worker, 'native', async (payload) => { pushed.push(payload); return 'accepted'; });
assert.deepEqual([...new Set(pushed.map((p) => p.destination?.token))].sort(), [pushToken.ac, pushToken.ea].sort(), `each phone got its ping: ${pushed.length}`);
const peopleOf = { ea: new Set(EA.ids.people), ac: new Set(acIds.people) };
for (const p of pushed) {
  const side = p.destination.token === pushToken.ea ? 'ea' : 'ac', other = side === 'ea' ? 'ac' : 'ea';
  assert.ok(peopleOf[side].has(p.personId), `${side}'s phone carries only ${side}'s person`);
  assert.ok(!JSON.stringify(p).includes(other === 'ea' ? 'EAMARK' : 'ACMARK') && !markers[other].some((m) => JSON.stringify(p).includes(m)), `${side}'s push names nothing of ${other}`);
}

// 8. R53: AC was set up from a plan and opened in trial. Its own admin follows the checklist; a member gets no sign-in
// until the operator activates the company, and activation is refused while a gate is open. Nothing is sent.
const acSetup = ok(await call('/api/v0/company-setup', { token: acToken, host: AC_HOST }), 'AC checklist');
assert.equal(acSetup.managed, true); assert.equal(acSetup.company.activation, 'trial'); assert.equal(acSetup.company.prefix, `orgs/${acOrg}/`);
assert.ok(acSetup.guide.some((s) => s.key === 'admin' && s.who === 'Company admin' && s.href === '/account'));
assert.ok(!markers.ea.some((m) => JSON.stringify(acSetup).includes(m)), 'the company sees nothing of the install company');
assert.deepEqual(ok(await call('/api/v0/company-setup', { token: eaToken }), 'EA checklist'), { managed: false });
assert.equal((await call('/api/v0/company-setup/sources', { token: acToken, host: AC_HOST, payload: { key: 'people-csv', kind: 'csv', label: 'People list', categories: ['people'] } })).status, 200);
assert.equal((await call('/api/v0/company-setup/sources', { token: ishanToken, host: AC_HOST, payload: { key: 'second', kind: 'csv', label: 'Second list' } })).status, 200, 'any company admin registers');
await assert.rejects(inCompany(acOrg, async (c) => c.query("select pulse.login_issue($1,'ACMARK-issued-2026!')", [zara]), datup), /still in its trial/);
const blocked = await call(`/api/v0/tenants/${setupId}/activate`, { token: eaToken, payload: { confirmed: true } });
assert.equal(blocked.status, 409); assert.match(blocked.data.error, /two-step verification/);
assert.equal((await call(`/api/v0/tenants/${setupId}/handover`, { token: eaToken, payload: {} })).status, 400);
const handed = ok(await call(`/api/v0/tenants/${setupId}/handover`, { token: eaToken, payload: { support: 'ACMARK support desk in Pulse Help' } }), 'handover');
assert.equal(handed.activation.handover.supportRoute, 'ACMARK support desk in Pulse Help');
assert.equal(ok(await call(`/api/v0/tenants/${setupId}/plan`, { token: eaToken }), 'setup file').spec.company.host, AC_HOST);
for (const url of [`/api/v0/tenants/${setupId}/handover`, `/api/v0/tenants/${setupId}/activate`, `/api/v0/tenants/${setupId}/plan`]) {
  assert.equal((await call(url, { token: acToken, host: AC_HOST, payload: { confirmed: true, support: 'x' } })).status, 403, `${url}: the operator's only`);
}
// 9. R54: the trial's pilot over HTTP. AC's admin records a device check and answers the feedback once; the operator
// reads an explicit readiness result that calls a rehearsal a rehearsal; neither side reaches the other's.
const piloted = ok(await call('/api/v0/company-setup/pilot-checks', { token: acToken, host: AC_HOST, payload: { kind: 'device', platform: 'android', evidence: 'mock', result: 'passed', covers: ['pair'], note: 'ACMARK synthetic phone' } }), 'pilot check');
assert.equal(piloted.pilot.platforms, 1); assert.equal(piloted.readiness.rehearsal, true);
assert.equal((await call('/api/v0/company-setup/pilot-checks', { token: acToken, host: AC_HOST, payload: { kind: 'walkthrough', evidence: 'mock', result: 'passed', covers: ['people'] } })).status, 403, 'HR alone signs off the walkthrough');
const ready = ok(await call(`/api/v0/tenants/${setupId}/readiness`, { token: eaToken }), 'readiness');
assert.equal(ready.readiness.verdict, 'not_ready'); assert.match(ready.readiness.title, /^Rehearsal not ready: \d+ of 9 gates open$/);
assert.match(ready.readiness.summary, /not a live company launch/);
assert.ok(!JSON.stringify(ready).includes('ACMARK synthetic phone'), 'the operator sees evidence kinds, not the company\'s notes');
assert.equal((await call(`/api/v0/tenants/${setupId}/readiness`, { token: acToken, host: AC_HOST })).status, 403, 'the readiness result is the operator\'s');
assert.equal(ok(await call('/api/v0/pilot-feedback', { token: acToken, host: AC_HOST }), 'feedback').open, true);
assert.equal(ok(await call('/api/v0/pilot-feedback', { token: acToken, host: AC_HOST, payload: { effort: 4, fair: 4, calm: 5, easy: 4 } }), 'answer').given, true);
assert.equal((await call('/api/v0/pilot-feedback', { token: acToken, host: AC_HOST, payload: { effort: 4, fair: 4, calm: 5, easy: 4 } })).status, 409, 'answered once');
assert.equal(ok(await call('/api/v0/pilot-feedback', { token: eaToken }), 'EA feedback').open, false);
assert.equal((await call('/api/v0/pilot-feedback', { token: eaToken, payload: { effort: 4, fair: 4, calm: 5, easy: 4 } })).status, 400, 'the install company has no pilot');
assert.equal(await inCompany(acOrg, async (c) => (await c.query("select count(*)::int n from pulse_priv.staff_invitation where status in ('sending','sent')")).rows[0].n), 0, 'nothing was e-mailed');
await worker.end();

await writeFile(process.env.TEST_REPORT, JSON.stringify({ routes: routes.length, swept, calls, tables: Object.keys(eaBefore).length, isolationTables: iso.tables, acOrg, acZone: AC_ZONE, project: projectId, tasks: 2, pushed: pushed.length }));
await app.close(); await pool.end();
