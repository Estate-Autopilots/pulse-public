// SOP-WORKFLOW part 3 acceptance against the built API on the synthetic agency (tests/core/test_sop.py::test_field_forms):
// the solar installation template installed and run end to end (pickup → entry → installation with photos, serials and a
// signature → the panel count decides the supervisor's check → approval), photos from the gallery refused, a form that
// starts a workflow, who reads a sent form and its photos, the record of it, and voiding.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const P = JSON.parse(process.env.TEST_PEOPLE); const domain = process.env.TEST_DOMAIN; const project = process.env.TEST_PROJECT;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const call = async (who, url, payload, method = payload ? 'POST' : 'GET') => {
  const r = await app.inject({ url, method, headers: { 'cf-access-authenticated-user-email': `${who}@${domain}`, 'x-pulse-client-ip': crypto.randomUUID(), 'user-agent': 'Mozilla/5.0 PulseShell/1.1.2' }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.rawPayload, type: r.headers['content-type'] };
};
// A real 1×1 JPEG (synthetic), and photos "taken now" or two days ago.
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const photo = (field, ago = 0) => ({ field, name: `${field}.jpg`, mime: 'image/jpeg', data: JPEG, source: 'camera', capturedAt: new Date(Date.now() - ago).toISOString(), lat: 18.5204, lng: 73.8567, accuracy: 12 });
const sign = (field) => ({ field, name: 'signature.png', mime: 'image/png', data: JPEG, source: 'signature', capturedAt: new Date().toISOString() });
const active = async (rid) => (await call('kedab', `/api/v0/workflows/runs/${rid}`)).data.steps.find((s) => s.status === 'active');

try {
  // Install the template: three live forms and the workflow (a draft); publish it after a look.
  eq((await call('kabir', '/api/v0/forms/templates/solar_install', {})).status, 403);
  let r = await call('kedab', '/api/v0/forms'); eq(r.data.templates.map((t) => t.key), ['solar_install', 'site_visit', 'delivery_handover']);
  r = await call('kedab', '/api/v0/forms/templates/solar_install', {}); eq(r.status, 200); eq(r.data.formIds.length, 3); const wid = r.data.workflowId;
  r = await call('kedab', `/api/v0/workflows/${wid}`); const def = r.data.workflow.definition;
  eq(def.steps.map((s) => !!s.formId), [true, true, true, false, false, false]);
  eq((await call('kedab', `/api/v0/workflows/${wid}/publish`, {})).status, 200);
  r = await call('kabir', '/api/v0/forms'); eq(r.data.forms.map((f) => f.name).sort(), ['Installation report', 'Material pickup', 'Site entry']); eq(r.data.templates, [], 'templates are leadership\'s');

  // A run: the pickup goes to the field technician, whose phone lists it to fill.
  r = await call('kedab', `/api/v0/workflows/${wid}/start`, { projectId: project, name: 'Rooftop 12 kW · synthetic' }); eq(r.status, 200, JSON.stringify(r.data)); const rid = r.data.id;
  let s = await active(rid); eq(s.key, 'pickup'); eq(s.person, 'Ravi Putig'); eq(s.formId, def.steps[0].formId);
  r = await call('ravi', '/api/v0/forms'); eq(r.data.toFill.map((t) => [t.stepId, t.form]), [[s.id, 'Material pickup']]);
  r = await call('ravi', `/api/v0/forms/fill/${s.id}`); eq(r.data.step.canFill, true); eq(r.data.form.name, 'Material pickup');
  eq((await call('kabir', `/api/v0/forms/fill/${s.id}`)).status, 404, 'someone else\'s step is not even shown');
  r = await call('ravi', `/api/v0/workflows/task/${s.taskId}`); eq(r.data.step.canFill, true);
  const pickupForm = (await call('ravi', `/api/v0/forms/fill/${s.id}`)).data.form; const key = (label) => pickupForm.fields.find((f) => f.label === label).key;
  const pickup = { [key('Store')]: 'Main warehouse', [key('Panel serial numbers')]: 'WL-001\nWL-002', [key('Inverter serial number')]: 'INV-77', [key('Panels picked up')]: 12 };
  eq((await call('ravi', '/api/v0/forms/submit', { formId: pickupForm.id, stepId: s.id, answers: pickup, files: [] })).data.error, '“Photo of the loaded material” needs 1 photo');
  r = await call('ravi', '/api/v0/forms/submit', { formId: pickupForm.id, stepId: s.id, answers: pickup, files: [photo(key('Photo of the loaded material'), 2 * 86400000), sign(key("Storekeeper's signature"))] });
  eq(r.status, 400); ok(/older photos from the gallery are not accepted/.test(r.data.error), r.data.error);
  eq((await call('kabir', '/api/v0/forms/submit', { formId: pickupForm.id, stepId: s.id, answers: pickup, files: [photo(key('Photo of the loaded material')), sign(key("Storekeeper's signature"))] })).status, 403);
  r = await call('ravi', '/api/v0/forms/submit', { formId: pickupForm.id, stepId: s.id, answers: pickup, files: [photo(key('Photo of the loaded material')), sign(key("Storekeeper's signature"))], location: { lat: 18.52, lng: 73.85, accuracy: 20 } });
  eq(r.status, 200); eq(r.data.stepDone, true); const pickupId = r.data.id;
  eq((await call('ravi', '/api/v0/forms/submit', { formId: pickupForm.id, stepId: s.id, answers: pickup, files: [photo(key('Photo of the loaded material')), sign(key("Storekeeper's signature"))] })).status, 403, 'a finished step takes no second form');

  // Entry, then the installation: twelve panels, so the supervisor checks it.
  s = await active(rid); eq(s.key, 'entry');
  const entryForm = (await call('ravi', `/api/v0/forms/fill/${s.id}`)).data.form; const ek = (l) => entryForm.fields.find((f) => f.label === l).key;
  r = await call('ravi', '/api/v0/forms/submit', { formId: entryForm.id, stepId: s.id, answers: { [ek('Where you are')]: { lat: 18.52, lng: 73.85, accuracy: 15 }, [ek('Panels planned for this job')]: 12, [ek('Roof type')]: 'RCC flat' },
    files: [photo(ek('Photo at the site on arrival'))] }); eq(r.status, 200);
  s = await active(rid); eq(s.key, 'install');
  const inst = (await call('ravi', `/api/v0/forms/fill/${s.id}`)).data.form; const ik = (l) => inst.fields.find((f) => f.label === l).key;
  const answers = { [ik('Panels installed')]: 12, [ik('System size')]: 6.48, [ik('Panel serial numbers installed')]: 'WL-001\nWL-002', [ik('Inverter serial number')]: 'INV-77',
    [ik('Checks done')]: inst.fields.find((f) => f.type === 'checklist').options, [ik('Where you are')]: { lat: 18.52, lng: 73.85, accuracy: 8 } };
  eq((await call('ravi', '/api/v0/forms/submit', { formId: inst.id, stepId: s.id, answers, files: [photo(ik('Photos of the installed panels')), sign(ik("Customer's signature"))] })).data.error, '“Photos of the installed panels” needs 2 photos');
  r = await call('ravi', '/api/v0/forms/submit', { formId: inst.id, stepId: s.id, answers, files: [photo(ik('Photos of the installed panels')), photo(ik('Photos of the installed panels')), sign(ik("Customer's signature"))] });
  eq(r.status, 200); const installId = r.data.id;
  r = await call('kedab', `/api/v0/workflows/runs/${rid}`);
  eq(r.data.steps.find((x) => x.key === 'big').outcome, 'Yes', 'twelve panels: the supervisor checks it');
  eq(r.data.run.context['install.panels_installed'], 12); ok(!('install.photos_of_the_installed_panels' in r.data.run.context), 'photos are not run values');
  eq(r.data.submissions.length, 3);
  s = r.data.steps.find((x) => x.status === 'active'); eq(s.key, 'check'); eq(s.person, 'Meena Jivop');
  eq((await call('meena', `/api/v0/workflows/steps/${s.id}/decide`, { choice: 'Approved' })).status, 200);
  s = await active(rid); eq(s.key, 'handover');

  // The record: answers as sent, photos with when and where, and who sent and opened it.
  r = await call('kedab', `/api/v0/forms/submissions/${installId}`); eq(r.status, 200);
  eq(r.data.submission.answers[ik('Panels installed')], 12); eq(r.data.submission.answers[ik('Panel serial numbers installed')], ['WL-001', 'WL-002']);
  eq(r.data.submission.device, 'Pulse phone app'); eq(r.data.submission.project, 'Pilot project');
  eq(r.data.files.map((f) => [f.field, f.source]), [[ik("Customer's signature"), 'signature'], [ik('Photos of the installed panels'), 'camera'], [ik('Photos of the installed panels'), 'camera']]);
  ok(r.data.files[1].lat === 18.5204 && r.data.files[1].capturedAt, 'where and when a photo was taken');
  eq(r.data.events.map((e) => e.kind), ['submitted', 'viewed']);
  const fileId = r.data.files[1].id;
  r = await call('kedab', `/api/v0/forms/files/${fileId}`); eq(r.status, 200); eq(r.type, 'image/jpeg'); ok(r.data.length > 100, 'the photo bytes');
  eq((await call('ishaan', `/api/v0/forms/files/${fileId}`)).status, 404, 'not for someone outside the project and the run');
  eq((await call('ishaan', `/api/v0/forms/submissions/${installId}`)).status, 404);
  eq((await call('ravi', `/api/v0/forms/submissions/${installId}`)).status, 200, 'whoever sent it reads it');
  r = await call('kedab', `/api/v0/forms/submissions/${installId}`); ok(r.data.events.some((e) => e.kind === 'file_viewed'), 'opening a photo is on the record');
  r = await call('kedab', `/api/v0/forms/submissions?projectId=${project}`); eq(r.data.submissions.length, 3);

  // Void: leadership, with a reason.
  eq((await call('ravi', `/api/v0/forms/submissions/${pickupId}/void`, { reason: 'wrong' })).status, 403);
  eq((await call('kedab', `/api/v0/forms/submissions/${pickupId}/void`, { reason: '' })).status, 400);
  eq((await call('kedab', `/api/v0/forms/submissions/${pickupId}/void`, { reason: 'Logged against the wrong store' })).status, 200);
  eq((await call('kedab', `/api/v0/forms/submissions/${pickupId}`)).data.submission.status, 'void');

  // A form that starts a workflow: a site visit sent on its own starts the follow-up run with the answers.
  r = await call('kedab', '/api/v0/forms/templates/site_visit', {}); const visitForm = r.data.formIds[0];
  r = await call('kedab', '/api/v0/workflows', { name: 'Site visit follow-up', definition: { steps: [{ id: 'f', title: 'Follow up the visit', kind: 'decision', next: [{ to: 'call', label: 'Needed', when: { field: 'form.follow_up_needed', op: 'eq', value: 'true' } }, { to: 'note', label: 'Not needed' }] },
    { id: 'call', title: 'Call the client', role: 'PGS', next: [] }, { id: 'note', title: 'File the notes', assign: { by: 'starter' } }] }, trigger: { kind: 'form', formId: visitForm } }); const wf2 = r.data.id;
  eq((await call('kedab', `/api/v0/workflows/${wf2}/publish`, {})).status, 200);
  const vf = (await call('kabir', `/api/v0/forms/${visitForm}/blank`)).data.form; const vk = (l) => vf.fields.find((f) => f.label === l).key;
  r = await call('kabir', '/api/v0/forms/submit', { formId: visitForm, projectId: project, answers: { [vk('Where you are')]: { lat: 18.5, lng: 73.8, accuracy: 30 }, [vk('Who you met')]: 'Site engineer', [vk('What was agreed')]: 'Shoot on Friday', [vk('Follow-up needed?')]: true },
    files: [photo(vk('Photos of the site'))] });
  eq(r.status, 200); eq(r.data.runs.length, 1);
  r = await call('kedab', `/api/v0/workflows/runs/${r.data.runs[0]}`); eq(r.data.run.via, 'form'); eq(r.data.steps.find((x) => x.key === 'f').outcome, 'Needed');
  eq(r.data.steps.find((x) => x.status === 'active').key, 'call');
  eq((await call('kabir', '/api/v0/forms/submit', {})).status, 400);

  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks }));
  console.log(`form-runner: ${checks} checks`);
} finally { await app.close(); await pool.end(); }
