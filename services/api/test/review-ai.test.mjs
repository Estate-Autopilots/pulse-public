// SETTINGS-APPLE (T1.3.3): the AI check's pure parts (tools/review-ai/score.mjs) and the sure-one rule (review-attention).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScores, promptFor } from '../../../tools/review-ai/score.mjs';
import { attention, rankAttention, withAi } from '../dist/review-attention.js';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

test('the prompt carries each suggestion and asks for JSON only', () => {
  const p = promptFor([{ id: A, kind: 'duplicate', title: 'Synthetic Co and Synthetic Co.', proposed: { keep: 'x' }, sourceConfidence: 0.8, evidence: '{"why":"same name"}' }]);
  assert.match(p, /Answer ONLY with a JSON array/);
  assert.ok(p.includes(`"id":"${A}"`) && p.includes('"type":"duplicate"'));
});

test('scores are kept only for asked ids, once, in range and with a reason', () => {
  const text = `Here you go:\n[{"id":"${A}","confidence":0.93,"reason":" Same  name and city. "},{"id":"${A}","confidence":0.1,"reason":"dup"},` +
    `{"id":"${B}","confidence":1.4,"reason":"x"},{"id":"unknown","confidence":0.5,"reason":"x"},{"id":"${B}","confidence":0.4}]`;
  assert.deepEqual(parseScores(text, [A, B]), [{ id: A, confidence: 0.93, reason: 'Same name and city.' }]);
  assert.deepEqual(parseScores('no json here', [A]), []);
  assert.deepEqual(parseScores('[not json]', [A]), []);
});

test('a sure one: the AI 90%+ sure (or the source 95%+ before it checked), no choice needed, not one-by-one', () => {
  const row = (x) => ({ id: A, kind: 'duplicate', title: 'Synthetic', proposed: {}, confidence: 0.7, evidence: {}, entityType: null, entityId: null, ...x });
  const base = attention(row({}), '2026-11-13');
  assert.equal(withAi(base, row({ aiConfidence: 0.95, aiReason: 'Same name' })).sure, !!base.action && !base.action.needs);
  assert.equal(withAi(base, row({ aiConfidence: 0.5, aiReason: 'Thin' })).sure, false);
  assert.equal(withAi(base, row({ aiConfidence: 0.95, aiReason: 'Same name', oneByOne: true })).sure, false);
  assert.deepEqual(withAi(base, row({ aiConfidence: 0.95, aiReason: 'Same name' })).ai, { confidence: 0.95, reason: 'Same name' });
  assert.equal(withAi(base, row({ confidence: 0.97 })).ai, null);
  assert.equal(rankAttention([row({ aiConfidence: 0.2, aiReason: 'No' })], '2026-11-13')[0].sure, false);
});
