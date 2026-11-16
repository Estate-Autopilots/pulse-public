// CONTRACTS-2: agreements people sign (contract-signing.ts): a Word file becomes plain text with its clause headings,
// input is checked before the database sees it, the database's own sentence reaches the person, and the signed PDF
// carries the words, both signatures and the audit page. Synthetic names only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { agreementPdf, docxHtmlToText, EVENT_WORDS, said, signatureInput, stamp, templateInput } from '../dist/contract-signing.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('a Word file becomes plain text: headings start numbered clauses, lists keep their bullets', () => {
  const html = '<h1>Scope of work</h1><p>We design the &amp; build.</p><ul><li>Drawings</li><li>Site visits</li></ul><h2>3. Payment</h2><p>Half now.<br/>Half later.</p>';
  assert.equal(docxHtmlToText(html), '1. Scope of work\nWe design the & build.\n\n• Drawings\n• Site visits\n\n3. Payment\nHalf now.\nHalf later.');
});

test('a template needs a name and words; a client variant names a real client', () => {
  assert.throws(() => templateInput({ body: 'x' }, true), /name/);
  assert.throws(() => templateInput({ name: 'Standard', body: '   ' }, true), /Write or paste/);
  assert.throws(() => templateInput({ name: 'A', body: 'b', clientId: 'not-an-id' }, true), /client/);
  assert.deepEqual(templateInput({ name: ' Standard ', body: '1. Work', isDefault: true, source: 'docx' }, true), { name: 'Standard', body: '1. Work', isDefault: true, source: 'docx' });
  assert.deepEqual(templateInput({ clientId: '' }, false), { clientId: null });
});

test('a signature is a typed name, or a small PNG drawing', () => {
  assert.deepEqual(signatureInput({ name: ' Diya Nair ', agree: true }), { name: 'Diya Nair', kind: 'typed', image: null, agree: true });
  assert.deepEqual(signatureInput({ name: 'Diya', kind: 'drawn', image: PNG, agree: true }).kind, 'drawn');
  assert.throws(() => signatureInput({ name: 'Diya', kind: 'drawn', image: 'data:image/svg+xml;base64,PHN2Zz4=' }), /Draw your signature again/);
  assert.throws(() => signatureInput({ name: 'Diya', kind: 'drawn', image: `data:image/png;base64,${'A'.repeat(200001)}` }), /too big/);
});

test("the database's own sentence reaches the person; other errors keep the generic answer", async () => {
  const raised = Object.assign(new Error('Tick "I agree" to sign'), { code: '22023', where: 'PL/pgSQL function pulse.contract_sign_act(text,jsonb,text,text) line 30 at RAISE' });
  await assert.rejects(said(async () => { throw raised; }), (e) => e.statusCode === 400 && e.message === 'Tick "I agree" to sign');
  const denied = Object.assign(new Error('Admins, leadership, Finance and the agreement\'s owner send it'), { code: '42501', where: 'PL/pgSQL function pulse.contract_send_to_sign line 5 at RAISE' });
  await assert.rejects(said(async () => { throw denied; }), (e) => e.statusCode === 403);
  const table = Object.assign(new Error('new row violates row-level security policy for table "contract_template"'), { code: '42501' });
  await assert.rejects(said(async () => { throw table; }), (e) => e === table, 'a row-security refusal stays generic (no table names to the person)');
  assert.equal(await said(async () => 7), 7);
});

test('times on the audit page are in the company\'s time zone', () => {
  assert.equal(stamp('2026-11-08T04:30:00Z', 'Asia/Kolkata'), '8 Nov 2026, 10:00 am');
  assert.equal(stamp(null, 'Asia/Kolkata'), '');
  assert.equal(EVENT_WORDS.change_asked, 'Asked for a change');
});

test('the signed PDF has the words, the signatures and an audit page', async () => {
  const r = { title: 'Nair residence · Lotus Interiors (synthetic)', from: 'Synthetic Studio', key: '6f1a455dced2', version: 2, status: 'active', signedAt: '2026-11-08T05:00:00Z',
    body: 'This agreement is between Synthetic Studio and Lotus Interiors (synthetic).\n\n1. The work\nDesign and drawings.\n\n2. Price and payment\nThe total is ₹4,85,000.',
    parties: [{ name: 'Synthetic Studio', role: 'provider', signer: 'Synthetic Finance', signedAt: '2026-11-08T05:00:00Z', kind: 'typed', image: null },
      { name: 'Lotus Interiors (synthetic)', role: 'client', signer: 'Diya Nair (synthetic)', signedAt: '2026-11-08T04:00:00Z', kind: 'drawn', image: PNG }],
    audit: [{ kind: 'sent', at: '2026-11-07T10:00:00Z', by: 'Synthetic Seller', via: 'app', version: 1, body: 'Link works until 21 Nov 2026' },
      { kind: 'opened', at: '2026-11-07T11:00:00Z', by: 'Diya Nair (synthetic)', via: 'link', version: 1, ip: 'a1b2c3d4e5f6', agent: 'Synthetic phone browser' },
      { kind: 'signed', at: '2026-11-08T04:00:00Z', by: 'Diya Nair (synthetic)', via: 'link', version: 2, body: 'Diya Nair (synthetic) signed for Lotus Interiors (synthetic) (drawn signature)' }] };
  const { bytes, pages } = await agreementPdf(r, 'Asia/Kolkata');
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
  assert.ok(pages >= 2, 'the audit page is its own page');
  assert.ok(bytes.length > 3000 && bytes.length < 400000);
});

// POLISH-1115 (owner, 14 Nov 2026): "the client shown was the wrong party: an org listed as its own counterparty".
test('our own company on both sides of an agreement is caught before it is sent', async () => {
  const { ourselvesTwice, sameCompany } = await import('../dist/contract-signing.js');
  assert.equal(sameCompany('Vitals Technology Private Limited'), sameCompany('vitals technology pvt. ltd.'));
  const ours = ['Vitals Technology', 'Vitals Technology Private Limited'];
  // Our company's signing row, and a "client" row typed with our own name.
  assert.equal(ourselvesTwice(ours, [{ name: 'Vitals Technology', ours: true }, { name: 'Vitals Technology Pvt Ltd', ours: false }], []), 'Vitals Technology Pvt Ltd');
  // The document's parties name us twice.
  assert.equal(ourselvesTwice(ours, [], [{ name: 'Vitals Technology Private Limited' }, { name: 'VITALS TECHNOLOGY' }]), 'VITALS TECHNOLOGY');
  // The right parties pass: us and a real client; three founders and a company to be incorporated.
  assert.equal(ourselvesTwice(ours, [{ name: 'Vitals Technology', ours: true }, { name: 'Lotus Interiors Private Limited', ours: false }], [{ name: 'Vitals Technology' }, { name: 'Lotus Interiors' }]), null);
  assert.equal(ourselvesTwice(['', ''], [{ name: 'A', ours: true }, { name: 'A', ours: false }], []), null, 'no name to compare: nothing is refused');
});
