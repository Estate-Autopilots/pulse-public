import test from 'node:test';
import assert from 'node:assert/strict';
import { draftMessage, heuristicPlanner, namedPeople, noteSteps, planHash } from '../dist/ai/task-planner.js';
import { sameWork as apiSame, workTokens as apiTokens, SAME_WORK_AT as apiAt } from '../dist/task-focus.js';
import { sameWork as webSame, workTokens as webTokens, SAME_WORK_AT as webAt } from '../../../apps/web/app/lib/task-sense.mjs';

const kedab = { id: 'k', name: 'Kedab Mifos', role: 'Co-founder', pod: 'Leadership', department: 'Leadership' };
const asha = { id: 'a', name: 'Asha Kireteso', role: 'HR executive', pod: 'Shared', department: 'Operations' };
const rifob = { id: 'r', name: 'Rovan Iyer', role: 'Engineer', pod: 'Tech', department: 'Technology' };
const staff = [kedab, asha, rifob];
const base = { title: '', notes: null, valueNote: null, dueText: null, overdue: false, estimateMinutes: 15, doer: kedab, reviewer: asha, viewerIsDoer: true, waiting: [], blockers: [], related: [], staff };

test('the same work: the API and the web read titles the same way', () => {
  const pairs = [
    ['Approve the staff notice that enables check-in and ID uploads', 'Approve staff notice v2 (privacy and consent)'],
    ['Change the billing email on every vendor to billing@', 'Ask the CA to change the GST portal email to billing@'],
    ['Send HR the office Wi-Fi name and the office public IP', 'Add the office Wi-Fi and IP in Pulse → HR → Policies → Office presence'],
    ['Export all invoices from Zoho', 'Export every invoice from Zoho Books'],
    ['Fix login', 'Fix login on phone'],
  ];
  assert.equal(apiAt, webAt);
  for (const [a, b] of pairs) { assert.deepEqual(apiTokens(a), webTokens(a)); assert.equal(apiSame(a, b), webSame(a, b), `${a} / ${b}`); }
  assert.ok(apiSame(pairs[0][0], pairs[0][1]) >= apiAt, 'the owner\'s example is suggested');
  assert.equal(apiSame(pairs[1][0], pairs[1][1]), 0, 'related work with another verb is not');
});

test('Pip plans from the notes: their numbered steps, who the task names, the fastest path and a message to copy', async () => {
  const p = await heuristicPlanner.plan({ ...base, title: 'Send HR the office Wi-Fi name and the office public IP',
    notes: 'Send HR two things.\n1. Connect a phone or laptop to the office Wi-Fi.\n2. Search Google for "what is my IP".\n3. Send both to Asha on WhatsApp.',
    waiting: [{ title: 'Add the office Wi-Fi and IP in Pulse', person: asha }] });
  assert.equal(p.fromNotes, true);
  assert.deepEqual(p.steps.map((s) => s.text), ['Connect a phone or laptop to the office Wi-Fi.', 'Search Google for "what is my IP".', 'Send both to Asha on WhatsApp.']);
  assert.equal(p.ask[0].id, 'a');
  assert.match(p.fastest.join(' '), /About 15 min/);
  assert.match(p.fastest.join(' '), /unlocks a task for Asha/);
  assert.equal(p.message.channel, 'WhatsApp');
  assert.equal(p.message.to, 'Asha Kireteso');
  assert.equal(p.message.text, 'Hi Asha, here are the details you asked for:\n• Office Wi-Fi name: ____\n• Office public IP: ____\n— Kedab');
  assert.equal(p.planner, 'pip-planner-heuristic');
});

test('Pip writes the message the task needs, with blanks only the person can fill, and never sends it', () => {
  const m = (title, notes = null, extra = {}) => draftMessage({ ...base, title, notes, ...extra }, asha).text;
  assert.equal(m('Approve staff notice v2 (privacy and consent)'), 'Hi Asha, I have read staff notice v2 (privacy and consent) and I approve it. Please go ahead.\n— Kedab');
  assert.equal(m('Decide the check-in rules', 'Decide:\n1. Arrival: ask first or automatic.\n2. Reminder times.'), 'Hi Asha, my decision on the check-in rules:\n1. Arrival: ____\n2. Reminder times: ____\n— Kedab');
  assert.equal(m('Ask the CA to change the GST portal email to billing@'), 'Hi, could you please change the GST portal email to billing@? Thank you.\n— Kedab');
  assert.equal(draftMessage({ ...base, title: 'Ask the CA to file' }, asha).to, null, 'the CA, not the reviewer');
  assert.equal(draftMessage({ ...base, title: 'Ask Rovan to review the PR' }, asha).to, 'Rovan Iyer');
  assert.equal(m('Send Pulse invites to the whole team'), 'Hi Asha, here is the detail you asked for:\n• Pulse invites: ____\n— Kedab');
  assert.equal(m('Make sure HR invites everyone to Pulse on Monday 10:00'), 'Hi Asha, just checking: HR invites everyone to Pulse on Monday 10:00. Is that on track? Anything you need from me?\n— Kedab');
});

test('people are named by full or unique first name; HR means the HR people', () => {
  assert.deepEqual(namedPeople('Send both to Asha on WhatsApp', staff).map((n) => n.person.id), ['a']);
  assert.deepEqual(namedPeople('Tell HR who has left', staff).map((n) => [n.person.id, n.via]), [['a', 'hr']]);
  assert.deepEqual(namedPeople('Ask Kir about it', staff), []);
  assert.deepEqual(noteSteps('Intro\n1. One\n2) Two\nOutro'), ['One', 'Two']);
});

test('the kept plan is keyed by what it depends on', () => {
  assert.equal(planHash({ a: 1 }), planHash({ a: 1 }));
  assert.notEqual(planHash({ a: 1 }), planHash({ a: 2 }));
  assert.match(planHash({}), /^[0-9a-f]{32}$/);
});
