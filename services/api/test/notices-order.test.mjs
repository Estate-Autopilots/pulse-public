import test from 'node:test';
import assert from 'node:assert/strict';
import { stackCards } from '../dist/notices.js';
import { pingSettings } from '../dist/notification-policy.js';

// ATT: the bell's order and folding (services/api/src/notices.ts), with cards shaped like noticeList's.
const card = (id, priority, family, at, extra = {}) => ({ id, ids: [id], title: `Card ${id}`, priority, family, at, readAt: null, group: 'update', state: 'open', actions: [], open: { label: 'Open', href: '/tasks' }, ...extra });

test('urgent first, then what needs you, then for your information; newest first within each', () => {
  const { rows } = stackCards([
    card('fyi-new', 'fyi', 'company_updates', '2026-10-21T10:00:00Z'),
    card('needs-old', 'needs_you', 'approvals', '2026-10-20T09:00:00Z'),
    card('urgent', 'urgent', 'pay', '2026-10-19T08:00:00Z'),
    card('needs-new', 'needs_you', 'mentions', '2026-10-21T11:00:00Z'),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['urgent', 'needs-new', 'needs-old', 'fyi-new']);
});

test('three tasks assigned on one day fold into one stack; the cards stay findable', () => {
  const { rows, stacks } = stackCards([
    card('a', 'needs_you', 'tasks_assigned', '2026-10-21T09:00:00Z'),
    card('b', 'needs_you', 'tasks_assigned', '2026-10-21T09:05:00Z'),
    card('c', 'needs_you', 'tasks_assigned', '2026-10-21T09:10:00Z', { readAt: '2026-10-21T09:11:00Z' }),
    card('d', 'needs_you', 'tasks_assigned', '2026-10-20T09:00:00Z'),
  ]);
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].title, '3 tasks for you');
  assert.equal(stacks[0].unread, 2);
  assert.deepEqual(stacks[0].cards, ['c', 'b', 'a']);
  assert.match(stacks[0].body, /and 1 more$/);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.filter((r) => r.stack).map((r) => r.id), ['c', 'b', 'a']);
  assert.equal(rows.find((r) => r.id === 'd').stack, undefined, 'a card from another day stays on its own');
});

test('conversations and one-of-a-kind cards never fold; priorities never mix in a stack', () => {
  const { stacks } = stackCards([
    card('m1', 'needs_you', 'chats', '2026-10-21T09:00:00Z', { channelId: 'x' }),
    card('m2', 'needs_you', 'chats', '2026-10-21T09:01:00Z', { channelId: 'y' }),
    card('u1', 'fyi', 'task_updates', '2026-10-21T09:00:00Z'),
    card('u2', 'needs_you', 'task_updates', '2026-10-21T09:00:00Z'),
  ]);
  assert.deepEqual(stacks, []);
});

test('mute per family is kept, and only known families', () => {
  const s = pingSettings({ mute: { attendance_reminders: true, task_updates: true, nonsense: true } }, 'Asia/Kolkata');
  assert.equal(s.mute.attendance_reminders, true);
  assert.equal(s.mute.task_updates, true);
  assert.equal(s.mute.approvals, false);
  assert.equal('nonsense' in s.mute, false);
});
