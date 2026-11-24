// QUOTE-FIXES (Mac test of production b7110a07, 21 Nov 2026, ~/orch/device-tests/20261121-quote-test/REPORT.md): the quote →
// invoice path on real PostgreSQL and tenant row security. Run by tests/core/test_quote_fixes.py. Synthetic data only.
//  1. An out-of-state quotation's IGST carries into its tax invoice; with no GSTIN in ERP settings the invoice is refused
//     (never issued at a different total), at conversion and at issue.
//  1d. No GSTIN: new quotations carry no GST (the GST default follows the company's GSTIN).
//  2. A numbered proforma becomes a tax invoice; no "Make the agreement" without an agreement template; a proforma does
//     not mark a quotation the customer never accepted as accepted.
//  3. A quotation with an extra charge "to be confirmed" (an estimate) is sent (numbered); the estimate stays out of the total.
//  3b. The estimate quotation's PDF, e-mail, acceptance link and customer page.
//  4. WhatsApp opened is not sent until the person says so; Home and My day list quotations and proformas not sent yet
//     and the next follow-ups.
//  6. A new client by the typed name from "New document".
//  7. Documents search finds an amount ("11,210", "9500").
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const { createApp } = await import('../dist/app.js');

const W = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 4 }), app = createApp(pool, pool);
const asFinance = { 'cf-access-authenticated-user-email': `finance@${W.domain}` };
const v0 = async (method, path, body, status = 200) => {
  const r = await app.inject({ method, url: `/api/v0/${path}`, headers: asFinance, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.statusCode} ${r.body.slice(0, 600)}`);
  return r.json();
};
let T;
const v1 = async (path, payload, status = 200) => {
  const r = await app.inject({ method: 'POST', url: `/api/v1/billing/${path}`, headers: { authorization: `Bearer ${T}`, 'idempotency-key': randomUUID() }, payload });
  assert.equal(r.statusCode, status, `${path}: ${r.statusCode} ${r.body.slice(0, 600)}`);
  return r.json();
};
const R = (rupee) => rupee * 100;
const KA = { name: 'ZZ Synthetic Karnataka Buyer', phone: '9000000099' };
/** The client's state set to Karnataka on the draft, as the editor saves it (API v1's buyer has no state field). */
async function inKarnataka(id) {
  const doc = await v0('GET', `erp/documents/${id}`);
  await v0('POST', `erp/documents/${id}`, { ...doc.document, buyer: { ...doc.document.buyer, stateCode: '29' }, placeOfSupply: '29', lines: doc.lines });
}
/** A quotation for the Karnataka buyer, numbered (sent) and accepted. */
async function acceptedQuote(lines) {
  const q = (await v1('quotations', { buyer: KA, lines })).quotation;
  await inKarnataka(q.id);
  const issued = await v0('POST', `erp/documents/${q.id}/issue`, {});
  assert.ok(issued.number ?? issued.document?.number, JSON.stringify(issued).slice(0, 300));
  await v0('POST', `erp/documents/${q.id}/mark`, { action: 'accepted' });
  return (await v0('GET', `erp/documents/${q.id}`)).document;
}
try {
  const t = await app.inject({ method: 'POST', url: '/api/v0/api-tokens', headers: asFinance, payload: { name: 'QUOTE-FIXES (synthetic)', scopes: ['billing.read', 'billing.write'], days: 1 } });
  assert.equal(t.statusCode, 201, t.body); T = t.json().token;
  const settings = await v0('GET', 'erp/settings');
  assert.match(String(settings.company.gstin), /^27/, 'the synthetic seller is registered in Maharashtra');

  // 1a. Registered seller, Karnataka buyer: ₹9,500 + 18% IGST = ₹11,210 on the quotation and on its tax invoice.
  const quote = await acceptedQuote([{ description: 'Synthetic solar service', rate: R(9500), gstRate: 18 }]);
  assert.deepEqual([quote.placeOfSupply, quote.igst, quote.cgst, quote.total], ['29', R(1710), 0, R(11210)]);
  const inv = await v0('POST', 'erp/documents', { docType: 'invoice', sourceId: quote.id });
  const invDoc = (await v0('GET', `erp/documents/${inv.id}`)).document;
  assert.deepEqual([invDoc.placeOfSupply, invDoc.igst, invDoc.taxable, invDoc.total], ['29', R(1710), R(9500), R(11210)], 'the invoice keeps the quotation\'s IGST');
  const issuedInv = await v0('POST', `erp/documents/${inv.id}/issue`, {});
  assert.match(String(issuedInv.number ?? issuedInv.document?.number), /^INV/);
  assert.equal((await v0('GET', `erp/documents/${inv.id}`)).document.total, R(11210));

  // 1b. A draft invoice made while the GSTIN was set, issued after it was cleared: refused, the total never changes.
  const q2 = await acceptedQuote([{ description: 'Synthetic panel cleaning', rate: R(9500), gstRate: 18 }]);
  const inv2 = await v0('POST', 'erp/documents', { docType: 'invoice', sourceId: q2.id });
  const q3 = await acceptedQuote([{ description: 'Synthetic inverter service', rate: R(9500), gstRate: 18 }]); // with GST, before the GSTIN goes
  await v0('POST', 'erp/settings', { ...settings, company: { ...settings.company, gstin: null } });
  assert.equal((await v0('GET', 'erp/settings')).company.gstin, null);
  const refused = await v0('POST', `erp/documents/${inv2.id}/issue`, {}, 409);
  assert.match(refused.error, /charges ₹1,710 GST, but the company has no GSTIN in ERP settings/);
  assert.equal((await v0('GET', `erp/documents/${inv2.id}`)).document.status, 'draft');

  // 1c. No GSTIN: a quotation that charged GST becomes neither a tax invoice nor a proforma; the reason says what to do.
  assert.equal(q3.igst, R(1710));
  const no = await v0('POST', 'erp/documents', { docType: 'invoice', sourceId: q3.id }, 409);
  assert.match(no.error, /^QT\S* charges ₹1,710 GST, but the company has no GSTIN in ERP settings.*Add the company's GSTIN in ERP settings/);
  assert.match((await v0('POST', 'erp/documents', { docType: 'proforma', sourceId: q3.id }, 409)).error, /so a proforma from it cannot charge GST/);
  // Round 3 (the GST default follows the GSTIN): a new quotation with an 18% item carries no GST, and says why.
  const plainQ = (await v1('quotations', { buyer: KA, lines: [{ description: 'Synthetic no-GSTIN service', rate: R(9500), gstRate: 18 }] })).quotation;
  await inKarnataka(plainQ.id);
  const plainDoc = (await v0('GET', `erp/documents/${plainQ.id}`)).document;
  assert.deepEqual([plainDoc.cgst, plainDoc.sgst, plainDoc.igst, plainDoc.total], [0, 0, 0, R(9500)]);
  const plainNo = await v0('POST', `erp/documents/${plainQ.id}/issue`, {});
  assert.match(String(plainNo.number ?? plainNo.document?.number), /^QT/);
  await v0('POST', `erp/documents/${plainQ.id}/mark`, { action: 'accepted' });
  const plainInv = await v0('POST', 'erp/documents', { docType: 'invoice', sourceId: plainQ.id });
  assert.equal((await v0('GET', `erp/documents/${plainInv.id}`)).document.total, R(9500), 'quoted ₹9,500, billed ₹9,500');
  // A quotation without GST still becomes a plain invoice for an unregistered company (VITALS-CLOSEOUT, unchanged).
  const q4 = await acceptedQuote([{ description: 'Synthetic unregistered service', rate: R(5000), gstRate: 0 }]);
  const inv4 = await v0('POST', 'erp/documents', { docType: 'invoice', sourceId: q4.id });
  assert.equal((await v0('GET', `erp/documents/${inv4.id}`)).document.total, R(5000));
  await v0('POST', 'erp/settings', settings);
  assert.match(String((await v0('GET', 'erp/settings')).company.gstin), /^27/);

  // 2. Quotation → proforma → tax invoice. The agreement card only shows with an agreement template (this company has
  //    none), so the proforma's own "Make tax invoice" leads; the invoice keeps the GST.
  const q5 = await acceptedQuote([{ description: 'Synthetic advance billing', rate: R(9500), gstRate: 18 }]);
  const pf = await v0('POST', 'erp/documents', { docType: 'proforma', sourceId: q5.id });
  const pfNo = await v0('POST', `erp/documents/${pf.id}/issue`, {});
  assert.match(String(pfNo.number ?? pfNo.document?.number), /^PI/);
  const chain = await v0('GET', `agreements/chain?documentId=${pf.id}`);
  assert.equal(chain.can.template, false, 'no agreement template: "Make the agreement" is not offered');
  assert.equal((await v0('GET', `erp/documents/${q5.id}`)).document.status, 'converted', 'an accepted quotation is converted by its proforma');
  // Round 3: a quotation never accepted (here never sent) keeps its state when its proforma is numbered; the tax invoice
  // made from that proforma converts it.
  const q7 = (await v1('quotations', { buyer: KA, lines: [{ description: 'Synthetic unsent quote', rate: R(9500), gstRate: 18 }] })).quotation;
  await inKarnataka(q7.id);
  await v0('POST', `erp/documents/${q7.id}/issue`, {});
  const pf7 = await v0('POST', 'erp/documents', { docType: 'proforma', sourceId: q7.id });
  await v0('POST', `erp/documents/${pf7.id}/issue`, {});
  assert.equal((await v0('GET', `erp/documents/${q7.id}`)).document.status, 'issued', 'not "Accepted" because a proforma was made');
  const inv7 = await v0('POST', 'erp/documents', { docType: 'invoice', sourceId: pf7.id });
  await v0('POST', `erp/documents/${inv7.id}/issue`, {});
  assert.equal((await v0('GET', `erp/documents/${q7.id}`)).document.status, 'converted', 'billed: the invoice converts it');
  const fromPf = await v0('POST', 'erp/documents', { docType: 'invoice', sourceId: pf.id });
  const fromPfDoc = (await v0('GET', `erp/documents/${fromPf.id}`)).document;
  assert.deepEqual([fromPfDoc.docType, fromPfDoc.igst, fromPfDoc.total], ['invoice', R(1710), R(11210)]);

  // 3. "Transport (per km), settled at the end": 120 km at ₹35 as an estimate. The quotation is sent (numbered), the estimate
  //    out of the total; before 2499 this was "The figures do not add up".
  const withCharge = (await v1('quotations', { buyer: KA, lines: [
    { description: 'Synthetic 5 kW solar system', rate: R(9500), gstRate: 18 },
    { description: 'Transport (per km)', unit: 'km', qty: 120, rate: R(35), gstRate: 18, charge: 'variable' },
  ] })).quotation;
  await inKarnataka(withCharge.id);
  const chargeDoc = (await v0('GET', `erp/documents/${withCharge.id}`)).document;
  assert.equal(chargeDoc.total, R(11210), 'the estimate is not in the total');
  assert.ok(chargeDoc.estimate > 0);
  const sent = await v0('POST', `erp/documents/${withCharge.id}/issue`, {});
  assert.match(String(sent.number ?? sent.document?.number), /^QT/, JSON.stringify(sent).slice(0, 300));
  const after = (await v0('GET', `erp/documents/${withCharge.id}`)).document;
  assert.deepEqual([after.status, after.total, after.estimate], ['issued', R(11210), chargeDoc.estimate]);
  // 3b. The estimate quotation reaches the customer: its filed PDF, the e-mail (to the test sink) with the acceptance link,
  //     and the customer's page show ₹11,210 with the estimate apart (re-test of 3214d396: "delivery unverified").
  const est = (await v1('quotations', { buyer: KA, lines: [
    { description: 'Synthetic 5 kW solar system', rate: R(9500), gstRate: 18 },
    { description: 'Transport (per km)', unit: 'km', qty: 120, rate: R(35), gstRate: 18, charge: 'variable' },
  ] })).quotation;
  await inKarnataka(est.id);
  await v0('POST', `erp/documents/${est.id}/issue`, {});
  const pdfRes = await app.inject({ method: 'GET', url: `/api/v0/erp/documents/${est.id}/pdf`, headers: asFinance });
  assert.equal(pdfRes.statusCode, 200); assert.equal(pdfRes.rawPayload.subarray(0, 4).toString(), '%PDF');
  const mail = await v0('GET', `erp/documents/${est.id}/email`);
  assert.equal(mail.acceptLink, true);
  const mailed = await v0('POST', `erp/documents/${est.id}/email`, { to: ['zz-buyer@example.test'], subject: mail.subject, body: mail.body, acceptLink: true });
  assert.deepEqual(mailed.sent, ['zz-buyer@example.test'], JSON.stringify(mailed).slice(0, 300));
  const estDoc = await v0('GET', `erp/documents/${est.id}`);
  assert.equal(estDoc.document.status, 'sent', 'e-mailed is sent: the follow-up starts');
  assert.ok(estDoc.events.some((e) => e.kind === 'emailed'));
  const { url } = await v0('POST', `erp/documents/${est.id}/link`, { days: 30 });
  const token = url.split('/accept/')[1];
  const open = await app.inject({ method: 'GET', url: `/api/v0/accept/${token}` });
  assert.equal(open.statusCode, 200, open.body.slice(0, 300));
  const page = JSON.stringify(open.json());
  assert.ok(page.includes(String(R(11210))) && page.includes(estDoc.document.number), page.slice(0, 600));
  const openPdf = await app.inject({ method: 'GET', url: `/api/v0/accept/${token}/pdf` });
  assert.equal(openPdf.statusCode, 200); assert.equal(openPdf.rawPayload.subarray(0, 4).toString(), '%PDF');

  // 4. WhatsApp opened is not sent: "Not yet" keeps it "Not sent yet" (on Home); "Yes" marks it sent and Home shows the
  //    follow-up with its day and time.
  const home0 = await v0('GET', 'quotes/follow-ups');
  assert.ok(home0.notSent >= 2, JSON.stringify(home0));
  // A proforma not sent yet is on Home too (re-test: "Not yet" on a proforma said it waits on Home, and it was missing).
  assert.ok(home0.notSentDocs.some((x) => x.documentId === pf.id && x.docType === 'proforma'), JSON.stringify(home0.notSentDocs));
  assert.ok(home0.notSentDocs.some((x) => x.documentId === withCharge.id && x.docType === 'quotation'));
  assert.ok(home0.followUps.some((f) => f.documentId === est.id), 'the e-mailed estimate quotation has its follow-up');
  assert.equal((await v0('POST', `erp/documents/${withCharge.id}/channel`, { channel: 'whatsapp', sent: false })).status, 'issued');
  const opened = await v0('GET', `erp/documents/${withCharge.id}`);
  assert.equal(opened.document.status, 'issued');
  assert.ok(opened.events.some((e) => e.kind === 'whatsapp_opened') && !opened.events.some((e) => e.kind === 'whatsapp_sent'));
  assert.equal((await v0('GET', 'quotes/follow-ups')).notSent, home0.notSent);
  assert.equal((await v0('POST', `erp/documents/${withCharge.id}/channel`, { channel: 'whatsapp' })).status, 'sent');
  const home1 = await v0('GET', 'quotes/follow-ups');
  assert.equal(home1.notSent, home0.notSent - 1);
  const fu = home1.followUps.find((f) => f.documentId === withCharge.id);
  assert.ok(fu && fu.number === after.number && fu.client === KA.name && Date.parse(fu.nextDueAt) > Date.now(), JSON.stringify(home1));

  // 6. "New document" → "New client “…”": a quotation for a new client by the typed name, not booked in Clients yet.
  const fresh = await v0('POST', 'erp/documents', { docType: 'quotation', buyer: { name: 'ZZ Synthetic New Client' } });
  const freshDoc = (await v0('GET', `erp/documents/${fresh.id}`)).document;
  assert.deepEqual([freshDoc.status, freshDoc.buyer.name, freshDoc.clientId ?? null], ['draft', 'ZZ Synthetic New Client', null]);

  // 7. Documents search finds an amount as people type it: the total ("11,210", "11210") or the value before GST ("9500").
  const search = async (q) => (await v0('GET', `erp/documents/search?q=${encodeURIComponent(q)}`)).documents;
  for (const q of ['11,210', '11210', '11210.00', '9,500', '9500']) {
    const found = await search(q);
    assert.ok(found.some((d) => d.id === quote.id), `${q} finds QT ${quote.number}: ${JSON.stringify(found.map((d) => [d.number, d.total, d.why]))}`);
    assert.ok(found.filter((d) => d.id === quote.id).every((d) => d.why === 'amount'), `${q}: found by its amount`);
    assert.ok(found.every((d) => d.total === R(11210) || d.taxable === R(9500)), `${q}: only documents of that amount`);
  }
  assert.equal((await search('6,41,500')).length, 0, 'an amount no document has finds nothing');
  console.log('QUOTE-FIXES runner: all checks passed');
} finally {
  await app.close(); await pool.end();
}
