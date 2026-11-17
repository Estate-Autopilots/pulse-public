// WL-QUOTE-LIVE: a refused API v1 field says what to fix (the AI employee's next try depends on it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { hint } from '../dist/v1.js';

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
