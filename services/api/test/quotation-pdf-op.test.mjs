// TG-VOICE (7 Nov 2026): a quotation's PDF is an API v1 read (billing.read) that channels use; it is not an MCP tool, so
// the model never pulls the bytes into its prompt.
import assert from 'node:assert/strict';
import test from 'node:test';
import { v1Operations } from '../dist/v1.js';
import '../dist/v1-money.js';

test('the quotation PDF is a billing read and no MCP tool', () => {
  const op = v1Operations().find((o) => o.operationId === 'getQuotationPdf');
  assert.ok(op, 'getQuotationPdf is registered');
  assert.equal(op.method, 'GET');
  assert.equal(op.path, '/api/v1/billing/quotations/{documentId}/pdf');
  assert.equal(op.scope, 'billing.read');
  assert.equal(op.mcp, undefined);
});
