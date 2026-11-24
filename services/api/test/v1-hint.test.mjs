// WL-QUOTE-LIVE: a refused API v1 field says what to fix (the AI employee's next try depends on it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { flatInput, hint } from '../dist/v1.js';

test('an extra field is named, an id-shaped field asks for an id, anything else adds nothing', () => {
  assert.equal(hint({ keyword: 'additionalProperties', params: { additionalProperty: 'colour' } }), ' ("colour" is not a field here; leave it out)');
  assert.match(hint({ keyword: 'pattern', params: { pattern: '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' } }), /an id, not a name/);
  assert.equal(hint({ keyword: 'pattern', params: { pattern: '^[0-9]{4,8}$' } }), '');
  assert.equal(hint({ keyword: 'minimum', params: { limit: 0 } }), '');
  assert.equal(hint({}), '');
  assert.equal(hint({ keyword: 'additionalProperties', params: { additionalProperty: 'quantity' } }), ' ("quantity" is not a field here: send it as "qty")');
  assert.match(hint({ keyword: 'additionalProperties', params: { additionalProperty: 'catalogueItemId' } }), /send it as "itemId"/);
  assert.match(hint({ keyword: 'additionalProperties', params: { additionalProperty: 'city' } }), /a line of "address"/);
});

// AI-FIX (BUG-CENSUS BC-008): draft_quotation refused an item's "rate" with "leave it out" (and "price" pointed at "rate"),
// so the AI employee's next try had no price and the catalogue's price and GST went on. The refusing schema is known.
test('the hint follows the schema that refused: its own price and tax fields, else the fields it has', () => {
  const body = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false,
    properties: { words: {}, qty: {}, priceRupees: {}, discountPercent: {}, gstPercent: {} } } } } };
  const extra = (f) => hint({ keyword: 'additionalProperties', params: { additionalProperty: f }, schemaPath: '#/properties/items/items/additionalProperties' }, body);
  assert.equal(extra('rate'), ' ("rate" is not a field here: send it as "priceRupees" (rupees, as said))');
  assert.match(extra('price'), /send it as "priceRupees"/);
  assert.match(extra('gst'), /send it as "gstPercent"/);
  assert.match(extra('GSTRate'), /send it as "gstPercent"/);
  assert.match(extra('quantity'), /send it as "qty"/);
  assert.equal(extra('notes'), ' ("notes" is not a field here; the fields here are words, qty, priceRupees, discountPercent, gstPercent)');
  assert.match(extra('code'), /the fields here are words/, 'no "itemId" in this schema: not pointed at it');
  const lines = { type: 'object', properties: { lines: { type: 'array', items: { type: 'object', properties: { itemId: {}, qty: {}, rate: {}, gstRate: {} } } } } };
  const line = (f) => hint({ keyword: 'additionalProperties', params: { additionalProperty: f }, schemaPath: '#/properties/lines/items/additionalProperties' }, lines);
  assert.match(line('price'), /send it as "rate" \(paise\)/);
  assert.match(line('gstPercent'), /send it as "gstRate"/);
  assert.match(line('catalogueItemId'), /send it as "itemId"/);
  assert.equal(hint({ keyword: 'additionalProperties', params: { additionalProperty: 'colour' }, schemaPath: '#/nowhere/additionalProperties' }, body), ' ("colour" is not a field here; leave it out)');
});

// AI-FIX (BUG-CENSUS BC-022): list_triage_tasks({"limit": 100}) was refused 400 for EA's AI employees ("must be string"):
// a query value is text over HTTP and models send JSON. On the MCP path a number or true/false for a text query is that text.
test('an MCP call\'s number or true/false for a text query field is that text; other types and the body are untouched', () => {
  const op = { operationId: 'listThings', method: 'GET', mcp: { name: 'list_things' },
    query: { properties: { limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }, waiting: { enum: ['true', 'false'] }, n: { type: 'integer' }, mixed: { enum: [1, 'x'] } } } };
  const request = { headers: {} };
  assert.deepEqual(flatInput(op, { limit: 100, waiting: true, n: 3, mixed: 1 }, request), { query: { limit: '100', waiting: 'true', n: 3, mixed: 1 } });
  assert.deepEqual(flatInput(op, { limit: '50' }, request), { query: { limit: '50' } });
  assert.deepEqual(flatInput({ ...op, query: { properties: { ...op.query.properties, cursor: { type: 'string', minLength: 1 } } } }, { cursor: null, limit: 100 }, request), { query: { limit: '100' } }, 'the first page: cursor null is no cursor');
  assert.deepEqual(flatInput({ ...op, query: { properties: { ...op.query.properties, cursor: { type: 'string', minLength: 1 } } } }, { cursor: '' }, request), {});
  const write = { operationId: 'makeThing', method: 'POST', mcp: { name: 'make_thing' }, body: { properties: { count: { type: 'string' } } } };
  const out = flatInput(write, { count: 2 }, { headers: {} });
  assert.equal(out.body.count, 2, 'a body keeps its JSON types');
});
