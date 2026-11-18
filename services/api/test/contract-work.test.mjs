// CONTRACTS-3: agreements' parties from records, points of contact, proposed drafts and what clients change
// (contract-work.ts), and the v1 / MCP draft tools. Synthetic names only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clauseKey } from '../dist/contract-work.js';
import { pocInput } from '../dist/contracts.js';
import { EVENT_WORDS } from '../dist/contract-signing.js';
import '../dist/v1-contracts.js';
import { v1Operations } from '../dist/v1.js';

test('a clause is the same clause with or without its number', () => {
  assert.equal(clauseKey('2. Price and payment'), 'price and payment');
  assert.equal(clauseKey('Price and Payment'), 'price and payment');
  assert.equal(clauseKey('10) Ending the agreement'), 'ending the agreement');
  assert.equal(clauseKey(''), '');
});

test('a point of contact keeps only name, phone and e-mail, trimmed; null clears a field', () => {
  assert.deepEqual(pocInput({ name: '  Diya Nair (synthetic) ', phone: ' +91 90000 12345', email: null, role: 'admin' }),
    { name: 'Diya Nair (synthetic)', phone: '+91 90000 12345', email: '' });
  assert.deepEqual(pocInput({}), {});
  assert.equal(String(pocInput({ name: 'x'.repeat(400) }).name).length, 160);
});

test('the log has words for a proposed draft (the PDF audit page uses them too)', () => {
  assert.equal(EVENT_WORDS.draft_proposed, 'New draft proposed');
});

test('API v1 / MCP read drafts, compare them and propose one (a person uses it)', () => {
  const ops = new Map(v1Operations().map((o) => [o.operationId, o]));
  for (const [id, method, path, scope, tool] of [
    ['listContractDrafts', 'GET', '/api/v1/contracts/{contractId}/drafts', 'contracts.read', 'list_contract_drafts'],
    ['compareContractDrafts', 'GET', '/api/v1/contracts/{contractId}/compare', 'contracts.read', 'compare_contract_drafts'],
    ['proposeContractDraft', 'POST', '/api/v1/contracts/{contractId}/drafts', 'contracts.write', 'propose_contract_draft']]) {
    const op = ops.get(id);
    assert.ok(op, id);
    assert.deepEqual([op.method, op.path, op.scope, op.mcp?.name], [method, path, scope, tool]);
  }
  // get_contract's answer carries the words and points of contact (it answered "outside its schema" before).
  const get = ops.get('getContract');
  assert.ok(get.response.properties.contract.properties.body);
  assert.ok(get.response.properties.contract.properties.parties.items.properties.poc);
  assert.equal(get.response.properties.contract.properties.parties.items.properties.signImage, undefined);
});

test('a whole agreement as the screens hold it fits get_contract\'s answer (no "outside its schema")', async () => {
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const { v1Contract } = await import('../dist/v1-contracts.js');
  const key = '11111111-1111-4111-8111-111111111111', key2 = '22222222-2222-4222-8222-222222222222';
  const party = (k, name, extra) => ({ id: k, key: k, kind: 'company', role: 'client', name, orgId: null, personId: null, onPulse: false, acceptedAt: null,
    acceptedVersion: null, acceptedBy: null, acceptedNote: null, current: false, mine: false, email: 'diya@example.test', signer: 'Diya Nair (synthetic)', signKind: null,
    signImage: 'data:image/png;base64,AAAA', declinedAt: null, declinedNote: null, poc: { name: 'Diya Nair (synthetic)', phone: '+91 90000 12345', email: null }, ...extra });
  const contract = { id: key, key, here: true, heldBy: null, status: 'proposed', version: 2, kind: 'services', title: 'Synthetic agreement', scope: '', deliverables: [],
    rates: [{ label: 'Design', amountMinor: 100, unit: 'one_off' }], currency: 'INR', schedule: 'milestones', startsOn: null, endsOn: null, noticeDays: null, template: null,
    endedOn: null, endReason: null, updatedAt: '2026-11-09T10:00:00.000Z', parties: [party(key, 'Kedab Studio (synthetic)', { role: 'provider', orgId: key2, onPulse: true }), party(key2, 'Lotus Interiors (synthetic)')],
    transactions: [], totals: [], canManage: true, canAccept: false, myParty: null, side: { notes: null, ownerId: null, owner: null, clientId: null },
    body: '1. The work\nDesign.', signedAt: null, canRun: true, progress: { sentAt: '2026-11-09T10:00:00.000Z', openedAt: null, seenAt: null, changes: 1, expiresAt: null } };
  const get = v1Operations().find((o) => o.operationId === 'getContract');
  const ok = new Ajv2020({ strict: false }).compile(get.response);
  const versions = [{ version: 1, terms: { kind: 'services', title: 'Synthetic agreement', scope: '', deliverables: [], rates: [], currency: 'INR', schedule: 'milestones',
    startsOn: null, endsOn: null, noticeDays: null, body: '1. The work\nDraft one.' }, changedBy: 'Synthetic Seller', changedAt: '2026-11-08T10:00:00.000Z' }];
  assert.ok(ok({ contract: v1Contract(contract), versions, links: [] }), JSON.stringify(ok.errors));
  assert.equal(v1Contract(contract).parties[1].signImage, undefined);
});
