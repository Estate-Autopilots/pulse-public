// TOKENS-TELEMETRY: what an AI employee's runtime may record as a decision made without a model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionNote } from '../dist/telemetry-ai-cost.js';

test('a decision note is kept to known routes, named rules and sane numbers', () => {
  assert.deepEqual(decisionNote({ taskType: 'chat.short', ruleKey: 'chat.screen_direct', savedEst: 13300.4, runId: 'r1', dedupe: 'run:r1' }),
    { taskType: 'chat.short', route: 'rule', ruleKey: 'chat.screen_direct', tokens: undefined, savedEst: 13300, outcome: 'done', runId: 'r1', subjectId: undefined, dedupe: 'run:r1' });
  assert.equal(decisionNote({ taskType: 'task.daily', route: 'skill', ruleKey: 'skill:bank-csv@3', tokens: 12, outcome: 'error' }).outcome, 'error');
  assert.equal(decisionNote({ taskType: 'chat.short', ruleKey: 'x', savedEst: -5 }).savedEst, undefined);
  for (const bad of [{ taskType: 'Chat', ruleKey: 'x' }, { taskType: 'chat.short', ruleKey: 'Has Space' }, { taskType: 'chat.short', ruleKey: 'x', route: 'model' }])
    assert.throws(() => decisionNote(bad), /taskType|ruleKey|route/);
});
