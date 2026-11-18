// CONNECTIONS: My connections merges each seat's list by connection id (the seat with a side wins), and seat ties are
// kept per real company; the home lists the companies you work with apart from the ones you are in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMine } from '../dist/connections-mine.js';
import { workWithList, workWithOf } from '../dist/home-across.js';

const seat = (org, over = {}) => ({ org, name: `Synthetic ${org}`, current: false, purpose: 'work', personal: false, ...over });

test('one entry per connection; acted on from the seat where you have a side', () => {
  const row = (mySide) => ({ id: 'c1', since: '2026-11-16T10:00:00Z', mySide });
  const { direct, ties } = mergeMine([
    { seat: seat('a'), here: { org: { id: 'a', name: 'A', kind: 'company' }, lead: false, direct: [row(null)], seats: [] } },
    { seat: seat('b'), here: { org: { id: 'b', name: 'B', kind: 'company' }, lead: true, direct: [row('a'), { id: 'c2', since: '2026-11-17T10:00:00Z', mySide: 'b' }],
      seats: [{ person: 'p', name: 'Ken', account: 'k', handle: 'ken', seat: 'staff', side: 'staff', role: null, agreement: 'none' }] } },
    { seat: seat('t', { purpose: 'test' }), here: { org: { id: 't', name: 'T', kind: 'company' }, lead: true, direct: [],
      seats: [{ person: 'q', name: 'Tester', account: 'x', handle: 'x', seat: 'staff', side: 'staff', role: null, agreement: 'none' }] } },
    { seat: seat('down'), here: null },
  ]);
  assert.deepEqual(direct.map((d) => d.id), ['c2', 'c1']);
  const c1 = direct.find((d) => d.id === 'c1');
  assert.equal(c1.from, 'b');
  assert.deepEqual(c1.via.map((v) => v.org), ['a', 'b']);
  assert.deepEqual(ties.map((t) => t.org), ['b'], 'a test company has no seat ties');
});

test('companies you work with: not the ones you are in, one line per company and relationship', () => {
  const via = { org: 'a', name: 'Synthetic A' };
  const rows = [workWithOf({ id: '1', kind: 'client', weServe: true, other: { org: 'g', name: 'Greenline' } }, via),
    workWithOf({ id: '2', kind: 'vendor', other: { org: 'b', name: 'Synthetic B' } }, via), workWithOf({ id: '3', other: { name: '' } }, via)];
  assert.equal(rows[2], null);
  assert.deepEqual(workWithList(rows.filter(Boolean), new Set(['b'])).map((w) => w.name), ['Greenline']);
});
