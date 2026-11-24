// PR-STUDIO: the words PR Studio writes (src/pr-copy.ts): chapters, briefs, the creative pack and the streak. Synthetic lines.
import assert from 'node:assert/strict';
import test from 'node:test';
import { autoSummary, chapters, composeBrief, composePack, headline, streak, tally, taskCount, weekOf } from '../dist/pr-copy.js';

const e = (id, happenedOn, kind, title, body = '') => ({ id, happenedOn, kind, title, body });
const lines = [
  e('a', '2026-11-05', 'task', '12 tasks done in Synthetic Studio', '- Cut reel one\n- Cut reel two'),
  e('b', '2026-11-05', 'bug', 'Bug #7 fixed', 'The save button did nothing on phones'),
  e('c', '2026-11-04', 'feature', 'Goals for every team', 'Set a goal and put the work under it'),
  e('d', '2026-11-03', 'release', 'Example App v1.2', 'Faster sign-in'),
  e('f', '2026-10-30', 'task', '1 task done in Example Project'),
];

test('the tally is specific: real task counts, singulars and an "and"', () => {
  assert.equal(taskCount(lines), 13);
  assert.equal(tally(lines), '1 release, 1 new feature, 1 bug fixed and 13 tasks done');
  assert.equal(tally([lines[1]]), '1 bug fixed');
  assert.equal(tally([]), '');
});

test('the Story reads as a book: months, weeks from Monday, days newest first, edited chapters kept', () => {
  assert.equal(weekOf('2026-11-08'), '2026-11-02');
  const book = chapters(lines, [{ period: 'week', startsOn: '2026-11-02', title: 'Goals week', summary: 'We shipped goals.' }]);
  assert.deepEqual(book.map((m) => m.startsOn), ['2026-11-01', '2026-10-01']);
  assert.equal(book[0].title, 'November 2026');
  assert.equal(book[0].weeks[0].title, 'Goals week');
  assert.equal(book[0].weeks[0].edited, true);
  assert.deepEqual(book[0].weeks[0].days.map((d) => d.day), ['2026-11-05', '2026-11-04', '2026-11-03']);
  // Within a day the bug outranks the tasks.
  assert.deepEqual(book[0].weeks[0].days[0].entries.map((x) => x.id), ['b', 'a']);
  // Oct 30 is in the week of Oct 26, inside October's chapter.
  assert.equal(book[1].weeks[0].startsOn, '2026-10-26');
  assert.match(autoSummary(lines), /^1 release, .* The headline: Example App v1\.2\.$/);
  assert.equal(autoSummary([]), 'A quiet stretch: nothing recorded yet.');
});

test('briefs lead with what moved and never go blank', () => {
  const m = composeBrief({ kind: 'morning', day: '2026-11-06', company: 'Synthetic Co', entries: lines.slice(0, 2), dueToday: 4, overdue: 1, untold: 3, streak: 2 });
  assert.equal(m.title, 'Good morning: Synthetic Co, 6 Nov');
  assert.match(m.body, /^\*Since yesterday:\* 1 bug fixed and 12 tasks done\./);
  assert.match(m.body, /\*Today:\* 4 due today, 1 overdue\./);
  assert.match(m.body, /🛠️ Bug #7 fixed — The save button did nothing on phones/);
  assert.match(m.body, /_3 things are done but not yet told · 2 days told in a row\._$/);
  const quiet = composeBrief({ kind: 'evening', day: '2026-11-06', company: 'Synthetic Co', entries: [] });
  assert.match(quiet.body, /Add a note so the day does not go blank/);
});

test('the creative pack: a release headline, WhatsApp bold, a long post and up to three images in the audience\'s shape', () => {
  assert.equal(headline(lines, 'Synthetic Co'), 'Example App v1.2 is live');
  assert.equal(headline([], 'Synthetic Co'), 'Synthetic Co: still building');
  const p = composePack(lines, { name: 'Testers', tone: 'bold', channel: 'telegram', ratio: '9:16' }, 'Synthetic Co');
  assert.match(p.copy, /^\*Example App v1\.2 is live\*\n\nWe kept shipping\. 5 wins, no pause\. 🚀/);
  assert.match(p.copy, /🚀 \*Example App v1\.2\*\n {3}Faster sign-in/);
  assert.match(p.copy, /Go try it\. Tell us what breaks\./);
  assert.ok(!/\n\n\n/.test(p.copy), 'no double blank lines');
  assert.match(p.longPost, /^Example App v1\.2 is live\.\n\n/);
  assert.match(p.longPost, /→ Goals for every team: Set a goal and put the work under it/);
  assert.equal(p.images.length, 3);
  assert.deepEqual(p.images.map((i) => [i.template, i.ratio]), [['headline', '9:16'], ['list', '9:16'], ['number', '9:16']]);
  assert.equal(p.images[2].big, '13');
  const one = composePack([lines[1]], { name: 'Team', tone: 'warm', channel: 'whatsapp', ratio: '1:1' }, 'Synthetic Co');
  assert.equal(one.headline, 'Bug #7 fixed');
  assert.equal(one.images.length, 1);
  assert.match(one.copy, /A quick one worth sharing 👇/);
});

test('the streak counts days told in a row, from today or yesterday', () => {
  assert.equal(streak(['2026-11-06', '2026-11-05', '2026-11-04', '2026-11-01'], '2026-11-06'), 3);
  assert.equal(streak(['2026-11-05', '2026-11-04'], '2026-11-06'), 2);
  assert.equal(streak(['2026-11-03'], '2026-11-06'), 0);
});
