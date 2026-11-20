// WL-E2E (7 Nov 2026): who reviews a quotation's approval task (submit_quotation), and when its draft may be deleted.
// The reviewer is the AI employee's owner, unless the owner is the approver (then none: task_save refused reviewer =
// assignee, so an AI employee could not ask its own owner to approve); a person's own call keeps Pulse's default. A draft
// is kept while its task is open, and can be deleted once that task is done or cancelled. Synthetic ids only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalReviewer } from '../dist/v1-kit.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1', FINANCE = '00000000-0000-4000-8000-0000000000b2';

test('the approval task of an AI employee\'s quotation: its owner reviews, unless the owner approves it', () => {
  assert.equal(approvalReviewer(OWNER, FINANCE), OWNER, 'someone else approves: the owner reviews the task');
  assert.equal(approvalReviewer(OWNER, OWNER), '', 'the owner approves: no reviewer (task_save reads "" as none)');
  assert.equal(approvalReviewer(null, FINANCE), undefined, 'a person\'s own call: Pulse\'s default reviewer');
});

test('a draft whose task is done or cancelled can be deleted; an open or unseen task keeps it', async () => {
  const { draftHeldByTask } = await import('../dist/erp.js');
  assert.equal(draftHeldByTask(null, null), false, 'no task: the draft can go');
  for (const s of ['done', 'accepted', 'cancelled']) assert.equal(draftHeldByTask(OWNER, s), false, `a ${s} task no longer holds it`);
  for (const s of ['open', 'in_progress', 'blocked', 'in_review', null]) assert.equal(draftHeldByTask(OWNER, s), true, `a ${s ?? 'hidden'} task holds it`);
});
