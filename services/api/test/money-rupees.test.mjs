// AI-FIX (19 Nov 2026, BUG-CENSUS BC-015): money tools answer in paise, and a model read ₹1,61,750 (16175000 paise) as
// ₹1,61,75,000. Every paise amount an AI employee's billing or finance tool answers has the same amount beside it as
// people read it (…Rupees, inRupees). The guard below walks every such tool's answer schema, so a new tool or field
// that answers paise alone fails here. Database checks: agent-api-runner.mjs, api-platform-runner.mjs, artha-fix-runner.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../dist/app.js';
import { v1Operations } from '../dist/v1.js';
import { rupees } from '../dist/v1-kit.js';

test('paise are said the way people write rupees', () => {
  assert.equal(rupees(16175000), '₹1,61,750');
  assert.equal(rupees(118050), '₹1,180.5');
  assert.equal(rupees(37373), '₹373.73');
  assert.equal(rupees(0), '₹0');
  assert.equal(rupees(-1800), '-₹18');
  assert.equal(rupees(1250000000), '₹1,25,00,000');
  assert.equal(rupees(120050, 'USD'), 'USD 1,200.5');
});

// Field names that carry paise in a billing or finance answer (counts such as qty, payments or paidInvoices are not).
const MONEY = new Set(['price', 'rate', 'total', 'amount', 'paid', 'due', 'taxable', 'tax', 'roundOff', 'cost', 'amountPaise', 'gstPaise', 'inflowPaise',
  'outflowPaise', 'base', 'gst', 'net', 'revenue', 'invoiced', 'gstBilled', 'gstToGstAccount', 'gstToMain', 'collected', 'otherIn', 'expenses', 'hr', 'refunds',
  'overpaid', 'tds', 'taxes', 'inputGst', 'gstOutstanding', 'baseOutstanding']);
// Not paise: amounts already in rupees (the Money records and a statement's lines, said so in the tool's description) and
// the Money records' row count.
const RUPEES_ALREADY = new Set(['listMoneyRecords:rows.amount', 'importBankStatement:sample.amount', 'listMoneyRecords:total']);
const numeric = (s) => [].concat(s?.type ?? []).some((t) => t === 'integer' || t === 'number');
const said = (props, k) => props[`${k}Rupees`] || (k.endsWith('Paise') && props[`${k.slice(0, -5)}Rupees`]) || props.inRupees?.properties?.[k];

function unsaid(op, schema, path, parent) {
  if (!schema || typeof schema !== 'object') return [];
  if (schema.anyOf) return schema.anyOf.flatMap((s) => unsaid(op, s, path, parent));
  if (schema.type === 'array' || [].concat(schema.type ?? []).includes('array')) return unsaid(op, schema.items, path, parent);
  const props = schema.properties;
  if (!props) return [];
  const out = [];
  for (const [k, s] of Object.entries(props)) {
    const where = path ? `${path}.${k}` : k;
    if (numeric(s) && MONEY.has(k) && !RUPEES_ALREADY.has(`${op.operationId}:${where}`)
      && !said(props, k) && !parent?.props?.[`${parent.key}InRupees`]?.properties?.[k]
      && !parent?.props?.[`${parent.key}${k[0].toUpperCase()}${k.slice(1)}Rupees`]) out.push(where);   // was.price -> wasPriceRupees
    out.push(...unsaid(op, s, where, { props, key: k }));
  }
  return out;
}

test('the guard itself: a paise field alone is caught; beside its rupees, in inRupees or a parent\'s …InRupees it is not', () => {
  const op = { operationId: 'x' }, o = (properties) => ({ type: 'object', properties });
  const int = { type: 'integer' }, s = { type: 'string' };
  assert.deepEqual(unsaid(op, o({ items: { type: 'array', items: o({ total: int, qty: int }) } }), '', null), ['items.total']);
  assert.deepEqual(unsaid(op, o({ total: int, totalRupees: s, amountPaise: int, amountRupees: s, tax: int, inRupees: o({ tax: s }) }), '', null), []);
  assert.deepEqual(unsaid(op, o({ totals: o({ net: { type: 'number' } }), totalsInRupees: o({ net: s }), was: o({ price: int }), wasPriceRupees: s }), '', null), []);
  assert.deepEqual(unsaid(op, o({ q: { anyOf: [o({ due: int }), { type: 'null' }] } }), '', null), ['q.due']);
});

test('every paise amount a billing or finance tool answers is also said in rupees', () => {
  const tools = v1Operations().filter((op) => op.mcp && /^(billing|finance)\./.test(op.scope));
  assert.ok(tools.length >= 25, `billing and finance tools found: ${tools.length}`);
  for (const name of ['search_catalogue', 'get_billing_document', 'create_quotation', 'record_payment', 'draft_quotation', 'list_finance_entries', 'get_finance_numbers',
    'import_bank_statement', 'update_catalog_item']) assert.ok(tools.some((op) => op.mcp.name === name), `${name} is checked`);
  const missing = tools.flatMap((op) => unsaid(op, op.response, '', null).map((f) => `${op.mcp.name}: ${f}`));
  assert.deepEqual(missing, [], 'paise without the rupees beside them');
});

test('the money tools say which field to read out', () => {
  const tools = new Map(v1Operations().filter((op) => op.mcp).map((op) => [op.mcp.name, op.mcp.description]));
  for (const [name, field] of [['search_catalogue', 'priceRupees'], ['get_billing_document', 'inRupees'], ['list_finance_entries', 'amountRupees'],
    ['list_expenses', 'amountRupees'], ['get_finance_numbers', 'totalsInRupees'], ['import_bank_statement', 'inflowRupees'], ['update_catalog_item', 'wasPriceRupees']]) {
    assert.ok(tools.get(name)?.includes(field), `${name} names ${field}`);
  }
});
