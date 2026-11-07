// FLOW-E acceptance against the built API on the synthetic agency (tests/core/test_flow.py::test_flow_industry_apps):
// industry packs (words, roles, starter processes, record types; applied twice adds nothing; only leadership), roles as
// data (any name, holders, a person with two roles, steps landing on a role's holder with nobody named on the run, the
// home's tiles and My steps by role, the screens a role uses), apps as App actions (statuses, a process's own address
// another app posts to, a signed webhook out to a local receiver, a calendar event, the project's Drive folder and a file,
// a message opened in WhatsApp), and a new company set up by the operator with a pack.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';

process.env.PULSE_FLOW_WEBHOOK_LOCAL = '1';   // the local receiver below stands in for another app
const { createApp } = await import('../dist/app.js');
const P = JSON.parse(process.env.TEST_PEOPLE); const domain = process.env.TEST_DOMAIN; const org = process.env.PULSE_ORG_ID;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
const worker = new Pool(JSON.parse(process.env.TEST_WORKER_CONFIG));
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const call = async (who, url, payload, method = payload ? 'POST' : 'GET') => {
  const r = await app.inject({ url, method, headers: { ...(who ? { 'cf-access-authenticated-user-email': `${who}@${domain}` } : {}), 'x-pulse-client-ip': crypto.randomUUID() }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const must = async (who, url, payload) => { const r = await call(who, url, payload); assert.equal(r.status, 200, `${who} ${url}: ${JSON.stringify(r.data).slice(0, 500)}`); checks++; return r.data; };
const run = (rid) => must('kedab', `/v1/flow/runs/${rid}`);
const st = (d, key) => d.steps.find((s) => s.key === key);
const sql = async (q, params = [], p = pool, o = org) => { const c = await p.connect(); try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [o, P.kedab]); const r = await c.query(q, params); await c.query('commit'); return r.rows; } finally { c.release(); } };
const S = (id, block, module, title, more = {}) => ({ id, block, module, title, who: { by: 'starter' }, settings: {}, pos: { x: 0, y: 0 }, ...more });
const W = (a, ap, b) => ({ from: { step: a, port: ap }, to: { step: b, port: 'in' } });
async function live(name, definition) { const { id } = await must('kedab', '/v1/flow/processes', { name, definition }); await must('kedab', `/v1/flow/processes/${id}/publish`, {}); return id; }
const def = (steps, wires, more = {}) => ({ version: 2, fields: [], roles: [], stages: [], rules: [], steps, wires, ...more });

// Another app, here: it keeps what Pulse posts and answers.
const got = [];
const receiver = createServer((req, res) => { let b = ''; req.on('data', (x) => { b += x; }); req.on('end', () => { got.push({ headers: req.headers, body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: true, ticket: 'T-42' })); }); });
await new Promise((done) => receiver.listen(0, '127.0.0.1', done));
const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

try {
  // ---------------------------------------------------------------------------------------- industry packs
  let r = await must('kabir', '/v1/flow/packs');
  eq(r.packs.map((p) => p.key), ['neutral', 'real_estate_marketing', 'solar', 'marketing_agency', 'consulting', 'clinic', 'real_estate_developer']);
  ok(r.packs.find((p) => p.key === 'neutral').processes.length === 0, 'neutral brings no process');
  eq(r.packs.find((p) => p.key === 'solar').words.run, 'Job');
  eq((await call('kabir', '/v1/flow/setup/pack', { pack: 'solar' })).status, 403, 'members do not choose the industry');
  let added = (await must('kedab', '/v1/flow/setup/pack', { pack: 'solar' })).added;
  eq([added.roles, added.recordTypes, added.blocks > 0], [5, 2, true], JSON.stringify(added));
  added = (await must('kedab', '/v1/flow/setup/pack', { pack: 'solar' })).added;
  eq([added.roles, added.recordTypes, added.blocks, added.processes.length], [0, 0, 0, 0], 'applying it again adds nothing');
  let setup = await must('kedab', '/v1/flow/setup');
  eq([setup.pack.key, setup.words.client, setup.words.project, setup.words.runs], ['solar', 'Customer', 'Site', 'Jobs']);
  ok((await must('kabir', '/v1/flow/record-types')).recordTypes.some((t) => t.key === 'site' && !t.builtin), 'the pack brought its record types');
  const me = await must('kabir', '/api/v0/me');
  eq([me.workLabels.clients, me.workLabels.clientProjects, me.words.run], ['Customers', 'Sites', 'Job'], 'the menu says the company\'s words');
  r = await must('kedab', '/v1/flow/templates'); eq([r.templates[0].key, r.templates[0].ours, r.templates[0].pack.name], ['solar_install', true, 'Solar installer'], 'the company\'s industry first');
  // The words stay editable.
  setup = await must('kedab', '/v1/flow/setup/words', { words: { run: 'Install', runs: 'Installs' } }); eq(setup.words.run, 'Install');
  const procs = (await must('kedab', '/v1/flow/processes')).processes; ok(procs.some((p) => p.name === 'Solar install' && p.status !== 'live'), 'the starter process is a draft');

  // ---------------------------------------------------------------------------------------- roles as data
  const role = (k) => setup.roles.find((x) => x.key === k);
  eq(setup.roles.map((x) => x.name), ['Sales executive', 'Site surveyor', 'Install team lead', 'Accounts', 'Owner']);
  eq((await call('kabir', `/v1/flow/roles/${role('sales').id}/holders`, { personId: P.asha })).status, 403, 'members do not name role holders');
  for (const [k, p, who] of [['sales', P.asha, 'kedab'], ['surveyor', P.ravi, 'hr'], ['installer', P.ravi, 'kedab'], ['accounts', P.hr, 'kedab'], ['owner', P.kedab, 'kedab']])
    setup = await must(who, `/v1/flow/roles/${role(k).id}/holders`, { personId: p });
  ok(role('surveyor') && setup.roles.find((x) => x.key === 'surveyor').holders.some((h) => h.id === P.ravi), 'HR names who holds a role');
  setup = await must('kedab', '/v1/flow/roles', { name: 'Field quality checker', screens: ['work', 'map', 'finance'], home: 'dashboard' });
  const qc = setup.roles.find((x) => x.name === 'Field quality checker'); eq([qc.key, qc.screens], ['field_quality_checker', ['work', 'map', 'finance']]);
  await must('kedab', `/v1/flow/roles/${qc.id}/holders`, { personId: P.kabir });
  // Kabir's access role (a member) does not see Finance unless the company hides it for members; his work role uses it.
  await must('admin', '/api/v0/settings/screens', { newScreensHidden: false, hidden: { person: ['finance', 'map'] } });
  let kab = await must('kabir', '/api/v0/me'); eq([kab.workRoles, kab.hiddenScreens.keys.includes('finance'), kab.hiddenScreens.keys.includes('map')], [['Field quality checker'], false, false], 'a role\'s screens show for its people');
  await must('kedab', `/v1/flow/roles/${qc.id}`, { archive: true }); kab = await must('kabir', '/api/v0/me'); ok(kab.hiddenScreens.keys.includes('finance'), 'a removed role shows nothing more');
  await must('admin', '/api/v0/settings/screens', { newScreensHidden: false, hidden: {} });
  const ravi = await must('ravi', '/api/v0/me'); eq(ravi.workRoles, ['Site surveyor', 'Install team lead'], 'a person holds two roles');

  // A step given to a role lands on its holder, with nobody named on the run.
  const form = (await must('kedab', '/api/v0/forms', { name: 'Roof survey (FLOW-E)', fields: [{ key: 'notes', label: 'Notes', type: 'text', required: true }] })).id;
  await must('kedab', `/api/v0/forms/${form}/status`, { status: 'live' });
  const solar = procs.find((p) => p.name === 'Solar install');
  const sd = await must('kedab', `/v1/flow/processes/${solar.id}`);
  const sdef = { ...sd.definition, steps: sd.definition.steps.map((s) => (['site_visit', 'data_capture'].includes(s.module) ? { ...s, settings: { ...s.settings, formId: form } } : s)) };
  await must('kedab', `/v1/flow/processes/${solar.id}`, { definition: sdef }); await must('kedab', `/v1/flow/processes/${solar.id}/publish`, {});
  let rid = (await must('kedab', `/v1/flow/processes/${solar.id}/runs`, { name: 'Kireteso rooftop', fields: { system_kw: 5, roof: 'rcc', subsidy: false } })).id;
  let d = await run(rid);
  eq([d.terms.run, st(d, 's2').who?.id, st(d, 's3').who?.id], ['Job', P.asha, P.ravi], 'the sales call and the site visit went to the roles\' holders');
  // Ravi's home: both his roles, each with its tiles; My steps says which role each step came as.
  const home = await must('ravi', '/v1/flow/home');
  eq(home.roles.map((x) => x.name), ['Site surveyor', 'Install team lead']);
  ok(home.roles[0].tiles.find((t) => t.key === 'visits').count === 1, JSON.stringify(home.roles[0].tiles));
  eq(home.roles.map((x) => x.tiles.find((t) => t.key === 'mine').count), [1, 0], 'each step counts under the role it came as');
  ok(home.steps.some((s) => s.key === 's3' && s.role === 'Site surveyor'), 'my step says it came as the surveyor');
  const mine = await must('ravi', '/v1/flow/my-steps'); ok(mine.steps.some((s) => s.role === 'Site surveyor'));
  ok((await must('asha', '/v1/flow/my-steps')).upcoming.some((s) => s.key === 's4'), 'the quotation is coming her way: she holds the sales role');
  eq((await must('ravi', '/v1/flow/records', { type: 'site', runId: rid, data: { address: '12 Lake Road', roof: 'RCC' } })).record.type, 'site', 'a role holder adds the run\'s records');
  eq((await must('kedab', '/v1/flow/home')).roles.map((x) => x.name), ['Owner']);

  // ---------------------------------------------------------------------------------------- apps
  r = await must('asha', '/v1/flow/apps');
  eq(r.apps.map((x) => x.key), ['sales_xray', 'google_drive', 'google_calendar', 'gmail', 'whatsapp', 'meta_leads', 'web_forms', 'billing', 'webhook_out']);
  ok(r.apps.every((x) => x.status?.state && x.status.text && x.actions.every((y) => y.needs && y.gives)), 'every app says its status, needs and gives');
  eq([r.apps.find((x) => x.key === 'webhook_out').status.state, r.webhook], ['not_connected', null], 'members see no webhook address');
  const prim = (await must('kedab', '/v1/flow/modules')).primitives;
  for (const a of r.apps) for (const x of a.actions) ok(prim.find((p) => p.key === x.block)?.kinds.some((k) => k.key === x.kind), `${a.key}/${x.key} is a kind in the palette`);

  // Another app starts a process at its own address (signed out); an unknown address is 404.
  const hookP = await live('From the website', def([S('s1', 'start', 'start', 'A website enquiry', { settings: { trigger: 'webhook' } }), S('t', 'task', 'checklist', 'Call them back'), S('e', 'end', 'end', 'Done')],
    [W('s1', 'client', 't'), W('t', 'done', 'e')]));
  eq((await call('kabir', `/v1/flow/processes/${hookP}/hook`, { step: 's1' })).status, 403);
  eq((await call('kedab', `/v1/flow/processes/${hookP}/hook`, { step: 't' })).status, 400, 'only a Start that another app sends in has an address');
  const hook = await must('kedab', `/v1/flow/processes/${hookP}/hook`, { step: 's1' }); ok(hook.path.startsWith('/api/flow-hook/'));
  r = await call(null, `/v1/flow/hooks/${hook.token}`, { name: 'Gobap family', phone: '+91 90000 00000', interest: '3 kW rooftop' });
  eq(r.status, 200, JSON.stringify(r.data)); d = await run(r.data.run);
  eq([d.name, st(d, 't').state], ['Gobap family', 'open'], 'the post started a run');
  ok(d.values.some((x) => x.step === 's1' && x.value?.data?.interest === '3 kW rooftop'), 'what it sent is the start\'s value');
  eq((await call(null, `/v1/flow/hooks/${'b'.repeat(32)}`, {})).status, 404);
  const again = await must('kedab', `/v1/flow/processes/${hookP}/hook`, { step: 's1' });
  eq((await call(null, `/v1/flow/hooks/${hook.token}`, {})).status, 404, 'a new address stops the old one'); eq((await call(null, `/v1/flow/hooks/${again.token}`, {})).status, 200);

  // Gmail sends a step's e-mail only where this Pulse allows sending and the company switched it on.
  eq((await call('kedab', '/v1/flow/apps/gmail', { send: true })).status, 409, 'not on this Pulse'); eq((await call('kabir', '/v1/flow/apps/gmail', { send: false })).status, 403);
  eq((await must('kedab', '/v1/flow/apps')).mail, { server: false, company: false });
  // A signed webhook out; its reply is the step's output.
  eq((await call('kedab', '/v1/flow/apps/webhook', { url: 'https://10.0.0.1/x' })).status, 400, 'no private addresses');
  const conn = await must('kedab', '/v1/flow/apps/webhook', { url: hookUrl }); ok(/^[0-9a-f]{64}$/.test(conn.secret), 'leadership gets the signing secret');
  const outP = await live('Tell the CRM', def([S('s1', 'start', 'start', 'Start'), S('w', 'app', 'webhook', 'Tell the CRM'), S('e', 'end', 'end', 'Done')], [W('s1', 'client', 'w'), W('w', 'reply', 'e')]));
  rid = (await must('kedab', `/v1/flow/processes/${outP}/runs`, { name: 'Order 17' })).id; d = await run(rid);
  r = await must('kedab', `/v1/flow/steps/${st(d, 'w').id}/actions/send`, {});
  eq([r.ok, r.reply.status, r.reply.body.ticket], [true, 200, 'T-42']);
  const post = got.at(-1); const body = JSON.parse(post.body);
  eq([body.run.name, body.step.title], ['Order 17', 'Tell the CRM']);
  eq(post.headers['x-pulse-signature'], `sha256=${createHmac('sha256', conn.secret).update(post.body).digest('hex')}`, 'signed with the company\'s secret');
  d = await run(rid); eq(d.status, 'done', 'the reply finished the step and the run');

  // Calendar: a slot becomes an event; the project's Drive folder and a file; a WhatsApp opened, never sent by Pulse.
  const appP = await live('Visit, folder, message', def([S('s1', 'start', 'start', 'Start'), S('m', 'meet', 'schedule', 'Fix the visit'), S('c', 'app', 'calendar_event', 'Put it in the calendar', { settings: { title: 'Site visit · {run}' } }),
    S('f', 'app', 'drive_folder', 'The site folder'), S('g', 'app', 'drive_file', 'The roof plan'), S('w', 'app', 'message', 'Tell them we are coming', { settings: { channel: 'whatsapp', to: '+91 98765 43210', text: 'Hello {run}, we visit tomorrow.' } }), S('e', 'end', 'end', 'Done')],
  [W('s1', 'client', 'm'), W('m', 'slot', 'c'), W('c', 'event', 'f'), W('f', 'folder', 'g'), W('g', 'file', 'w'), W('w', 'sent', 'e')]));
  rid = (await must('kedab', `/v1/flow/processes/${appP}/runs`, { name: 'Sigemo' })).id; d = await run(rid);
  await must('kedab', `/v1/flow/steps/${st(d, 'm').id}/actions/slot`, { on: '2026-11-03', time: '10:30', place: 'Kothrud', people: ['ravi@example.test'] });
  d = await run(rid); r = await must('kedab', `/v1/flow/steps/${st(d, 'c').id}/actions/event`, {});
  ok(r.event.calendarUrl.startsWith('https://calendar.google.com/calendar/render?') && r.event.calendarUrl.includes('20261103T103000') && r.event.calendarUrl.includes('ravi%40example.test'), r.event.calendarUrl);
  ok(/DTSTART;TZID=Asia\/Kolkata:20261103T103000/.test(r.event.ics) && r.event.title === 'Site visit · Sigemo', r.event.ics);
  d = await run(rid); eq((await call('kedab', `/v1/flow/steps/${st(d, 'f').id}/actions/folder`, {})).status, 409, 'no project folder: it says so');
  eq((await call('kedab', `/v1/flow/steps/${st(d, 'f').id}/actions/folder`, { url: 'https://example.com/x' })).status, 400);
  r = await must('kedab', `/v1/flow/steps/${st(d, 'f').id}/actions/folder`, { url: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp' }); eq(r.folder.folderId, '1AbCdEfGhIjKlMnOp');
  d = await run(rid); r = await must('kedab', `/v1/flow/steps/${st(d, 'g').id}/actions/candidates`, {}); eq(r.folderId, '1AbCdEfGhIjKlMnOp', 'the file step looks in the folder the step before found');
  await must('kedab', `/v1/flow/steps/${st(d, 'g').id}/actions/pick`, { url: 'https://drive.google.com/file/d/9xyz/view', name: 'Roof plan.pdf' });
  d = await run(rid); r = await must('kedab', `/v1/flow/steps/${st(d, 'w').id}/actions/text`, {});
  eq([r.text, r.href, r.canSend], ['Hello Sigemo, we visit tomorrow.', 'https://wa.me/919876543210?text=Hello%20Sigemo%2C%20we%20visit%20tomorrow.', false]);
  eq((await call('kedab', `/v1/flow/steps/${st(d, 'w').id}/actions/send`, { to: 'x@example.test' })).status, 400, 'Pulse sends no WhatsApp');
  await must('kedab', `/v1/flow/steps/${st(d, 'w').id}/actions/sent`, {}); d = await run(rid); eq(d.status, 'done');

  // ---------------------------------------------------------------------------------------- a new company with a pack
  const setupId = (await must('admin', '/api/v0/tenants', { name: 'Arogya Clinics (FLOW-E)' })).id;
  eq((await call('admin', `/api/v0/tenants/${setupId}/pack`, { pack: 'clinic' })).status >= 400, true, 'no pack before the company exists');
  const made = await must('admin', `/api/v0/tenants/${setupId}/company`, { name: 'Arogya Clinics (FLOW-E)', slug: 'arogya-flow-e', code: 'AROG', timeZone: 'Asia/Kolkata', dataRegion: 'in', host: 'arogya-flow-e.example.test', rehearsal: true });
  const other = made.setup.org.id;
  const view = await must('admin', `/api/v0/tenants/${setupId}/pack`, { pack: 'clinic' }); eq(view.steps.pack.pack, 'clinic');
  eq((await call('kedab', `/api/v0/tenants/${setupId}/pack`, { pack: 'clinic' })).status, 403, 'only the operator sets up companies');
  const inside = await sql(`select (select pack_key from pulse.org_pack) pack,(select words->>'client' from pulse.org_pack) client,(select count(*)::int from pulse.work_role) roles,
    (select string_agg(name,',') from pulse.flow_process) processes,(select count(*)::int from pulse.flow_record_type) types`, [], worker, other);
  eq(inside[0], { pack: 'clinic', client: 'Patient', roles: 4, processes: 'Patient visit', types: 1 }, 'the pack is in the new company');
  const ours = await sql(`select (select pack_key from pulse.org_pack) pack,(select count(*)::int from pulse.flow_process where name='Patient visit') visits`, [], worker);
  eq(ours[0], { pack: 'solar', visits: 0 }, 'and nothing of it in ours');

  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks }));
  console.log(`flow-e-runner: ${checks} checks`);
} finally { receiver.close(); await pool.end(); await worker.end(); }
