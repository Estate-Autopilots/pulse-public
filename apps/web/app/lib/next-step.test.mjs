// NO-DEAD-ENDS (owner, 30 Oct 2026: "if this screen arrives no one knows what to do; what needs doing must already be
// prompted"): a refusal that names its own fix opens that fix with one button (ui.tsx Message).
import assert from 'node:assert/strict';
import test from 'node:test';
import { NEXT_STEP } from './next-step.mjs';
import { NOTICES } from './notices.mjs';

test('every next step answers one of Pulse\'s own sentences and opens a page in Pulse', () => {
  assert.ok(Object.keys(NEXT_STEP).length >= 4);
  for (const [said, step] of Object.entries(NEXT_STEP)) {
    assert.ok(NOTICES.has(said), `not a Pulse notice: ${said}`);
    assert.match(step.action.href, /^\/[a-z]/, said);
    assert.ok(step.title && step.text && step.action.label, said);
  }
});

test('the refusals that name a fix the person can make have a button for it', () => {
  const fixable = /^(Change your issued password|Finance access unavailable\. Set up two-step|Set up two-step verification|Finish setting up your profile)/;
  const named = [...NOTICES].filter((said) => fixable.test(said));
  assert.ok(named.length >= 2, 'the fixable refusals are collected into notices.mjs');
  for (const said of named) assert.ok(NEXT_STEP[said], `no button for: ${said}`);
});

test('two-step refusals open the set-up on Account / Security', () => {
  for (const [said, step] of Object.entries(NEXT_STEP)) if (/two-step/i.test(said)) assert.equal(step.action.href, '/account?tab=two-step');
});
