import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSave, SITE_VISIT_DEFAULTS } from '../dist/site-visit-settings.js';

// EST-1407: what a site-visit settings save may change. Synthetic fields only.
const field = (key, extra = {}) => ({ key, label: key.replace(/_/g, ' '), hint: null, exampleImageId: null, required: false, maxPhotos: 1, position: 0, state: 'active', appliesTo: null, ...extra });
const v2 = { ...SITE_VISIT_DEFAULTS, fieldSetVersion: 2, fields: [field('roof_overview', { maxPhotos: 6 }), field('voltmeter_reading', { required: true, appliesTo: ['installation'] })] };
const save = (over) => ({ ...v2, ...over });

test('version 1 seeds survey, installation and service, no fields and every banner item on', () => {
  assert.deepEqual(SITE_VISIT_DEFAULTS.visitTypes.map((t) => t.key), ['survey', 'installation', 'service']);
  assert.equal(SITE_VISIT_DEFAULTS.fields.length, 0);
  assert.ok(Object.values(SITE_VISIT_DEFAULTS.banner).every(Boolean));
  assert.equal(checkSave(SITE_VISIT_DEFAULTS, { ...v2, fieldSetVersion: 1 }), null, 'the first save adds fields to the defaults');
});

test('a save from the newest version may rename, reorder, hide, archive and add', () => {
  const next = save({ fields: [field('roof_overview', { label: 'Roof, whole', position: 1, state: 'hidden' }), field('voltmeter_reading', { state: 'archived', position: 0 }), field('panel_serials', { maxPhotos: 20 })] });
  assert.equal(checkSave(v2, next), null);
});

test('keys are never removed: leaving one out is 422 and names it', () => {
  const r = checkSave(v2, save({ fields: [field('roof_overview')] }));
  assert.equal(r.status, 422); assert.deepEqual(r.keys, ['voltmeter_reading']);
  assert.deepEqual(checkSave(v2, save({ visitTypes: SITE_VISIT_DEFAULTS.visitTypes.slice(0, 2) })).keys, ['service']);
});

test('a save made from an older version is 409', () => {
  assert.equal(checkSave(v2, save({ fieldSetVersion: 1 })).status, 409);
});

test('a v2 save after v3 added a field is 409 before keys_removed', () => {
  const v3 = { ...v2, fieldSetVersion: 3, fields: [...v2.fields, field('panel_serials')] };
  const problem = checkSave(v3, save({ banner: { ...v2.banner, logo: false } }));
  assert.equal(problem.status, 409);
  assert.equal(problem.keys, undefined);
});

test('the shape is strict', () => {
  for (const bad of [
    save({ extra: 1 }),
    save({ fields: [...v2.fields, field('Bad Key')] }),
    save({ fields: [...v2.fields, field('roof_overview')] }),                       // a key twice
    save({ fields: [...v2.fields, field('x', { maxPhotos: 21 })] }),
    save({ fields: [...v2.fields, field('x', { exampleImageId: '00000000-0000-4000-8000-000000000000' })] }),   // uploads come with EST-1409
    save({ fields: [...v2.fields, field('x', { appliesTo: ['no_such_type'] })] }),
    save({ visitTypes: SITE_VISIT_DEFAULTS.visitTypes.map((t) => ({ ...t, state: 'archived' })) }),          // none active
    save({ banner: { ...v2.banner, qr: true } }),
  ]) assert.equal(checkSave(v2, bad)?.status, 400, JSON.stringify(bad).slice(0, 160));
});
