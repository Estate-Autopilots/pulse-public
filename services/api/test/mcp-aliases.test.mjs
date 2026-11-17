// WL-QUOTE-LIVE: the MCP tool path maps the names models reach for onto the real fields, and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiArgs } from '../dist/mcp-aliases.js';

const ID = '0b6f3c1e-1111-4222-8333-944455556666';
test('lines: quantity → qty, catalogItemId/catalogueItemId → itemId; buyer: city → address; prices untouched', () => {
  const got = aiArgs('create_quotation', { clientId: ID, lines: [{ catalogItemId: ID, quantity: 2 }, { catalogueItemId: ID, qty: 1, rate: 250000 }, { itemId: ID, catalogItemId: 'x', quantity: 3, qty: 4 }],
    buyer: { name: 'Jivop Bakery', city: 'Nagpur', address: ['Plot 4'] } });
  assert.deepEqual(got.lines, [{ itemId: ID, qty: 2 }, { itemId: ID, qty: 1, rate: 250000 }, { itemId: ID, catalogItemId: 'x', quantity: 3, qty: 4 }], 'the real field, when given, wins (and the extra still fails validation)');
  assert.deepEqual(got.buyer, { name: 'Jivop Bakery', address: ['Plot 4', 'Nagpur'] });
  assert.deepEqual(aiArgs('revise_quotation', { lines: [{ quantity: 1, itemId: ID }] }).lines, [{ qty: 1, itemId: ID }]);
});
test('other tools and other fields are left exactly as sent', () => {
  const a = { name: 'X', quantity: 2, city: 'Pune' };
  assert.equal(aiArgs('create_client', a), a);
  assert.deepEqual(aiArgs('create_quotation', { lines: [{ itemId: ID, qty: 1, price: 5 }] }).lines, [{ itemId: ID, qty: 1, price: 5 }], 'a price name is never guessed into paise');
});

test('BHARATA-2: draft_quotation: words under other names, counts and rupees written as text, the language by its name', () => {
  const got = aiArgs('draft_quotation', { customer: 'Desai Dairy', lang: 'Marathi', submit: 'true',
    items: ['5 kW system', { name: 'transport', quantity: '1', priceRupees: '₹6,000' }, { item: 'warranty', qty: 2, discountPercent: '4%' }, { words: 'x', priceRupees: 'about 5000' }] });
  assert.deepEqual(got, { client: 'Desai Dairy', lang: 'mr', submit: true,
    items: [{ words: '5 kW system' }, { words: 'transport', qty: 1, priceRupees: 6000 }, { words: 'warranty', qty: 2, discountPercent: 4 }, { words: 'x', priceRupees: 'about 5000' }] });
  assert.equal(aiArgs('draft_quotation', { client: 'A', lang: 'Klingon' }).lang, undefined, 'an unknown language is left to Pulse');
  assert.equal(aiArgs('draft_quotation', { client: 'A', lang: 'hi' }).lang, 'hi');
  assert.deepEqual(aiArgs('draft_quotation', { client: 'A', clientId: null, draftId: null, items: [{ words: 'installation', qty: 1, priceRupees: null, discountPercent: null }] }),
    { client: 'A', items: [{ words: 'installation', qty: 1 }] }, 'null is not given');
  assert.deepEqual(aiArgs('draft_quotation', { client: 'A', items: [{ code: 'SV-DELIVERY', priceRupees: 2500 }, { code: 'PP-5.0', words: '5 kW system' }] }).items,
    [{ words: 'SV-DELIVERY', priceRupees: 2500 }, { words: 'PP-5.0 5 kW system' }], 'a catalogue code is the words');
});
