// AGREEMENTS round 3 through the API (tests/core/test_agreement_chain.py): quotation → accepted → agreement → invoice.
// STAGE=issued: the chain waits for the client (step 0, nothing to do). STAGE=accepted: the agreement is made from the
// quotation through the screens' own route, the chain moves to step 1 from either end, the invoice waits for signatures
// (409). STAGE=signed: Finance makes the invoice from the quotation, linked to the agreement; a retry opens the same one;
// then the onboarding project and its task from the quotation (step 7). STAGE=live: every task done, step 8. A member
// sees no chain. Synthetic company, client and figures only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const { STAGE, QUOTE, CONTRACT } = process.env;
const call = async (path, body, as = 'admin') => {
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': `${as}@comp.example` }, ...(body === undefined ? {} : { payload: body }) });
  let data; try { data = r.json(); } catch { data = r.body; } return { status: r.statusCode, data };
};
const ok = (r, what) => { assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.data)}`); return r.data; };
try {
  if (STAGE === 'issued') {
    const ch = ok(await call(`agreements/chain?documentId=${QUOTE}`), 'the chain of an issued quotation');
    assert.equal(ch.step, 1, 'the lead is there; the quote waits for the client'); assert.equal(ch.quote.status, 'issued'); assert.equal(ch.agreement, null); assert.equal(ch.invoice, null);
    assert.deepEqual(ch.can, { agreement: false, invoice: false, onboarding: false, billing: true, make: true }, 'nothing to make before the client accepts');
    assert.equal((await call(`agreements/chain?documentId=${QUOTE}`, undefined, 'person')).status, 403, 'a member sees no Billing chain');
    assert.equal((await call('agreements/chain?documentId=not-an-id')).status, 404);
  } else if (STAGE === 'accepted') {
    let ch = ok(await call(`agreements/chain?documentId=${QUOTE}`), 'accepted');
    assert.equal(ch.step, 2); assert.equal(ch.can.agreement, true);
    const made = ok(await call('contracts/from-document', { documentId: QUOTE }), 'the agreement from the quotation');
    assert.equal(ok(await call('contracts/from-document', { documentId: QUOTE }), 'again').id, made.id, 'made once');
    ch = ok(await call(`agreements/chain?documentId=${QUOTE}`), 'after making it');
    assert.deepEqual([ch.step, ch.agreement.id, ch.agreement.status, ch.agreement.sentAt, ch.can.agreement], [2, made.id, 'draft', null, false]);
    const back = ok(await call(`agreements/chain?contractId=${made.id}`), 'from the agreement');
    assert.deepEqual([back.step, back.quote.id, back.quote.number, back.invoice, back.onboarding], [2, QUOTE, ch.quote.number, null, null]);
    const early = await call('agreements/chain/invoice', { contractId: made.id });
    assert.equal(early.status, 409, JSON.stringify(early.data)); assert.match(String(early.data.error), /Everyone signs the agreement first/);
    assert.equal((await call(`agreements/chain?contractId=${made.id}`, undefined, 'person')).status, 404, 'a member cannot open the agreement');
    console.log('CHAIN ' + JSON.stringify({ contractId: made.id }));
  } else if (STAGE === 'signed') {
    let ch = ok(await call(`agreements/chain?contractId=${CONTRACT}`), 'signed');
    assert.deepEqual([ch.step, ch.agreement.status, ch.agreement.clientSigned, ch.agreement.waitingFor, ch.can.invoice], [5, 'active', true, [], true]);
    assert.ok(ch.agreement.sentAt && ch.agreement.seenAt, 'sent, and seen through the link');
    assert.equal((await call('agreements/chain/onboarding', { contractId: CONTRACT })).status, 409, 'onboarding waits for the invoice');
    assert.equal((await call('agreements/chain/invoice', { contractId: CONTRACT }, 'person')).status, 404, 'a member cannot open the agreement, so makes no invoice');
    const inv = ok(await call('agreements/chain/invoice', { contractId: CONTRACT }), 'the invoice');
    assert.equal(inv.existing, false);
    const again = ok(await call('agreements/chain/invoice', { contractId: CONTRACT }), 'the invoice again');
    assert.deepEqual([again.id, again.existing], [inv.id, true], 'a retry opens the same invoice');
    ch = ok(await call(`agreements/chain?documentId=${QUOTE}`), 'done, from the quotation');
    assert.deepEqual([ch.step, ch.invoice.id, ch.invoice.docType, ch.invoice.status, ch.can.onboarding], [6, inv.id, 'invoice', 'draft', true]);
    const fromInvoice = ok(await call(`agreements/chain?documentId=${inv.id}`), 'from the invoice');
    assert.deepEqual([fromInvoice.step, fromInvoice.quote.id, fromInvoice.agreement.id], [6, QUOTE, CONTRACT]);
    const doc = ok(await call(`erp/documents/${inv.id}`), 'the invoice in Billing');
    assert.equal(doc.document.sourceId, QUOTE, 'made from the quotation');
    assert.deepEqual(doc.lines.map((l) => l.description), ['Model-led brand film'], 'its lines carry over');
    const links = ok(await call(`contracts/${CONTRACT}`), 'the agreement').links;
    assert.ok(links.some((l) => l.kind === 'invoice' && l.refId === inv.id), 'the invoice is linked to the agreement');
    // Onboarding: the project and its tasks from the quotation, linked to the agreement; once only.
    assert.equal((await call('agreements/chain/onboarding', { contractId: CONTRACT }, 'person')).status, 404, 'a member cannot open the agreement, so starts no onboarding');
    const ob = ok(await call('agreements/chain/onboarding', { contractId: CONTRACT }), 'onboarding');
    assert.ok(ob.projectId && ob.created === true && ob.tasks === 1, JSON.stringify(ob));
    assert.deepEqual(ok(await call('agreements/chain/onboarding', { contractId: CONTRACT }), 'again').projectId, ob.projectId, 'started once');
    ch = ok(await call(`agreements/chain?contractId=${CONTRACT}`), 'onboarding started');
    assert.deepEqual([ch.step, ch.onboarding.projectId, ch.onboarding.tasks, ch.onboarding.done], [7, ob.projectId, 1, 0]);
    assert.ok(ok(await call(`contracts/${CONTRACT}`), 'links').links.some((l) => l.kind === 'project' && l.refId === ob.projectId), 'the project is linked to the agreement');
    console.log('CHAIN ' + JSON.stringify({ invoiceId: inv.id, projectId: ob.projectId }));
  } else if (STAGE === 'live') {
    const ch = ok(await call(`agreements/chain?documentId=${QUOTE}`), 'live');
    assert.deepEqual([ch.step, ch.onboarding.done, ch.onboarding.tasks], [8, 1, 1], 'every onboarding task done: live');
  } else throw new Error('STAGE?');
} finally { await app.close(); await pool.end(); }
