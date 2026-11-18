// CONTRACTS-3: "Compare" — two drafts word by word, clause by clause.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareClauses, diffWords } from '../src/agreement-text.js';

const V1 = `This agreement is between Kedab Studio and Lotus Interiors.

1. The work
Design and build of the living room.

2. Price and payment
The total is ₹4,20,000. You pay 50% on signing.

3. Warranty
One year on fittings.`;
const V2 = `This agreement is between Kedab Studio and Lotus Interiors.

1. The work
Design and build of the living room.

2. Price and payment
The total is ₹4,20,000. You pay 30% on signing and 40% on delivery.

4. Ending the agreement
Either side may end it with 15 days' notice.`;

test('diffWords marks only the words that changed', () => {
  const d = diffWords('You pay 50% on signing.', 'You pay 30% on signing and 40% on delivery.');
  assert.equal(d.filter((x) => x.kind !== 'removed').map((x) => x.text).join(''), 'You pay 30% on signing and 40% on delivery.');
  assert.equal(d.filter((x) => x.kind !== 'added').map((x) => x.text).join(''), 'You pay 50% on signing.');
  assert.ok(d.some((x) => x.kind === 'removed' && x.text.includes('50%')) && d.some((x) => x.kind === 'added' && x.text.includes('30%')));
});

test('diffWords: spaces alone are no change, and the same text has no marks', () => {
  assert.deepEqual(diffWords('One year  on fittings.', 'One year on fittings.').map((x) => x.kind), ['same']);
  assert.deepEqual(diffWords('', ''), []);
  assert.deepEqual(diffWords('', 'New words'), [{ kind: 'added', text: 'New words' }]);
});

test('compareClauses names each clause as same, changed, added or removed, in the newer order', () => {
  const c = compareClauses(V1, V2);
  assert.deepEqual(c.map((x) => [x.name, x.status]), [['Opening', 'same'], ['1. The work', 'same'], ['2. Price and payment', 'changed'],
    ['3. Warranty', 'removed'], ['4. Ending the agreement', 'added']]);
  const price = c.find((x) => x.name === '2. Price and payment');
  assert.ok(price.words.some((w) => w.kind === 'added' && w.text.includes('40%')));
  assert.deepEqual(c.find((x) => x.status === 'removed').words, [{ kind: 'removed', text: 'One year on fittings.' }]);
});

test('diffWords: a rewritten phrase reads as one taken-out part and one added part', () => {
  const d = diffWords('You pay as set out in the quotation or invoice. If late, we pause.',
    'You pay in three parts: 40% when you sign, 40% at the midpoint and 20% at handover. If late, we pause.');
  const changed = d.filter((x) => x.kind !== 'same');
  assert.equal(changed.length, 2);
  assert.ok(changed[0].kind === 'removed' && changed[0].text.includes('as set out in the quotation or invoice'));
  assert.ok(changed[1].kind === 'added' && changed[1].text.includes('in three parts: 40% when you sign'));
  assert.equal(d.filter((x) => x.kind !== 'removed').map((x) => x.text).join(''), 'You pay in three parts: 40% when you sign, 40% at the midpoint and 20% at handover. If late, we pause.');
  assert.equal(d.filter((x) => x.kind !== 'added').map((x) => x.text).join(''), 'You pay as set out in the quotation or invoice. If late, we pause.');
});
