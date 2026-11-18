// DOCS-ACTIVITY (2320): the rules of "last activity" that need no database: the newest of several activities, a folder's
// activity rolled up from everything under it, newest-first ordering of folders and docs, and the compact trail.
// The database half (triggers, row security, what a private doc lets through) is tests/core/test_docs_activity.py.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byActivity, latest, mergeTrail, rollUp } from '../dist/doc-activity.js';

const at = (h) => new Date(Date.UTC(2026, 10, 17, h)).toISOString();
const who = (id, name = id) => ({ id, name, agent: false, photoAt: null });

test('the newest activity wins; nothing at all is null', () => {
  const edit = { at: at(9), kind: 'edited' }, comment = { at: at(11), kind: 'commented' }, move = { at: at(10), kind: 'moved' };
  assert.equal(latest(edit, comment, move), comment);
  assert.equal(latest(null, undefined, edit), edit);
  assert.equal(latest(null, undefined), null);
  assert.equal(latest({ at: at(9), kind: 'a' }, { at: at(9), kind: 'b' }).kind, 'a', 'a tie keeps the first given');
  assert.equal(latest({ at: 'not a date', kind: 'x' }, edit), edit, 'a bad time never wins');
});

test('a folder rises with whatever happened anywhere under it', () => {
  // Clients > Acme > Contracts, and Sales on its own.
  const folders = [{ id: 'clients', parentId: null }, { id: 'acme', parentId: 'clients' }, { id: 'contracts', parentId: 'acme' }, { id: 'sales', parentId: null }];
  const own = new Map([['contracts', { at: at(15), kind: 'edited', doc: 'nda' }], ['clients', { at: at(8), kind: 'created' }], ['sales', { at: at(12), kind: 'commented' }]]);
  const r = rollUp(folders, own);
  assert.equal(r.get('contracts').doc, 'nda');
  assert.equal(r.get('acme').at, at(15), 'the parent takes its child folder\'s newest');
  assert.equal(r.get('clients').at, at(15), 'and so does the top folder');
  assert.equal(r.get('sales').at, at(12));
  // Only what the viewer can see is passed in: a folder they cannot see is simply not in the list, so nothing climbs past it.
  const hidden = rollUp([{ id: 'acme', parentId: 'clients' }, { id: 'contracts', parentId: 'acme' }], own);
  assert.equal(hidden.get('acme').at, at(15));
  assert.equal(hidden.has('clients'), false, 'a folder not in the list gets nothing');
  // A loop (the database refuses one, but the walk must still end).
  const loop = rollUp([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }], new Map([['a', { at: at(1) }]]));
  assert.equal(loop.get('b').at, at(1));
});

test('folders and docs are listed newest activity first; never-active ones last, by name', () => {
  const list = [{ name: 'Zeta', activity: null }, { name: 'Alpha', activity: { at: at(9) } }, { name: 'Beta', activity: { at: at(14) } }, { name: 'Gamma', activity: null }];
  assert.deepEqual(byActivity(list).map((x) => x.name), ['Beta', 'Alpha', 'Gamma', 'Zeta']);
  assert.deepEqual(byActivity([{ title: 'Doc 10', activity: null }, { title: 'Doc 9', activity: null }]).map((x) => x.title), ['Doc 9', 'Doc 10'], 'numbers in names sort as numbers');
});

test('the trail is newest first, one "made" line that knows how it was made, and repeated edits folded', () => {
  const asha = who('asha', 'Asha'), ravi = who('ravi', 'Ravi');
  const items = [
    { at: at(8), kind: 'created', by: asha, via: null, viaLabel: null },                       // the first version
    { at: at(8), kind: 'created', by: asha, via: 'script', viaLabel: 'meeting notes tool' },   // the 'created' event
    { at: at(9), kind: 'edited', by: asha, via: null, viaLabel: null },
    { at: at(10), kind: 'edited', by: asha, via: null, viaLabel: null },
    { at: at(11), kind: 'commented', by: ravi, via: null, viaLabel: null, words: 'Looks good' },
    { at: at(12), kind: 'edited', by: asha, via: null, viaLabel: null },
    { at: at(13), kind: 'moved', by: asha, via: null, viaLabel: null, from: 'My Docs', to: 'Clients' },
    { at: at(14), kind: 'viewed', by: ravi, via: null, viaLabel: null, readPct: 80 },
  ];
  const t = mergeTrail(items);
  assert.deepEqual(t.map((x) => x.kind), ['viewed', 'moved', 'edited', 'commented', 'edited', 'created']);
  assert.equal(t.at(-1).via, 'script', 'the one "made" line says it was made by a tool');
  assert.equal(t.at(-1).viaLabel, 'meeting notes tool');
  assert.equal(t[4].times, 2, 'two edits in a row by Asha are one line');
  assert.equal(t[2].times, undefined, 'an edit after a comment is its own line');
  assert.equal(mergeTrail(items, 2).length, 2, 'at most the limit');
  // An edit through the API key is not folded into one made in the app.
  const mixed = mergeTrail([{ at: at(9), kind: 'edited', by: asha, via: 'api', viaLabel: 'Claude' }, { at: at(10), kind: 'edited', by: asha, via: null, viaLabel: null }]);
  assert.equal(mixed.length, 2);
});

test('a folder\'s trail keeps one "made" line per doc and folds only the same doc\'s edits', () => {
  const asha = who('asha', 'Asha');
  const items = [
    { at: at(8), kind: 'created', by: asha, via: null, viaLabel: null, doc: { id: 'd1', title: 'One' } },
    { at: at(9), kind: 'created', by: asha, via: null, viaLabel: null, doc: { id: 'd2', title: 'Two' } },
    { at: at(10), kind: 'edited', by: asha, via: null, viaLabel: null, doc: { id: 'd1', title: 'One' } },
    { at: at(11), kind: 'edited', by: asha, via: null, viaLabel: null, doc: { id: 'd2', title: 'Two' } },
    { at: at(12), kind: 'edited', by: asha, via: null, viaLabel: null, doc: { id: 'd2', title: 'Two' } },
  ];
  const t = mergeTrail(items, 30, { oneDoc: false });
  assert.deepEqual(t.map((x) => `${x.kind}:${x.doc.id}:${x.times ?? 1}`), ['edited:d2:2', 'edited:d1:1', 'created:d2:1', 'created:d1:1']);
});
