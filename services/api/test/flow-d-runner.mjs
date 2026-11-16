// FLOW-D acceptance against the built API on the synthetic agency (tests/core/test_flow.py::test_flow_primitives): the
// primitives and company blocks, templates rebuilt from primitives, "Describe it", the vertical flow's order (a step
// after a skipped one still waits; a way not chosen skips every step on it), Decide by a rule, Message with values,
// Wait until a date, who is told, runs that start by themselves (a new lead, a form sent, a schedule), a Collect step
// finished by its form, Try it (later, thrown away), data wires on publish.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const P = JSON.parse(process.env.TEST_PEOPLE); const domain = process.env.TEST_DOMAIN; const org = process.env.PULSE_ORG_ID;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
const worker = new Pool(JSON.parse(process.env.TEST_WORKER_CONFIG));
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const call = async (who, url, payload, method = payload ? 'POST' : 'GET') => {
  const r = await app.inject({ url, method, headers: { 'cf-access-authenticated-user-email': `${who}@${domain}`, 'x-pulse-client-ip': crypto.randomUUID() }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const must = async (who, url, payload) => { const r = await call(who, url, payload); assert.equal(r.status, 200, `${who} ${url}: ${JSON.stringify(r.data).slice(0, 500)}`); checks++; return r.data; };
const run = (rid) => must('kedab', `/v1/flow/runs/${rid}`);
const st = (d, key) => d.steps.find((s) => s.key === key);
const states = (d, keys) => keys.map((k) => st(d, k).state);
const sql = async (q, params = [], p = pool) => { const c = await p.connect(); try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [org, P.kedab]); const r = await c.query(q, params); await c.query('commit'); return r.rows; } finally { c.release(); } };
const today = new Date().toISOString().slice(0, 10);
const plus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const S = (id, block, module, title, more = {}) => ({ id, block, module, title, who: { by: 'starter' }, settings: {}, pos: { x: 0, y: 0 }, ...more });
const W = (a, ap, b, more = {}) => ({ from: { step: a, port: ap }, to: { step: b, port: 'in' }, ...more });
async function live(name, definition) {
  const { id } = await must('kedab', '/v1/flow/processes', { name, definition });
  const pub = await must('kedab', `/v1/flow/processes/${id}/publish`, {}); ok(pub.version >= 1, `${name} published`);
  return id;
}

try {
  // ---------------------------------------------------------------------------------------- the palette: primitives
  let r = await must('kabir', '/v1/flow/modules');
  eq(r.primitives.map((p) => p.key), ['start', 'task', 'collect', 'meet', 'write', 'review', 'decide', 'wait', 'message', 'ai', 'app', 'repeat', 'end']);
  ok(r.primitives.every((p) => p.question && p.kinds.length && p.kinds.every((k) => r.modules.some((m) => m.key === k.module))), 'every kind is a module the engine has');
  const words = JSON.stringify(r.primitives).toLowerCase();
  for (const w of ['blueprint', 'persona', 'creative strategist', 'sell-out', 'solar', ' gs ', 'asset id']) ok(!words.includes(w), `no company word "${w}" in the primitives`);
  ok(r.modules.some((m) => m.key === 'message'), 'the message module');

  // ---------------------------------------------------------------------------------------- company blocks
  eq((await call('kabir', '/v1/flow/blocks', { name: 'x', step: S('a', 'task', 'checklist', 'x') })).status, 403, 'members do not design');
  const roof = (await must('kedab', '/v1/flow/blocks', { name: 'Roof survey', summary: 'Three photos', step: { ...S('a', 'collect', 'site_visit', 'Roof survey'), checklist: ['Roof', 'Meter', 'Shading'], due: { from: 'start', days: 2 } } })).block;
  eq([roof.block, roof.step.module, roof.step.checklist.length, roof.step.due.days], ['collect', 'site_visit', 3, 2]);
  ok(!('id' in roof.step) && !('pos' in roof.step), 'a preset keeps no place');
  r = await must('kedab', `/v1/flow/blocks/${roof.id}`, { name: 'Roof survey (3 photos)' }); eq(r.block.name, 'Roof survey (3 photos)');
  eq((await must('kabir', '/v1/flow/blocks')).blocks.length, 1);
  await must('kedab', `/v1/flow/blocks/${roof.id}`, { archive: true }); eq((await must('kedab', '/v1/flow/blocks')).blocks.length, 0, 'archived');

  // Templates are rebuilt from primitives and bring their own blocks.
  const ea = (await must('kedab', '/v1/flow/processes', { template: 'ea_creative' })).id;
  let p = await must('kedab', `/v1/flow/processes/${ea}`);
  ok(p.definition.steps.every((s) => s.block), 'every EA step is a primitive');
  ok(p.definition.wires.filter((w) => w.to.port === 'in').length >= 40, 'the order is "Starts after"');
  r = await must('kedab', '/v1/flow/blocks'); ok(r.blocks.length >= 39 && r.blocks.some((b) => b.name === 'Deep Research section' && b.block === 'write'), `EA blocks: ${r.blocks.length}`);
  const solar = (await must('kedab', '/v1/flow/processes', { template: 'solar_install' })).id;
  r = await must('kedab', '/v1/flow/blocks'); ok(r.blocks.some((b) => b.name === 'Roof survey (GPS photos)'), 'solar blocks');
  p = await must('kedab', `/v1/flow/processes/${solar}`); eq(p.definition.steps.find((s) => s.id === 's1').block, 'start');
  ok(!/creative|persona|blueprint/i.test(JSON.stringify(p.definition)), 'no agency words in the solar template');

  // ---------------------------------------------------------------------------------------- Describe it
  eq((await call('kabir', '/v1/flow/describe', { text: 'The sales person calls.' })).status, 403);
  r = await must('kedab', '/v1/flow/describe', { title: 'Solar', text: 'When a new lead comes in, the sales executive calls them within 1 day. Then the site surveyor visits the site and takes photos. The sales executive sends the quotation within 2 days. Accounts makes the invoice. Done.' });
  eq(r.definition.steps.map((s) => s.block), ['start', 'meet', 'collect', 'app', 'app', 'end']);
  ok(r.notes.length >= 2 && r.problems.every((x) => x.level !== 'error'), JSON.stringify(r.notes));
  const described = await live('Described solar', r.definition);
  const v1 = (await sql('select definition from pulse.flow_process_version where process_id=$1', [described]))[0].definition;
  const quote = r.definition.steps.find((s) => s.module === 'quotation').id;
  ok(v1.wires.some((w) => w.to.step === quote && w.to.port === 'survey' && w.label === 'Uses'), 'the photos reach the quotation by themselves (a data wire on the live version)');
  ok(!(await must('kedab', `/v1/flow/processes/${described}`)).definition.wires.some((w) => w.label === 'Uses'), 'the draft keeps only the order');

  // A use no earlier step makes is said in words, with the primitive that would make it.
  r = await must('kedab', '/v1/flow/check', { definition: { version: 2, steps: [S('s', 'start', 'start', 'Start'), S('q', 'app', 'quotation', 'Quote')], wires: [W('s', 'client', 'q')] } });
  const miss = r.problems.find((x) => x.step === 'q' && /no earlier step makes one/.test(x.text));
  ok(miss && miss.fix?.kind === 'block' && miss.fix.block === 'collect', JSON.stringify(r.problems));

  // ---------------------------------------------------------------------------------------- the order holds
  const fields = [{ key: 'size', label: 'Size', type: 'choice', options: [{ value: 'small', label: 'Small' }, { value: 'big', label: 'Big' }] },
    { key: 'tier', label: 'Tier', type: 'choice', variant: true, options: [{ value: 'basic', label: 'Basic' }, { value: 'premium', label: 'Premium' }] },
    { key: 'install_date', label: 'Install date', type: 'date' }];
  const def = { version: 2, fields, roles: [{ key: 'a', label: 'Associate' }], stages: [],
    steps: [S('s1', 'start', 'start', 'Start'), S('t1', 'task', 'checklist', 'Prepare', { who: { by: 'role', role: 'a' } }),
      S('d', 'decide', 'decision', 'Big job?', { settings: { rule: { field: 'size', op: 'eq', value: 'big' }, yes: 'Big', no: 'Small' } }),
      S('t2', 'task', 'checklist', 'Order the panels'), S('t3', 'task', 'checklist', 'Premium kit', { when: [{ field: 'tier', op: 'eq', value: 'premium' }] }),
      S('t4', 'task', 'checklist', 'Schedule the crew'), S('t5', 'task', 'checklist', 'Small kit'),
      S('m', 'message', 'notify', 'Tell the starter', { settings: { roles: ['starter'], text: 'Ready for {client}: {size}, install {install_date}' } }),
      S('w', 'wait', 'wait', 'Until the install date', { settings: { until: 'field', field: 'install_date' } }), S('e', 'end', 'end', 'Done')],
    wires: [W('s1', 'client', 't1'), W('t1', 'done', 'd', { notify: ['starter'] }), W('d', 'yes', 't2'), W('t2', 'done', 't3'), W('t3', 'done', 't4'), W('d', 'no', 't5'),
      W('t4', 'done', 'm'), W('t5', 'done', 'm'), W('m', 'then', 'w'), W('w', 'after', 'e')], rules: [] };
  const order = await live('Order holds', def);
  let rid = (await must('kedab', `/v1/flow/processes/${order}/runs`, { name: 'Big basic job', fields: { size: 'big', tier: 'basic', install_date: plus(3) }, people: { a: P.asha } })).id;
  let d = await run(rid);
  eq(states(d, ['s1', 't1', 'd', 't2', 't3', 't4', 't5']), ['done', 'open', 'waiting', 'waiting', 'skipped', 'waiting', 'waiting'], 'a step after a skipped one still waits');
  ok(st(d, 't1').taskId, 'the Associate has a Work task');
  await must('asha', `/v1/flow/steps/${st(d, 't1').id}/finish`, {});
  d = await run(rid);
  eq(states(d, ['d', 't2', 't4', 't5']), ['done', 'open', 'waiting', 'skipped'], 'the rule decided by itself; the other way is skipped');
  ok(d.notices.some((n) => n.to === 'Kedab Shah' && /Prepare is done/.test(n.title)), `whoever started it is told: ${JSON.stringify(d.notices.slice(0, 3))}`);
  ok((await sql(`select count(*)::int n from pulse.notification where subject_id=$1 and event_type='flow.wire'`, [rid]))[0].n >= 1, 'the notification landed');
  await must('kedab', `/v1/flow/steps/${st(d, 't2').id}/finish`, {});
  d = await run(rid); eq(states(d, ['t3', 't4']), ['skipped', 'open'], 'the step after the skipped one opens when the one before that is done');
  await must('kedab', `/v1/flow/steps/${st(d, 't4').id}/finish`, {});
  d = await run(rid); eq(states(d, ['m', 'w', 'e']), ['done', 'open', 'waiting'], 'the message went by itself; the wait holds');
  ok(d.notices.some((n) => n.title.startsWith(`Ready for Big basic job: Big, install ${plus(3)}`)), `values filled in: ${JSON.stringify(d.notices.map((n) => n.title))}`);
  await sql('select pulse.flow_tick()'); d = await run(rid); eq(st(d, 'w').state, 'open', 'not before the date');
  await must('kedab', `/v1/flow/runs/${rid}/fields`, { fields: { install_date: today } });
  await sql('select pulse.flow_tick()'); d = await run(rid);
  eq([st(d, 'w').state, st(d, 'e').state, d.status], ['done', 'done', 'done'], 'the date came: the run is done');

  rid = (await must('kedab', `/v1/flow/processes/${order}/runs`, { name: 'Small premium job', fields: { size: 'small', tier: 'premium', install_date: today }, people: { a: P.asha } })).id;
  d = await run(rid); await must('asha', `/v1/flow/steps/${st(d, 't1').id}/finish`, {}); d = await run(rid);
  eq(states(d, ['t2', 't3', 't4', 't5']), ['skipped', 'skipped', 'skipped', 'open'], 'every step on the way not chosen is skipped');
  await must('kedab', `/v1/flow/steps/${st(d, 't5').id}/finish`, {}); d = await run(rid);
  eq(st(d, 'm').state, 'done', 'the steps meet again after the Decide');

  // A person chooses; a message to send by hand; waiting until something arrives.
  const hand = await live('By hand', { version: 2, fields: [], roles: [], stages: [], rules: [],
    steps: [S('s1', 'start', 'start', 'Start'), S('d', 'decide', 'decision', 'Go ahead?', { settings: { yes: 'Go', no: 'Stop' } }), S('msg', 'message', 'message', 'Text the client', { settings: { channel: 'whatsapp', text: 'Hello {client}, it is on {today}' } }),
      S('w', 'wait', 'wait', 'Until the payment arrives', { settings: { until: 'input', what: 'the payment' } }), S('x', 'task', 'checklist', 'Close it'), S('e', 'end', 'end', 'Done')],
    wires: [W('s1', 'client', 'd'), W('d', 'yes', 'msg'), W('msg', 'sent', 'w'), W('d', 'no', 'x'), W('w', 'after', 'e'), W('x', 'done', 'e')] });
  rid = (await must('kedab', `/v1/flow/processes/${hand}/runs`, { name: 'Mifos' })).id; d = await run(rid);
  eq(st(d, 'd').makes.map((x) => x.label), ['Go', 'Stop'], 'the ways are named');
  await must('kedab', `/v1/flow/steps/${st(d, 'd').id}/verdict`, { answer: 'Go' }); d = await run(rid);
  eq(states(d, ['msg', 'x']), ['open', 'skipped']);
  r = await must('kedab', `/v1/flow/steps/${st(d, 'msg').id}`); ok(r.text.startsWith('Hello Mifos, it is on '), r.text);
  r = await must('kedab', `/v1/flow/steps/${st(d, 'msg').id}/actions/text`, {}); ok(/^Hello Mifos/.test(r.text));
  await must('kedab', `/v1/flow/steps/${st(d, 'msg').id}/actions/sent`, {}); d = await run(rid); eq(st(d, 'w').state, 'open', 'a wait for something to arrive is someone\'s step');
  await must('kedab', `/v1/flow/steps/${st(d, 'w').id}/actions/arrived`, { note: 'UPI ref 123' }); d = await run(rid); eq(d.status, 'done');
  ok(d.values.some((x) => x.step === 'w' && x.value?.note === 'UPI ref 123'), 'what came is kept');

  // ---------------------------------------------------------------------------------------- Try it
  rid = (await must('kedab', `/v1/flow/processes/${order}/runs`, { mode: 'try', name: 'Try · Order holds', fields: { size: 'big', tier: 'basic', install_date: plus(10) }, people: { a: { name: 'Associate (try)' } } })).id;
  eq((await must('kedab', `/v1/flow/runs?processId=${order}`)).runs.some((x) => x.id === rid), false, 'a try run stays out of the lists');
  d = await run(rid); eq([d.mode, st(d, 't1').state, st(d, 't1').taskId], ['try', 'open', null], 'no Work task for a try');
  ok(d.notices.some((n) => n.to === 'Associate (try)' && /Your step: Prepare/.test(n.title) && !n.sent), 'who would have heard');
  await sql(`update pulse.flow_process set definition=jsonb_set(definition,'{steps,1,due}','{"from":"start","days":1,"workdays":false}') where id=$1`, [order]);
  await sql(`update pulse.flow_process set definition=jsonb_set(definition,'{rules}','[{"key":"late","name":"Late","when":"not-done-by-due","notify":["starter"]}]') where id=$1`, [order]);
  rid = (await must('kedab', `/v1/flow/processes/${order}/runs`, { mode: 'try', name: 'Try 3', fields: { size: 'big', tier: 'basic', install_date: plus(10) }, people: { a: { name: 'Associate (try)' } } })).id;
  d = await run(rid); ok(!st(d, 't1').due.late, 'not late yet');
  d = await must('kedab', `/v1/flow/runs/${rid}/later`, { days: 4 });
  ok(st(d, 't1').due.late && d.alerts.some((a) => a.name === 'Late'), `four days on, it is late and the alert fired: ${JSON.stringify(d.alerts)}`);
  eq((await call('kedab', `/v1/flow/runs/${described}/later`, { days: 2 })).status, 404, 'a process id is not a run');
  await must('kedab', `/v1/flow/runs/${rid}/discard`, {});
  eq((await call('kedab', `/v1/flow/runs/${rid}`)).status, 404, 'thrown away');
  eq((await sql('select count(*)::int n from pulse.flow_run_step where run_id=$1', [rid]))[0].n, 0);
  const liveRun = (await sql(`select id from pulse.flow_run where mode='live' limit 1`))[0].id;
  eq((await call('kedab', `/v1/flow/runs/${liveRun}/discard`, {})).status, 400, 'a live run is never thrown away');
  eq((await call('kedab', `/v1/flow/runs/${liveRun}/later`, { days: 2 })).status, 400, 'a live run never moves in time');

  // ---------------------------------------------------------------------------------------- starting by themselves
  // A new lead.
  const leadP = await live('On a lead', { version: 2, fields: [], roles: [], stages: [], rules: [], steps: [S('s1', 'start', 'lead_capture', 'New lead'), S('t', 'task', 'checklist', 'Call them')], wires: [W('s1', 'lead', 't')] });
  const project = (await sql('select id from pulse.project limit 1'))[0]?.id ?? null;
  await sql(`insert into pulse.lead(org_id,buyer_id,project_id,created_at,status) values($1,gen_random_uuid(),$2,now(),'new')`, [org, project], worker);
  r = await must('kedab', `/v1/flow/runs?processId=${leadP}`); eq(r.runs.length, 1, 'a new lead started a run'); ok(/^Lead · /.test(r.runs[0].name), r.runs[0].name);
  d = await run(r.runs[0].id); eq(states(d, ['s1', 't']), ['done', 'open']);

  // A form sent: its answers decide the way.
  const form = (await must('kedab', '/api/v0/forms', { name: 'Enquiry', fields: [{ key: 'kind', label: 'Kind', type: 'text', required: true }] })).id;
  await must('kedab', `/api/v0/forms/${form}/status`, { status: 'live' });
  const formP = await live('On a form', { version: 2, fields: [], roles: [], stages: [], rules: [],
    steps: [S('s1', 'start', 'start', 'Form sent', { settings: { trigger: 'form', formId: form } }), S('d', 'decide', 'decision', 'Rooftop?', { settings: { rule: { field: 'kind', op: 'eq', value: 'rooftop' } } }),
      S('y', 'task', 'checklist', 'Rooftop survey'), S('n', 'task', 'checklist', 'Other survey')],
    wires: [W('s1', 'client', 'd'), W('d', 'yes', 'y'), W('d', 'no', 'n')] });
  r = await must('neha', '/api/v0/forms/submit', { formId: form, answers: { kind: 'Rooftop' } });
  r = await must('kedab', `/v1/flow/runs?processId=${formP}`); eq(r.runs.length, 1, 'the form started a run'); ok(/^Enquiry · /.test(r.runs[0].name), r.runs[0].name);
  d = await run(r.runs[0].id); eq(states(d, ['d', 'y', 'n']), ['done', 'open', 'skipped'], 'its answer decided the way');

  // A schedule: once per slot.
  const at = new Date(Date.now() - 60000).toISOString().slice(11, 16);
  const schedP = await live('Every day', { version: 2, fields: [], roles: [], stages: [], rules: [], steps: [S('s1', 'start', 'start', 'Daily', { settings: { trigger: 'schedule', every: 'day', at } }), S('t', 'task', 'checklist', 'Daily check')], wires: [W('s1', 'client', 't')] });
  const tz = (await sql('select pulse.org_time_zone() z'))[0].z; void tz;
  await sql('select pulse.flow_tick()'); await sql('select pulse.flow_tick()');
  r = await must('kedab', `/v1/flow/runs?processId=${schedP}`); ok(r.runs.length <= 1, 'never twice in one slot');
  checks++;   // the slot is in the company's time zone: before its "at" there it waits for tomorrow

  // A Collect step finished by its form, filled on the step.
  const collectP = await live('Collect', { version: 2, fields: [], roles: [{ key: 'f', label: 'Field' }], stages: [], rules: [],
    steps: [S('s1', 'start', 'start', 'Start'), S('c', 'collect', 'data_capture', 'Site details', { who: { by: 'role', role: 'f' }, settings: { formId: form } }), S('e', 'end', 'end', 'Done')],
    wires: [W('s1', 'client', 'c'), W('c', 'answers', 'e')] });
  rid = (await must('kedab', `/v1/flow/processes/${collectP}/runs`, { name: 'Site 7', people: { f: P.ravi } })).id; d = await run(rid);
  eq(st(d, 'c').who?.id, P.ravi);
  await must('ravi', '/api/v0/forms/submit', { formId: form, flowStepId: st(d, 'c').id, answers: { kind: 'Tin shed' }, location: { lat: 18.52, lng: 73.85, accuracy: 9 } });
  d = await run(rid); eq([st(d, 'c').state, d.status], ['done', 'done'], 'sending the form finished the step and the run');
  const got = d.values.find((x) => x.step === 'c' && x.side === 'makes');
  ok(got.value.answers.kind === 'Tin shed' && got.value.location.lat === 18.52, JSON.stringify(got.value));

  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks }));
  console.log(`flow-d-runner: ${checks} checks`);
} finally { await pool.end(); await worker.end(); }
