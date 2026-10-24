// FLOW-A acceptance against the built API on the synthetic agency (tests/core/test_flow.py): the module registry, the
// process library with older SOPs read through it, the EA template published and run (data, not permission: steps open
// when their data exists; variants skip steps; Day 1 starts when the critical inputs are in; due dates per package),
// Work tasks follow steps both ways, module backends (intake, schedule, meeting, records, asset IDs, share for review,
// the words/claims check), Pip per step, a decision's branch not taken is skipped, alerts from the tick, scorecard,
// capacity, and who may do what.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const P = JSON.parse(process.env.TEST_PEOPLE); const domain = process.env.TEST_DOMAIN; const org = process.env.PULSE_ORG_ID;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const call = async (who, url, payload, method = payload ? 'POST' : 'GET') => {
  const r = await app.inject({ url, method, headers: { 'cf-access-authenticated-user-email': `${who}@${domain}`, 'x-pulse-client-ip': crypto.randomUUID() }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const must = async (who, url, payload) => { const r = await call(who, url, payload); assert.equal(r.status, 200, `${who} ${url}: ${JSON.stringify(r.data).slice(0, 400)}`); checks++; return r.data; };
const run = (rid) => must('kedab', `/v1/flow/runs/${rid}`);
const st = (d, key) => d.steps.find((s) => s.key === key);
const sql = async (q, params = []) => { const c = await pool.connect(); try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [org, P.kedab]); const r = await c.query(q, params); await c.query('commit'); return r.rows; } finally { c.release(); } };

try {
  // The registry: every old block under its own key, new kinds, honest engines; nothing hard-coded in the UI.
  let r = await must('kabir', '/v1/flow/modules');
  ok(r.modules.length >= 45, `modules: ${r.modules.length}`);
  for (const k of ['lead_capture', 'sales_xray', 'quotation', 'follow_up', 'approval', 'decision', 'site_visit', 'data_capture', 'checklist', 'handoff', 'wait', 'notify', 'tax_invoice', 'webhook', 'end'])
    ok(r.modules.some((m) => m.key === k), `old block ${k}`);
  eq(r.kinds.map((k) => k.key), ['contact', 'talk', 'doc', 'media', 'answers', 'money', 'verdict', 'slot', 'list', 'any']);
  eq(r.modules.find((m) => m.key === 'webhook').engine, 'live');   // FLOW-E: a signed post to the company's address
  ok(r.recordTypes.some((t) => t.key === 'persona') && r.recordTypes.some((t) => t.key === 'fact'), 'record types');

  // The library: older SOPs read through Flow as written-only processes.
  r = await must('kedab', '/v1/flow/processes');
  const onboarding = r.processes.find((p) => p.source === 'sop' && p.name === 'Client onboarding');
  ok(onboarding && onboarding.statusText === 'Written only' && onboarding.readOnly, 'an SOP is a written-only process');
  eq(r.templates.map((t) => t.key), ['ea_creative', 'solar_install', 'agency_campaign', 'consulting_engagement', 'clinic_visit', 'developer_booking', 'blank']);
  const sopView = await must('kedab', `/v1/flow/processes/${onboarding.id}`);
  ok(sopView.writeup.length === 9 && sopView.definition.steps.length === 0, 'its write-up, no steps');
  eq((await call('kabir', '/v1/flow/processes', { template: 'ea_creative' })).status, 403, 'members do not design');

  // A process from the EA template, published.
  const pid = (await must('kedab', '/v1/flow/processes', { template: 'ea_creative' })).id;
  let proc = await must('kedab', `/v1/flow/processes/${pid}`);
  eq(proc.statusText, 'Steps drafted'); eq(proc.problems.filter((x) => x.level === 'error'), []);
  eq(proc.definition.steps.length, 41); eq(proc.terms.run, 'Project');
  ok(proc.roleHolders.cs.some((p) => p.name === 'Meera Iyer'), 'Meera holds the Creative Strategist role');
  eq((await call('vikram', `/v1/flow/processes/${pid}/runs`, { fields: { package: 'growth' } })).status, 400, 'not live yet');
  r = await must('kedab', `/v1/flow/processes/${pid}/publish`, {}); eq(r.version, 1);
  r = await must('kabir', '/v1/flow/processes'); ok(r.processes.some((p) => p.id === pid && p.statusText === 'Live · 0 running'), 'live for everyone');
  // The builder's check: a wire whose kinds do not fit is an error with the converters that fit.
  const bad = structuredClone(proc.definition); bad.wires.push({ from: { step: '0.4', port: 'slot' }, to: { step: '3.5', port: 'draft' } });
  r = await must('kedab', '/v1/flow/check', { definition: bad, stepId: '3.5' });
  const wrong = r.problems.find((x) => x.level === 'error' && x.fix);
  ok(wrong && /needs a document/.test(wrong.text) && wrong.fix.modules.length, JSON.stringify(wrong));

  // A Growth project: Stage 5 (Sell-Out) is skipped, Stage 4 waits; only 0.1 is open at the start.
  const today = (await sql('select pulse.flow_today()::text d'))[0].d;
  eq((await call('kabir', `/v1/flow/processes/${pid}/runs`, { fields: { package: 'growth' } })).status, 403, 'members do not start runs');
  eq((await call('kedab', `/v1/flow/processes/${pid}/runs`, { fields: {} })).status, 400, 'the package is required');
  const people = { gs_head: P.kedab, gs: P.asha, cs: P.meera, ve: P.ishaan, pc: P.neha, ac: P.neha, gd: P.kabir, sme: P.sana };
  const rid = (await must('kedab', `/v1/flow/processes/${pid}/runs`, { name: 'Skyline Residences', fields: { package: 'growth', segment: 'premium', research_meet: today, project_code: 'SKY' }, people })).id;
  let d = await run(rid);
  eq(d.status, 'running'); eq(st(d, '0.1').state, 'open'); eq(st(d, '0.1').who.name, 'Kedab Shah');
  eq(d.steps.filter((s) => s.state === 'open').map((s) => s.key), ['0.1']);
  ok(d.steps.filter((s) => s.stage === 's5').every((s) => s.state === 'skipped' && /Sell-Out/.test(s.stateText)), 'Sell-Out steps skipped');
  eq(st(d, '4.1').state, 'waiting');
  ok(/^Waiting for Save the transcript/.test(st(d, '2.1').stateText) && st(d, '2.1').waitingFor[0].from.who.name === 'Meera Iyer', st(d, '2.1').stateText);
  ok(/clock starts/.test(st(d, '2.1').due.text), st(d, '2.1').due.text);
  ok(st(d, '0.1').taskId, 'an open step is a Work task');

  // 0.1 done in Work (the task) → the GS's intro call + intake, the folder, the slot open.
  const t01 = st(d, '0.1').taskId;
  eq((await call('kedab', `/api/v0/tasks/${t01}/move`, { status: 'done' })).status, 200);
  d = await run(rid);
  eq(['0.2', '0.3', '0.4'].map((k) => st(d, k).state), ['open', 'open', 'open']); eq(st(d, '0.2').who.name, 'Asha Rao'); eq(st(d, '0.3').who.name, 'Neha Kireteso');
  r = await must('asha', '/v1/flow/my-steps'); ok(['0.2', '0.4'].every((k) => r.steps.some((s) => s.key === k)), 'My steps');
  r = await must('meera', '/v1/flow/my-steps'); ok(r.upcoming.some((s) => s.key === '2.1'), 'coming up for the CS');

  // The intake: Day 1 is the day the last critical input came in; the step finishes; due dates follow the package.
  const s02 = st(d, '0.2');
  const intake = d.intake.filter((i) => i.step === '0.2'); eq(intake.length, 8, 'Sell-Out-only inputs are not asked of a Growth project');
  eq((await call('ravi', `/v1/flow/steps/${s02.id}/actions/receive`, { item: 'brochure' })).status, 403, 'not on this run');
  for (const i of intake.slice(0, 7)) await must('asha', `/v1/flow/steps/${s02.id}/actions/receive`, { item: i.key, on: today });
  d = await run(rid); eq(d.day1, null, 'one input still missing'); eq(st(d, '0.2').state, 'in_progress');
  await must('asha', `/v1/flow/steps/${s02.id}/actions/receive`, { item: intake[7].key, on: today });
  d = await run(rid); ok(d.day1, 'Day 1 set'); eq(st(d, '0.2').state, 'done');
  const due21 = (await sql('select pulse.flow_workday_add($1::date,1)::text d', [d.day1]))[0].d;
  eq(st(d, '2.1').due.on, due21, 'Deep Research due Day 2'); ok(/Day 2/.test(st(d, '2.1').due.text), st(d, '2.1').due.text);
  eq(st(d, '2.5').due.on, (await sql('select pulse.flow_workday_add($1::date,4)::text d', [d.day1]))[0].d, 'Positioning due Day 5 in Growth');

  // The slot fixes the research meet; the Blueprint doc and the meeting open.
  await must('asha', `/v1/flow/steps/${st(d, '0.4').id}/actions/slot`, { on: today, time: '11:00', place: 'https://meet.google.com/abc-defg-hij' });
  d = await run(rid); eq(['1.1', '1.3'].map((k) => st(d, k).state), ['open', 'open']); eq(st(d, '1.2').state, 'waiting');
  // The meeting: a transcript pasted, Pip's summary and follow-ups, then done.
  const s13 = st(d, '1.3');
  const transcript = 'Client: The project has 2 towers with 220 flats. Prices start at ₹ 1.2 Cr for a 3 BHK.\nCS: What do buyers compare?\nClient: Mostly Godrej and Konih, about 3 km away. The metro station is 5 min away as per the brochure.\nPENDING: the clubhouse completion date.\nWe will send the revised price sheet by Monday.\nCONFLICT: the brochure says 40 amenities, the sales team says 32.';
  r = await must('meera', `/v1/flow/steps/${s13.id}/actions/transcript`, { transcript });
  eq(r.record.status, 'transcribed'); eq(r.record.type, 'meeting');
  r = await must('meera', `/v1/flow/steps/${s13.id}/actions/summarise`, { keep: true });
  ok(r.suggestion.followups.some((f) => /price sheet/.test(f)) && r.suggestion.tags.some((t) => t.tag === 'CONFLICT'), JSON.stringify(r.suggestion));
  await must('meera', `/v1/flow/steps/${s13.id}/finish`, {});
  d = await run(rid); eq(st(d, '1.4').state, 'open');
  // 1.4 done in Work → every Blueprint step opens at once (data, not permission), the follow-ups too.
  eq((await call('meera', `/api/v0/tasks/${st(d, '1.4').taskId}/move`, { status: 'done' })).status, 200);
  d = await run(rid);
  eq(['1.5', '2.1', '2.2', '2.3', '2.4', '2.5', '2.6'].map((k) => st(d, k).state), Array(7).fill('open'));
  eq(st(d, '2.7').state, 'waiting'); eq(st(d, '3.1').state, 'waiting');
  ok(/Positioning/.test(st(d, '3.1').stateText), st(d, '3.1').stateText);

  // Records: a fact (to verify), the Word Library, a persona; typed links.
  const fact = (await must('meera', '/v1/flow/records', { type: 'fact', runId: rid, stepKey: '2.1', data: { statement: 'The metro station is 5 min away', source: 'Client — Document', kpc: false } })).record;
  eq(fact.status, 'to_verify'); eq(fact.statusLabel, 'To verify');
  eq((await call('meera', '/v1/flow/records', { type: 'fact', runId: rid, data: { source: 'Website' } })).status, 400, 'a fact needs its statement');
  await must('meera', '/v1/flow/records', { type: 'word', runId: rid, stepKey: '2.6', data: { use: 'residences', avoid: 'flats', scope: 'All', why: 'Premium segment' } });
  const persona = (await must('meera', '/v1/flow/records', { type: 'persona', runId: rid, stepKey: '2.4', data: { name: 'Upgrading IT couple', who: 'Two incomes, 32–40', situation: 'Second home', wants: 'Space', fears: 'Possession delay' } })).record;
  await must('meera', `/v1/flow/records/${persona.id}/links`, { toId: fact.id, kind: 'proof' });
  r = await must('meera', `/v1/flow/records/${persona.id}`); eq(r.record.links.map((l) => l.kind), ['proof']);
  eq((await call('meera', `/v1/flow/records/${persona.id}/status`, { status: 'confirmed' })).status, 400, 'draft goes to checked first');
  await must('meera', `/v1/flow/records/${persona.id}/status`, { status: 'checked' });

  // Pip on a step: what it is and needs, the SOP part, and a grounded assist.
  r = await must('meera', `/v1/flow/steps/${st(d, '2.1').id}/pip`, { action: 'draft' });
  ok(r.about.step && r.result.outline.includes('# Deep Research') && r.assistant.model === null, JSON.stringify(r).slice(0, 300));
  r = await must('meera', `/v1/flow/steps/${st(d, '2.1').id}/pip`, { action: 'extract' });
  ok(r.result.facts.some((f) => /220 flats/.test(f.statement)) && r.result.openItems.some((o) => o.tag === 'PENDING'), 'facts and open items from the transcript');

  // Positioning and the Word Library done: the Blueprint can be shared and copywriting opens, without waiting for approval.
  for (const k of ['2.5', '2.6']) await must('meera', `/v1/flow/steps/${st(d, k).id}/finish`, {});
  d = await run(rid); eq(st(d, '2.7').state, 'open'); eq(st(d, '3.1').state, 'open');
  // Growth: the GS tells the client the Blueprint is done; the step is done when sent.
  await must('asha', `/v1/flow/steps/${st(d, '2.7').id}/actions/send`, { message: 'The Blueprint is done.', links: [] });
  d = await run(rid); eq(st(d, '2.7').state, 'done'); eq(st(d, '2.7').rounds, 1);

  // Stage 3: three assets with Asset IDs; the check waits for all three, then flags the Word Library and unconfirmed figures.
  await must('meera', `/v1/flow/steps/${st(d, '3.1').id}/finish`, {});
  d = await run(rid);
  const s32 = await must('meera', `/v1/flow/steps/${st(d, '3.2').id}/open`, {});
  eq(s32.record.code, 'SKY_MV_ALL_MAIN_H01_V01'); eq(s32.record.data.tabs.map((t) => t.title), ['Script', 'Videographer notes', 'Editor notes']);
  await must('meera', `/v1/flow/steps/${st(d, '3.2').id}/actions/tab`, { tab: 'Script', text: 'The best flats in Pune. The metro is 5 min away. Book a visit on WhatsApp.' });
  await must('meera', `/v1/flow/steps/${st(d, '3.2').id}/finish`, {});
  d = await run(rid); eq(st(d, '3.5').state, 'waiting', 'the check waits for all three drafts');
  for (const k of ['3.3', '3.4']) { await must('meera', `/v1/flow/steps/${st(d, k).id}/open`, {}); await must('meera', `/v1/flow/steps/${st(d, k).id}/finish`, {}); }
  d = await run(rid); eq(st(d, '3.5').state, 'open');
  r = await must('meera', `/v1/flow/steps/${st(d, '3.5').id}/actions/run`, {});
  ok(r.findings.some((f) => f.rule === 'Word Library' && /flats/.test(f.text)), 'avoid word');
  ok(r.findings.some((f) => f.rule === 'Claims' && /best/.test(f.text)), 'risky claim');
  ok(r.findings.some((f) => f.rule === 'Facts' && /to verify/.test(f.text)), 'figure rests on a fact to verify');
  await must('meera', `/v1/flow/steps/${st(d, '3.5').id}/verdict`, { answer: 'passed' });
  d = await run(rid); eq(st(d, '3.5').state, 'done'); eq(st(d, '3.6').state, 'open');

  // Alerts: a step past its due date, from the worker's tick; data owners for a blocked step.
  await sql(`update pulse.flow_run_step set due_on=pulse.flow_today()-3 where run_id=$1 and step_key in ('3.6','3.10')`, [rid]);
  const tick = await sql('select pulse.flow_tick() r'); ok(tick[0].r.active >= 2, JSON.stringify(tick));
  d = await run(rid);
  ok(d.alerts.some((a) => a.rule === 'first_drop_late' && a.notified.includes('Meera Iyer')), JSON.stringify(d.alerts));
  ok(d.alerts.some((a) => a.rule === 'blocked_on_data' && a.step === '3.10' && a.notified.includes('Meera Iyer')), 'blocked on data (waiting past due)');
  ok(/late/.test(d.pip), d.pip);
  const notes = await sql(`select count(*)::int n from pulse.notification where subject_type='flow_run' and subject_id=$1 and event_type='flow.alert'`, [rid]);
  ok(notes[0].n >= 1, 'alert notifications (Kedab sees his own: GS Head)');
  await sql('select pulse.flow_tick()'); eq((await sql(`select count(*)::int n from pulse.notification where subject_type='flow_run' and subject_id=$1 and event_type='flow.alert'`, [rid]))[0].n, notes[0].n, 'an alert fires once');

  // Scorecard and capacity.
  r = await must('kedab', `/v1/flow/scorecard?processId=${pid}`); ok(r.processes[0].metrics.some((m) => m.key === 'on_time_blueprint'), 'scorecard');
  r = await must('kedab', '/v1/flow/capacity'); ok(r.people.some((p) => p.name === 'Meera Iyer'), 'capacity');
  r = await must('kedab', '/v1/flow/runs?status=running'); eq(r.counts.running, 1);

  // A decision: the way not chosen is skipped. A wait finishes on the tick.
  const small = { version: 2, roles: [{ key: 'lead', label: 'PGS' }], fields: [], stages: [],
    steps: [{ id: 'a', module: 'checklist', title: 'Look', who: { by: 'starter' } }, { id: 'b', module: 'decision', title: 'Good?', who: { by: 'starter' } },
      { id: 'y', module: 'checklist', title: 'Ship it', who: { by: 'starter' } }, { id: 'n', module: 'checklist', title: 'Redo', who: { by: 'starter' } }],
    wires: [{ from: { step: 'a', port: 'done' }, to: { step: 'b', port: 'in' } }, { from: { step: 'b', port: 'yes' }, to: { step: 'y', port: 'in' } }, { from: { step: 'b', port: 'no' }, to: { step: 'n', port: 'in' } }], rules: [] };
  const sp = (await must('kedab', '/v1/flow/processes', { name: 'Small', definition: small })).id;
  await must('kedab', `/v1/flow/processes/${sp}/publish`, {});
  const sr = (await must('kedab', `/v1/flow/processes/${sp}/runs`, {})).id;
  let s = await run(sr); await must('kedab', `/v1/flow/steps/${st(s, 'a').id}/finish`, {});
  s = await run(sr); await must('kedab', `/v1/flow/steps/${st(s, 'b').id}/verdict`, { answer: 'Yes' });
  s = await run(sr); eq(st(s, 'y').state, 'open'); eq(st(s, 'n').state, 'skipped'); eq(st(s, 'n').stateText, 'Not on the way chosen');
  await must('kedab', `/v1/flow/steps/${st(s, 'y').id}/finish`, {}); s = await run(sr); eq(s.status, 'done');

  // An old workflow edited here becomes a Flow process; the old one stays as it was.
  const solar = (await must('kedab', '/v1/flow/processes', { template: 'solar_install' })).id;
  proc = await must('kedab', `/v1/flow/processes/${solar}`); eq(proc.terms.run, 'Job'); eq(proc.problems.filter((x) => x.level === 'error'), []);
  ok(!JSON.stringify(proc.definition).match(/Blueprint|Creative Strateg|Persona/), 'no agency words in the solar template');
  const adopted = await must('kedab', `/v1/flow/processes/${onboarding.id}`, { name: 'Client onboarding (process)' });
  eq(adopted.source, 'flow'); eq(adopted.legacy.sopId, onboarding.id.slice(4));
  r = await must('kedab', '/v1/flow/processes'); ok(!r.processes.some((p) => p.id === onboarding.id), 'the SOP is now read through its process');

  // Start from a write-up: Pip proposes steps and wires from an SOP; a person's daily update from their open steps.
  r = await must('kedab', '/v1/flow/propose', { from: onboarding.id.replace('sop:', 'sop:') });
  ok(r.steps >= 8 && r.definition.wires.length >= 6 && /Client onboarding/.test(r.source), JSON.stringify(r).slice(0, 300));
  eq((await call('kabir', '/v1/flow/propose', { text: 'x' })).status, 403);
  r = await must('kedab', '/v1/flow/propose', { title: 'Visit SOP', text: 'Step 1: Call the customer\nStep 2: Visit the site and take photos\nStep 3: Send the quote' });
  ok(r.steps >= 2, JSON.stringify(r).slice(0, 300));
  r = await must('meera', '/v1/flow/daily-update'); ok(/^Working on today:/.test(r.text) && r.steps >= 1, r.text);

  // Who may do what; a run stopped.
  eq((await call('kabir', `/v1/flow/runs/${rid}/cancel`, {})).status, 200, 'Kabir is named on the run (designer)');
  d = await run(rid); eq(d.status, 'cancelled');
  ok((await sql(`select count(*)::int n from pulse.task where source='flow' and source_ref in (select id::text from pulse.flow_run_step where run_id=$1) and status not in ('done','cancelled')`, [rid]))[0].n === 0, 'its open tasks are cancelled');
  eq((await call('ravi', `/v1/flow/steps/${st(s, 'a').id}/finish`, {})).status, 403, 'not on the run');

  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks }));
  console.log(`flow-runner: ${checks} checks`);
} finally { await pool.end(); }
