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

test('WL-DOCS: list_tasks as models word it: status and who by meaning, a limit as a number, nulls left out', () => {
  assert.deepEqual(aiArgs('list_tasks', { status: 'pending', limit: 20 }), { status: 'open', limit: '20' });
  assert.deepEqual(aiArgs('list_tasks', { status: 'in_progress', who: 'all' }), { status: 'open', who: 'anyone' });
  assert.deepEqual(aiArgs('list_tasks', { who: 'anyone', status: 'completed', limit: '500' }), { who: 'anyone', status: 'done', limit: '100' });
  assert.deepEqual(aiArgs('list_tasks', { status: 'urgent-ish', who: 'Ravi', limit: 0, assigneeId: null, query: '' }), {}, 'what it cannot read is left out (the default applies)');
  assert.deepEqual(aiArgs('list_tasks', { assignee: ID, search: 'Approve quotation', status: 'open' }), { assigneeId: ID, query: 'Approve quotation', status: 'open' });
  assert.deepEqual(aiArgs('list_tasks', { status: 'done', who: 'me', limit: '5' }), { status: 'done', who: 'me', limit: '5' }, 'a right call is untouched');
});

test('WL-DOCS: send_doc: the reader under personId, recipient … is "to" (an id only; "to" itself wins)', () => {
  assert.deepEqual(aiArgs('send_doc', { docId: ID, personId: ID, ask: 'read' }), { docId: ID, ask: 'read', to: ID });
  assert.deepEqual(aiArgs('send_doc', { docId: ID, recipient: ID }), { docId: ID, to: ID });
  const named = { docId: ID, person: 'Asha' };
  assert.equal(aiArgs('send_doc', named), named, 'a name is not an id: left for Pulse to refuse with its own words');
  const given = { docId: ID, to: ID, personId: 'x' };
  assert.equal(aiArgs('send_doc', given), given);
});

test('WL-DOCS: create_doc: "open it beside the chat" is not an argument (the runtime opens it)', () => {
  assert.deepEqual(aiArgs('create_doc', { title: 'Site visit checklist', markdown: '- Roof photos', openBeside: true }), { title: 'Site visit checklist', markdown: '- Roof photos' });
  assert.deepEqual(aiArgs('create_doc', { title: 'T', open: 'side panel', show: true, access: 'private' }), { title: 'T', access: 'private' });
  const plain = { title: 'T', markdown: 'x', shareWithChat: ID };
  assert.equal(aiArgs('create_doc', plain), plain, 'a right call is untouched');
});
