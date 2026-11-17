import assert from 'node:assert/strict';
import test from 'node:test';
import { deskStageLabel } from './sales-desk.mjs';

test("a lead's stage reads in plain words, Sales X-Ray's own label first", () => {
  assert.equal(deskStageLabel('won', null), 'Won');
  assert.equal(deskStageLabel('proposal', ''), 'Proposal sent');
  assert.equal(deskStageLabel('new', ' Fresh from the synthetic expo '), 'Fresh from the synthetic expo');
  assert.equal(deskStageLabel('site_visit', null), 'Site visit');
  assert.equal(deskStageLabel('hot-callback', null), 'Hot callback');
  assert.equal(deskStageLabel('', null), 'New');
  assert.equal(deskStageLabel(null, undefined), 'New');
});
