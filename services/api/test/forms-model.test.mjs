import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAnswers, fileNeeds, normalizeFields, TEMPLATES } from '../dist/forms-model.js';
import { normalizeWorkflow } from '../dist/workflow-model.js';

test('fields keep their limits: keys from labels, choices needed, photo counts', () => {
  const r = normalizeFields([{ label: 'Panels installed', type: 'number', min: 1, decimals: 9 }, { label: 'Panels installed', type: 'number' }, { label: 'Roof', type: 'select', options: ['RCC', 'RCC', 'Tin'] },
    { label: 'Photos', type: 'photo', required: true, min: 0, max: 50 }, { label: 'Odd', type: 'weird' }]);
  assert.deepEqual(r.fields.map((f) => f.key), ['panels_installed', 'panels_installed_2', 'roof', 'photos', 'odd']);
  assert.equal(r.fields[0].decimals, 4); assert.deepEqual(r.fields[2].options, ['RCC', 'Tin']);
  assert.deepEqual([r.fields[3].min, r.fields[3].max, r.fields[3].geotag, r.fields[3].stamp], [1, 10, true, true], 'a required photo needs one; at most ten');
  assert.equal(r.fields[4].type, 'text');
  assert.equal(normalizeFields([{ label: 'Pick', type: 'select', options: [] }]).error, '“Pick” needs its choices');
  assert.equal(normalizeFields([{ type: 'text' }]).error, 'Field 1 needs a label');
});

test('answers are checked against the form, in its own words', () => {
  const { fields } = normalizeFields([{ label: 'Panels', type: 'number', required: true, min: 1, max: 100 }, { label: 'Serials', type: 'longtext', lines: true, required: true },
    { label: 'Checks', type: 'checklist', options: ['Earthing', 'Wiring'], required: true }, { label: 'Roof', type: 'select', options: ['RCC', 'Tin'] },
    { label: 'Where', type: 'location' }, { label: 'Day', type: 'date' }, { label: 'Ok?', type: 'yesno' }, { label: 'Photo', type: 'photo', required: true }]);
  assert.equal(checkAnswers(fields, {}).error, 'Fill in “Panels”');
  assert.equal(checkAnswers(fields, { panels: 0 }).error, '“Panels” is at least 1');
  assert.equal(checkAnswers(fields, { panels: 12, serials: 'A1' , checks: ['Earthing'] }).error, 'Tick everything in “Checks”');
  assert.deepEqual(checkAnswers(fields, { panels: 1, serials: ['A1', '', 'B2'], checks: ['Earthing', 'Wiring'] }).answers.serials, ['A1', 'B2'], 'a list from the phone');
  const ok = checkAnswers(fields, { panels: '12', serials: 'A1\n\n B2 ', checks: ['Earthing', 'Wiring'], roof: 'Tin', where: { lat: 18.52, lng: 73.85, accuracy: 9 }, day: '2026-10-11', ok: true, extra: 'ignored' });
  assert.deepEqual(ok.answers, { panels: 12, serials: ['A1', 'B2'], checks: ['Earthing', 'Wiring'], roof: 'Tin', where: { lat: 18.52, lng: 73.85, accuracy: 9 }, day: '2026-10-11', ok: true });
  assert.equal(checkAnswers(fields, { panels: 1, serials: 'x', checks: ['Earthing', 'Wiring'], roof: 'Slate' }).error, 'Choose one of the choices in “Roof”');
  assert.deepEqual(fileNeeds(fields), [{ key: 'photo', label: 'Photo', type: 'photo', min: 1, max: 4 }]);
});

test('the solar installation template: three forms and a workflow whose branch reads the installation form', () => {
  const t = TEMPLATES.find((x) => x.key === 'solar_install');
  for (const f of t.forms) assert.ok(normalizeFields(f.fields).fields, f.name);
  const install = normalizeFields(t.forms.find((f) => f.ref === 'install').fields).fields;
  assert.ok(install.some((f) => f.key === 'panels_installed' && f.type === 'number'));
  assert.deepEqual(fileNeeds(install).map((n) => [n.key, n.min]), [['photos_of_the_installed_panels', 2], ['customer_s_signature', 1]]);
  const def = normalizeWorkflow({ steps: t.workflow.steps }).def;
  assert.deepEqual(def.steps.map((s) => s.kind), ['task', 'task', 'task', 'decision', 'approval', 'task']);
  assert.deepEqual(def.steps[3].next[0].when, { field: 'install.panels_installed', op: 'gt', value: 10 });
});
