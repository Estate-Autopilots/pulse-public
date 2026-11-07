import assert from 'node:assert/strict';
import test from 'node:test';
import { MODULE_KEYS, ORG_CHOSEN, chosenOff, modulesFrom, modulesSchema, planAllows, readModules, serverOn, validateModules } from '../dist/modules.js';

const AC_OFF = ['designers', 'map', 'acquisition', 'chats', 'briefs', 'money', 'hr'];

test('module keys are the schema keys', () => {
  assert.deepEqual([...MODULE_KEYS], modulesSchema.properties.off.items.enum);
});

test('the modules schema accepts an off list and an empty one', () => {
  assert.deepEqual(validateModules({ off: AC_OFF }), { valid: true, errors: [] });
  assert.equal(validateModules({ off: [] }).valid, true);
});

test('the modules schema rejects unknown keys, extra fields, repeats and a missing list', () => {
  const unknown = validateModules({ off: ['map', 'crm'] });
  assert.equal(unknown.valid, false);
  assert.match(unknown.errors.join('; '), /\/off\/1/);
  assert.equal(validateModules({ off: ['map'], on: ['chats'] }).valid, false);
  assert.equal(validateModules({ off: ['map', 'map'] }).valid, false);
  assert.equal(validateModules({}).valid, false);
  assert.equal(validateModules(['map']).valid, false);
});

test('no document means every module is on', () => {
  assert.deepEqual(modulesFrom(undefined), { off: [] });
  assert.deepEqual(modulesFrom(null), { off: [] });
});

test('a document that fails the schema keeps its known keys in key order', () => {
  assert.deepEqual(modulesFrom({ off: ['hr', 'crm', 'map', 7], extra: true }), { off: ['map', 'hr'] });
  assert.deepEqual(modulesFrom({ off: 'map' }), { off: [] });
  assert.deepEqual(modulesFrom({ off: [...AC_OFF].reverse() }), { off: AC_OFF });
});

test('RELEASE-5: lane C modules are off until the server switches them on, with or without a document', async () => {
  const client = (body) => ({ query: async () => ({ rows: body ? [{ body }] : [] }) });
  const env = { PULSE_RELATIONSHIPS: '1', PULSE_SKILLS: '1', PULSE_JOBS: '1', PULSE_CHAT_IMPORT: 'preview', PULSE_CONNECTORS: 'setup', PULSE_CREATIVE: '1', PULSE_SALES_XRAY: '1' };
  assert.deepEqual(['relationships', 'skills', 'jobs', 'chat_import', 'connectors', 'creative', 'sales_xray'].map(k => serverOn(k, {})), [false, false, false, false, false, false, false]);
  assert.deepEqual(['relationships', 'skills', 'jobs', 'chat_import', 'connectors', 'creative', 'sales_xray'].map(k => serverOn(k, env)), [true, true, true, true, true, true, true]);
  assert.equal(serverOn('connectors', { PULSE_CONNECTORS: '1' }), true, 'RELEASE-6: reading connectors shows them too');
  assert.equal(serverOn('connectors', { PULSE_CONNECTORS: 'true' }), false);
  assert.equal(serverOn('chat_import', { PULSE_CHAT_IMPORT: '1' }), true);
  assert.equal(serverOn('jobs', { PULSE_JOBS: 'true' }), false);
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  try {
    for (const k of Object.keys(env)) delete process.env[k];
    assert.deepEqual(await readModules(client(null), 'org'), { off: ['relationships', 'skills', 'jobs', 'chat_import', 'connectors', 'creative', 'sales_xray', 'pulse_hq'] });
    assert.deepEqual(await readModules(client({ off: ['map', 'skills'] }), 'org'), { off: ['map', 'relationships', 'skills', 'jobs', 'chat_import', 'connectors', 'creative', 'sales_xray', 'pulse_hq'] });
    Object.assign(process.env, env);
    // DE-EA: a company with no document keeps the install's offer; a company with one chooses (its `on` or its pack).
    assert.deepEqual(await readModules(client(null), 'org'), { off: ['pulse_hq'] });
    assert.deepEqual(await readModules(client({ off: [] }), 'org'), { off: ['chat_import', 'connectors', 'creative', 'sales_xray', 'pulse_hq'] });
    assert.deepEqual(await readModules(client({ off: [], on: [...ORG_CHOSEN] }), 'org'), { off: ['pulse_hq'] });
    assert.deepEqual(await readModules(client({ off: ['jobs'], on: [...ORG_CHOSEN] }), 'org'), { off: ['jobs', 'pulse_hq'] }, 'a company can still switch one off');
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('PULSE-HQ: an organisation-only module is off unless the organisation switches it on', async () => {
  const client = (body) => ({ query: async () => ({ rows: body ? [{ body }] : [] }) });
  assert.equal((await readModules(client(null), 'org')).off.includes('pulse_hq'), true, 'no document: off');
  assert.equal((await readModules(client({ off: [] }), 'org')).off.includes('pulse_hq'), true, 'an ordinary document: off');
  assert.equal((await readModules(client({ off: [], on: ['pulse_hq'] }), 'org')).off.includes('pulse_hq'), false, 'the Pulse organisation: on');
  assert.equal((await readModules(client({ off: ['pulse_hq'], on: ['pulse_hq'] }), 'org')).off.includes('pulse_hq'), true, 'off wins');
  assert.equal(validateModules({ off: [], on: ['pulse_hq'] }).valid, true);
  assert.equal(validateModules({ off: [], on: ['hr'] }).valid, false);
});

test('DE-EA: a company-chosen module needs the install to offer it, the company or its pack to choose it, and its plan', async () => {
  const env = { PULSE_CHAT_IMPORT: '1', PULSE_CONNECTORS: '1', PULSE_CREATIVE: '1', PULSE_SALES_XRAY: '1' };
  assert.deepEqual(chosenOff([], [], null, env), ['chat_import', 'connectors', 'creative', 'sales_xray'], 'nobody chose them');
  assert.deepEqual(chosenOff(['creative'], [], null, env), ['chat_import', 'connectors', 'sales_xray'], 'its own on');
  assert.deepEqual(chosenOff([], ['creative', 'sales_xray'], null, env), ['chat_import', 'connectors'], 'its pack brings them');
  assert.deepEqual(chosenOff([...ORG_CHOSEN], [], 'trial', env), ['chat_import', 'connectors', 'sales_xray'], 'a trial keeps to the work tools');
  assert.deepEqual(chosenOff([...ORG_CHOSEN], [], 'growth', env), []);
  assert.deepEqual(chosenOff([...ORG_CHOSEN], [], null, {}), ['chat_import', 'connectors', 'creative', 'sales_xray'], 'an install that does not offer them');
  assert.equal(planAllows(null, 'sales_xray'), true, 'no plan row: the install company');
  assert.equal(planAllows('starter', 'connectors'), false);
  const client = (row) => ({ query: async () => ({ rows: [row] }) });
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, env);
    assert.deepEqual((await readModules(client({ body: { off: [] }, pack: 'real_estate_marketing', plan: null }), 'org')).off.filter(k => ORG_CHOSEN.includes(k)), ['chat_import', 'connectors'], 'the real-estate marketing pack brings Creative and Sales X-Ray');
    assert.deepEqual((await readModules(client({ body: { off: ['creative'] }, pack: 'real_estate_marketing', plan: null }), 'org')).off.filter(k => ORG_CHOSEN.includes(k)), ['chat_import', 'connectors', 'creative'], 'off wins over the pack');
    assert.equal(validateModules({ off: [], on: ['creative', 'sales_xray'] }).valid, true);
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
