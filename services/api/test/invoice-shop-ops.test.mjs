// DEVAKRITI (17 Nov 2026): what an online shop needs after a verified payment, beside createInvoice / issueInvoice /
// recordPayment: the filed invoice as a PDF (a billing read) and its e-mail to the buyer (a billing write, a person's
// own connection only). Neither is an MCP tool: the model never pulls PDF bytes into its prompt, and an e-mail to a
// customer is not sent on an AI member's own judgement.
import assert from 'node:assert/strict';
import test from 'node:test';
import { v1Operations } from '../dist/v1.js';
import '../dist/v1-money.js';
import { documentMail } from '../dist/erp-mail.js';

const op = (id) => v1Operations().find((o) => o.operationId === id);

test('the invoice PDF is a billing read and no MCP tool', () => {
  const o = op('getInvoicePdf');
  assert.ok(o, 'getInvoicePdf is registered');
  assert.deepEqual([o.method, o.path, o.scope, o.mcp], ['GET', '/api/v1/billing/invoices/{documentId}/pdf', 'billing.read', undefined]);
  assert.deepEqual(o.response.required.slice().sort(), ['base64', 'buyer', 'due', 'fileName', 'id', 'mime', 'number', 'paid', 'size', 'status', 'total', 'url']);
});

test('e-mailing an invoice is a billing write that needs confirm, with at most five addresses, and no MCP tool', () => {
  const o = op('emailInvoice');
  assert.ok(o, 'emailInvoice is registered');
  assert.deepEqual([o.method, o.path, o.scope, o.mcp], ['POST', '/api/v1/billing/invoices/{documentId}/email', 'billing.write', undefined]);
  assert.deepEqual(o.body.required, ['confirm']);
  assert.equal(o.body.properties.to.maxItems, 5);
  assert.equal(o.body.additionalProperties, false);
  assert.match(o.summary, /a person only/);
});

test('the words the buyer reads: a seller with no GSTIN sends an invoice, paid in full', () => {
  const m = documentMail({ docType: 'invoice', number: 'INV/26-27/0007', total: 56900, balance: 0, buyer: { name: 'Meera Jivop' }, seller: { tradeName: 'Northstar Crafts', legalName: 'Asha Rao', gstin: null } }, { name: 'Asha Rao' });
  assert.equal(m.subject, 'Invoice INV/26-27/0007 from Northstar Crafts');
  assert.match(m.body, /^Hello Meera,/);
  assert.match(m.body, /Please find attached invoice INV\/26-27\/0007 for ₹569\.00\./);
  assert.match(m.body, /It is paid in full: thank you\./);
  assert.doesNotMatch(m.body, /tax invoice/i);
});
