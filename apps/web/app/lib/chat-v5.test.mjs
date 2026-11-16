// CHAT-V5: "remind me" and "send later" times in the company's zone, and their words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromLocalInput, laterChoices, localInput, whenWords, zoneOffset } from './chat-v5.mjs';

const IST = (s) => new Date(`${s}+05:30`);

test('India is 5 h 30 ahead of UTC', () => {
  assert.equal(zoneOffset(new Date('2026-10-24T10:00:00Z')), 330);
});

test('reminder choices on a Saturday afternoon: soon, this evening, tomorrow, Monday', () => {
  const now = IST('2026-10-24T15:10:00');   // a Saturday
  const got = laterChoices('reminder', now);
  assert.deepEqual(got.map(([l]) => l), ['In 20 minutes', 'In 1 hour', 'In 3 hours', 'This evening, 6:00 pm', 'Tomorrow, 9:00 am', 'Monday, 9:00 am']);
  assert.equal(got.find(([l]) => l.startsWith('Tomorrow'))[1], IST('2026-10-25T09:00:00').toISOString());
  assert.equal(got.find(([l]) => l.startsWith('Monday'))[1], IST('2026-10-26T09:00:00').toISOString());
});

test('late on a Sunday: no evening choice, and Monday is tomorrow (not twice)', () => {
  const got = laterChoices('send', IST('2026-10-25T21:30:00'));
  assert.deepEqual(got.map(([l]) => l), ['Tomorrow, 9:00 am', 'Tomorrow, 2:00 pm']);
});

test('when in words', () => {
  const now = IST('2026-10-24T15:10:00');
  assert.equal(whenWords(IST('2026-10-24T18:00:00').toISOString(), now), 'today, 6:00 pm');
  assert.equal(whenWords(IST('2026-10-25T09:00:00').toISOString(), now), 'tomorrow, 9:00 am');
  assert.match(whenWords(IST('2026-10-27T09:30:00').toISOString(), now), /^Tue,? 27 Oct, 9:30 am$/);
});

test('a picked date and time is read in the company zone, both ways', () => {
  const iso = fromLocalInput('2026-10-25T09:00');
  assert.equal(iso, IST('2026-10-25T09:00:00').toISOString());
  assert.equal(localInput(iso), '2026-10-25T09:00');
  assert.equal(fromLocalInput('tomorrow'), null);
});
