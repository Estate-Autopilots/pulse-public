// BUGKIT-TELEMETRY (1682): replay chunks are checked again on the server (typed text refused), and the settings merge.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { mergeSettings, parseReplayChunk, SETTING_DEFAULTS, unmaskedText, clientSettings } from '../dist/replay-model.js';

const now = Date.UTC(2026, 10, 6, 10);
const snapshot = (value) => ({ type: 2, timestamp: now - 1000, data: { node: { type: 0, childNodes: [{ type: 2, tagName: 'html', attributes: {}, childNodes: [
  { type: 2, tagName: 'input', attributes: { type: 'text', value }, childNodes: [] },
  { type: 2, tagName: 'input', attributes: { type: 'checkbox', value: 'on' }, childNodes: [] },
  { type: 2, tagName: 'p', attributes: {}, childNodes: [{ type: 3, textContent: 'Open tasks' }] }] }] } } });
const chunk = (events, extra = {}) => ({ sid: 'sessionAAAA1111', seq: 0, route: '/people/7f3c2a10-1b2c-4d5e-8f90-112233445566?tab=leave', from: now - 2000, to: now - 500, n: events.length,
  gz: gzipSync(JSON.stringify(events)).toString('base64'), ...extra });

test('a masked chunk is stored as sent, with its screen as a template', () => {
  const c = parseReplayChunk(chunk([{ type: 4, timestamp: now - 2000, data: {} }, snapshot('******'), { type: 3, timestamp: now - 600, data: { source: 5, text: '****', isChecked: false } }]), now);
  assert.equal(c.events, 3); assert.equal(c.reason, 'sample'); assert.equal(c.route, '/people/:id?tab');
  assert.equal(c.data[0], 0x1f);
});

test('typed text anywhere in a chunk is refused: input events, field values, text areas, value changes', () => {
  assert.throws(() => parseReplayChunk(chunk([snapshot('my password')]), now), /typed text/);
  assert.throws(() => parseReplayChunk(chunk([{ type: 3, timestamp: now - 600, data: { source: 5, text: 'hello' } }]), now), /typed text/);
  assert.equal(unmaskedText([{ type: 3, data: { source: 0, adds: [{ node: { type: 2, tagName: 'textarea', attributes: {}, childNodes: [{ type: 3, textContent: 'a note' }] } }] } }]), 'textarea text');
  assert.equal(unmaskedText([{ type: 3, data: { source: 0, attributes: [{ id: 4, attributes: { value: 'abc' } }] } }]), 'value attribute');
  assert.equal(unmaskedText([snapshot('')]), null, 'an empty field is fine');
});

test('not a chunk: bad session, not gzip, too old, empty', () => {
  assert.throws(() => parseReplayChunk({ ...chunk([snapshot('*')]), sid: 'x' }, now), /session/);
  assert.throws(() => parseReplayChunk({ ...chunk([snapshot('*')]), gz: Buffer.from('[]').toString('base64') }, now), /compressed/);
  assert.throws(() => parseReplayChunk(chunk([snapshot('*')], { from: now - 5 * 86_400_000 }), now), /times/);
  assert.throws(() => parseReplayChunk(chunk([]), now), /no events/);
});

test('settings: defaults on with 30 days, an admin change is checked', () => {
  assert.equal(SETTING_DEFAULTS.enabled, true); assert.equal(SETTING_DEFAULTS.replay, true); assert.equal(SETTING_DEFAULTS.retentionDays, 30);
  const next = mergeSettings(SETTING_DEFAULTS, { replay: false, retentionDays: 90, sample: 0.25, junk: 1 });
  assert.equal(next.replay, false); assert.equal(next.retentionDays, 90); assert.equal(next.sample, 0.25); assert.equal(next.enabled, true);
  assert.throws(() => mergeSettings(SETTING_DEFAULTS, { retentionDays: 3 }), /7 and 365/);
  assert.throws(() => mergeSettings(SETTING_DEFAULTS, { enabled: 'yes' }), /on or off/);
  assert.throws(() => mergeSettings(SETTING_DEFAULTS, { bugProjectId: 'nope' }), /project/);
  assert.deepEqual(clientSettings({ ...SETTING_DEFAULTS, enabled: false }), { enabled: false, replay: false, sample: 1, replaySample: 1, prompts: true });
});
