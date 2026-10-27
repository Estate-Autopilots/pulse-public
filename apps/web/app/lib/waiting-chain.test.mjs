import test from 'node:test';
import assert from 'node:assert/strict';
import { load, render, ui, aiBadge } from '../../../../tools/qa/updates-fixture.mjs';
import { chain, now } from '../../../../tests/e2e/fixtures/waiting-chain.mjs';
const { WaitingRows, nextAction } = load('tasks/waiting-chain.tsx', {
  '../ui': ui, '../kit/ai-badge': aiBadge, './client': { UnblockButton: ({ blockerId }) => `Clear ${blockerId}` },
});
const props = { chain, now, company: 'Northwind Studio', zone: 'UTC', taskId: 'tp-task', removable: ['synthetic-blocker-0', 'synthetic-blocker-1'] };
test('rows preserve task links, depth, owner identity, AI badge and only another company’s chip', () => {
  const html = render(WaitingRows, props);
  assert.match(html, /href="\/tasks\/synthetic-blocker-0"/);
  assert.match(html, /--depth:2/); assert.match(html, /Avery Example/); assert.match(html, /Studio Helper/);
  assert.equal((html.match(/aria-label="AI employee"/g) ?? []).length, 1);
  assert.doesNotMatch(html, />Northwind Studio</); assert.match(html, /Example Partner Studio/);
  const photographed = { ...chain, steps: [{ ...chain.steps[0], actor: { ...chain.steps[0].actor, photoAt: '2026-10-26T12:00:00Z' } }] };
  assert.match(render(WaitingRows, { ...props, chain: photographed }), /src="\/photo\/synthetic-owner-0\?v=/);
  assert.match(html, /waiting 3 days/); assert.match(html, /no answer yet/);
  assert.match(html, /Clear synthetic-blocker-0/); assert.doesNotMatch(html, /Clear synthetic-blocker-1/);
  assert.match(html, /A task you can&#x27;t open/); assert.doesNotMatch(html, /href="\/tasks\/synthetic-blocker-2"/);
  assert.match(html, /\+2 more/); assert.match(html, /Waiting on the client since 25 Oct 2026/);
});
test('all next-action labels and the company’s date zone are explicit', () => {
  const step = chain.steps[0];
  assert.equal(nextAction(step, 'UTC'), 'no answer yet');
  assert.equal(nextAction({ ...step, answer: 'on_it', answeredAt: '2026-10-26T23:30:00Z' }, 'Asia/Kolkata'), 'on it since 27 Oct 2026');
  assert.equal(nextAction({ ...step, answer: 'not_mine' }, 'UTC'), 'not theirs');
  assert.equal(nextAction({ ...step, next: 'closed', answer: 'on_it' }, 'UTC'), 'closed');
});
test('empty, singular, sub-day and continuation text never suggest zero work', () => {
  const empty = { ...chain, steps: [], declared: [], more: 0 };
  assert.match(render(WaitingRows, { ...props, chain: empty }), /Linked blockers and client waits appear here/);
  assert.doesNotMatch(render(WaitingRows, { ...props, chain: empty }), /\+0 more/);
  for (const [elapsed, expected] of [[86400000, 'waiting 1 day'], [0, 'waiting less than a day']])
    assert.match(render(WaitingRows, { ...props, now: Date.parse(chain.steps[0].since) + elapsed }), new RegExp(expected));
  assert.doesNotMatch(render(WaitingRows, { ...props, chain: { ...empty, more: 3 } }), /Nothing is waiting/);
});
