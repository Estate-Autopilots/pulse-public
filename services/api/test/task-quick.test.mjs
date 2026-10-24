import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuick, matchPerson } from '../dist/task-quick.js';
import { streak } from '../dist/tasks.js';

// Synthetic people and projects only.
const people = [{ id: 'p1', name: 'Datup Synthetic', username: 'datup' }, { id: 'p2', name: 'Asha Rao' }, { id: 'p3', name: 'Asha Kireteso' }, { id: 'p4', name: 'Ravi Menon' }];
const projects = [{ id: 'j1', name: 'Pulse' }, { id: 'j2', name: 'Pulse Companion apps' }, { id: 'j3', name: 'Northstar Heights' }];
const today = '2026-10-10'; // a Saturday

test('the owner example reads assignee, project, due day and priority', () => {
  const r = parseQuick('Fix login on phone @Datup #Pulse fri !high', today, people, projects);
  assert.equal(r.title, 'Fix login on phone');
  assert.equal(r.assignee?.id, 'p1');
  assert.equal(r.project?.id, 'j1');
  assert.equal(r.dueOn, '2026-10-16');
  assert.equal(r.priority, 'high');
  assert.deepEqual(r.problems, []);
});

test('dates: today, tomorrow, next week, day month and in n days', () => {
  assert.equal(parseQuick('Call the CA today', today, people, projects).dueOn, '2026-10-10');
  assert.equal(parseQuick('Call the CA tomorrow', today, people, projects).dueOn, '2026-10-11');
  assert.equal(parseQuick('Plan next week', today, people, projects).dueOn, '2026-10-12');
  assert.equal(parseQuick('Send invoice 12 Oct', today, people, projects).dueOn, '2026-10-12');
  assert.equal(parseQuick('Send invoice 2 Jan', today, people, projects).dueOn, '2027-01-02');
  assert.equal(parseQuick('Renew in 3 days', today, people, projects).dueOn, '2026-10-13');
  assert.equal(parseQuick('Review sat', today, people, projects).dueOn, '2026-10-10');
});

test('a date word inside the title stays in the title', () => {
  const r = parseQuick('Monday review deck for Sun city', today, people, projects);
  assert.equal(r.title, 'Monday review deck for Sun city');
  assert.equal(r.dueOn, null);
});

test('ambiguous names are refused rather than guessed', () => {
  const r = parseQuick('Shoot plan @Asha', today, people, projects);
  assert.equal(r.assignee, null);
  assert.match(r.problems[0], /matches Asha Rao, Asha Kireteso/);
  assert.equal(matchPerson('asha.rao', [{ id: 'x', name: 'Asha Rao', username: 'asha.rao' }], null).person?.id, 'x');
  assert.match(parseQuick('Edit #Nowhere', today, people, projects).problems[0], /No project/);
});

test('priority shortcuts and @me', () => {
  const me = people[3];
  const r = parseQuick('Draft brief @me !!', today, people, projects, me);
  assert.equal(r.assignee?.id, 'p4');
  assert.equal(r.priority, 'urgent');
  assert.match(parseQuick('@Ravi', today, people, projects).problems.join(' '), /Add a few words/);
});

test('weekly streaks count back from this week or the last finished one', () => {
  assert.equal(streak(['2026-10-05', '2026-09-28', '2026-09-21', '2026-09-07'], '2026-10-05'), 3);
  assert.equal(streak(['2026-09-28', '2026-09-21'], '2026-10-05'), 2);
  assert.equal(streak(['2026-09-14'], '2026-10-05'), 0);
});

// TASKS-3: the live quick-add line in the web app reads the same way as the API (apps/web/app/lib/quick-parse.mjs).
test('the web line reads like the API: titles, people, projects, days and priority', async () => {
  const { parseLine } = await import('../../../apps/web/app/lib/quick-parse.mjs');
  const lines = ['Fix login on phone @Datup #Pulse fri !high', 'Call the CA today', 'Plan next week', 'Send invoice 12 Oct', 'Renew in 3 days', 'Monday review deck for Sun city',
    'Draft brief @me !!', 'Shoot plan @Asha', 'Pitch deck @Ravi Menon tomorrow', 'Edit #Northstar 2 Jan !low'];
  for (const line of lines) {
    const api = parseQuick(line, today, people, projects, people[3]), web = parseLine(line, { today, people, projects, me: people[3] });
    assert.deepEqual([web.title, web.assignee?.id ?? null, web.project?.id ?? null, web.dueOn, web.priority], [api.title, api.assignee?.id ?? null, api.project?.id ?? null, api.dueOn, api.priority], line);
  }
});

test('twin records and full names: "@Sana Khan" leaves the title alone and picks the record people sign in with', () => {
  const twins = [{ id: 's1', name: 'Sana Khan', username: 'sana' }, { id: 's2', name: 'Sana Khan' }, ...people];
  const r = parseQuick('Fix the pricing typo @Sana Khan !!', today, twins, projects);
  assert.equal(r.title, 'Fix the pricing typo'); assert.equal(r.assignee?.id, 's1'); assert.deepEqual(r.problems, []);
  assert.equal(parseQuick('Check the edit @Sana', today, twins, projects).assignee?.id, 's1');
  assert.equal(parseQuick('Pitch deck @Ravi Menon tomorrow', today, people, projects).title, 'Pitch deck');
});

test('the web line: a #word naming no project is a tag, and the word at the caret drives suggestions', async () => {
  const { parseLine, activeToken, cut } = await import('../../../apps/web/app/lib/quick-parse.mjs');
  const r = parseLine('Print the brochure #print #Pulse fri', { today, people, projects });
  assert.deepEqual(r.tags, ['print']); assert.equal(r.project?.id, 'j1'); assert.equal(r.title, 'Print the brochure'); assert.equal(r.dueOn, '2026-10-16');
  assert.deepEqual(activeToken('Send @As', 8), { kind: 'person', query: 'As', start: 5, end: 8 });
  assert.equal(activeToken('Send the deck', 13), null);
  assert.equal(cut('Send @As the deck', 5, 8), 'Send the deck');
});
