// BILLING-EMAIL: a quotation, proforma or invoice e-mailed from its page (erp-mail.ts), with its PDF attached through the
// platform's one mail path (mail-send.ts, mailbox.ts mimeMessage, mail-provider.ts resendRequest). Synthetic companies
// and example.com addresses only; the sink records what would go out and nothing reaches a provider.
import assert from 'node:assert/strict';
import test from 'node:test';
import { documentMail, finalBody, mailable, recipients, suggestions } from '../dist/erp-mail.js';
import { mailFiles, resendRequest } from '../dist/mail-provider.js';
import { mimeMessage } from '../dist/mailbox.js';
import { sendMail, testMail } from '../dist/mail-send.js';

const PDF = { filename: 'QT-26-27-0007_Synthetic-Buyer.pdf', contentType: 'application/pdf', base64: Buffer.from('%PDF-1.4 synthetic quotation\n').toString('base64') };
const quote = { docType: 'quotation', number: 'QT/26-27/0007 R2', total: 5664000, validUntil: '2026-11-20', buyer: { name: 'Synthetic Buyer LLP', contactName: 'Asha Synthetic' }, seller: { tradeName: 'Synthetic Studio' } };

test('only an approved quotation, proforma or tax invoice goes by e-mail', () => {
  for (const t of ['quotation', 'proforma', 'invoice']) assert.ok(mailable(t, 'issued') && mailable(t, 'sent'));
  assert.ok(mailable('invoice', 'part_paid') && mailable('quotation', 'accepted'));
  for (const s of ['draft', 'cancelled', 'converted', 'declined']) assert.ok(!mailable('quotation', s), s);
  assert.ok(!mailable('credit_note', 'issued'));
});

test('the composer starts with a subject and a message in plain words', () => {
  const q = documentMail(quote, { name: 'Kedab Synthetic' });
  assert.equal(q.subject, 'Quotation QT/26-27/0007 R2 from Synthetic Studio');
  assert.ok(q.body.startsWith('Hello Asha,'));
  assert.match(q.body, /our quotation QT\/26-27\/0007 R2 for ₹56,640(\.00)?, valid until 20 Nov 2026\./);
  assert.match(q.body, /accept it online/);
  assert.ok(q.body.endsWith('Thank you,\nKedab Synthetic\nSynthetic Studio'));
  const inv = documentMail({ docType: 'invoice', number: 'INV/26-27/0003', total: 1180000, balance: 590000, dueDate: '2026-11-30', buyer: { name: 'Synthetic Buyer LLP' }, seller: { legalName: 'Synthetic Studio Pvt Ltd' } });
  assert.equal(inv.subject, 'Tax invoice INV/26-27/0003 from Synthetic Studio Pvt Ltd');
  assert.match(inv.body, /^Hello Synthetic,/);
  assert.match(inv.body, /₹5,900(\.00)? is due by 30 Nov 2026/);
  assert.match(documentMail({ docType: 'invoice', number: 'INV/1', total: 100, balance: 0, seller: {} }).body, /paid in full/);
  assert.match(documentMail({ docType: 'proforma', number: 'PI/1', total: 100, seller: {} }).subject, /^Proforma invoice PI\/1 from us$/);
});

test('recipients: valid addresses, each once, one to five; suggestions keep the document first', () => {
  assert.deepEqual(recipients([' Buyer@Example.com ', 'buyer@example.com', 'accounts@example.com']), ['buyer@example.com', 'accounts@example.com']);
  assert.deepEqual(recipients('buyer@example.com, other@example.com'), ['buyer@example.com', 'other@example.com']);
  assert.throws(() => recipients([]), /Add the customer's e-mail/);
  assert.throws(() => recipients(['not-an-address']), /is not an e-mail address/);
  assert.throws(() => recipients(Array.from({ length: 6 }, (_, i) => `p${i}@example.com`)), /at most 5/);
  assert.deepEqual(suggestions([{ email: 'Buyer@example.com', name: 'Asha', source: 'document' }, { email: 'buyer@example.com', name: 'Again', source: 'billing' },
    { email: null, source: 'contact' }, { email: 'contact@example.com', name: ' ', source: 'contact' }]),
  [{ email: 'buyer@example.com', name: 'Asha', source: 'document' }, { email: 'contact@example.com', name: null, source: 'contact' }]);
});

test('a quotation carries its acceptance link on its own line', () => {
  assert.equal(finalBody('Hello\r\n\r\nThanks  ', 'https://pulse.example.test/accept/abc'), 'Hello\n\nThanks\n\nSee the quotation and accept it: https://pulse.example.test/accept/abc');
  assert.equal(finalBody('Hello', null), 'Hello');
});

test('the PDF travels as a real attachment: MIME, Resend and the sink', async () => {
  assert.deepEqual(mailFiles([PDF, { ...PDF, contentType: 'application/zip' }, { ...PDF, base64: 'not base64!' }]).map((f) => f.filename), [PDF.filename]);
  const raw = mimeMessage({ from: 'billing@example.com', to: 'buyer@example.com', subject: 'Quotation', body: 'Hello', html: '<p>Hello</p>', attachments: [PDF] });
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="mix-[0-9a-f]+"/);
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, new RegExp(`Content-Disposition: attachment; filename="${PDF.filename}"`));
  assert.ok(raw.replace(/\r\n/g, '').includes(PDF.base64));
  const plain = mimeMessage({ from: 'billing@example.com', to: 'buyer@example.com', subject: 'Quotation', body: 'Hello' });
  assert.doesNotMatch(plain, /multipart\/mixed/, 'no file, no change');

  const env = { RESEND_API_KEY: 'synthetic-key' };
  const req = resendRequest({ from: 'no-reply@org-9912dc.example', to: 'buyer@example.com', title: 'Quotation', body: 'Hello', attachments: [PDF] }, env);
  const sentBody = JSON.parse(req.init.body);
  assert.deepEqual(sentBody.attachments, [{ filename: PDF.filename, content: PDF.base64, content_type: 'application/pdf' }]);

  const keep = process.env.PULSE_CI;
  process.env.PULSE_CI = '1';
  try {
    const before = testMail.length;
    assert.equal(await sendMail({ kind: 'org', org: null, to: 'buyer@example.com', title: 'Quotation QT/1 from Synthetic Studio', body: 'Hello',
      installSender: { from: 'billing@example.com', fromName: 'Synthetic Studio', replyTo: 'kedab@example.com' }, attachments: [PDF] }), true);
    const m = testMail.at(-1);
    assert.equal(testMail.length, before + 1);
    assert.equal(m.to, 'buyer@example.com');
    assert.equal(m.replyTo, 'kedab@example.com');
    assert.deepEqual(m.attachments, [{ filename: PDF.filename, contentType: 'application/pdf', size: Buffer.from(PDF.base64, 'base64').length }]);
  } finally { if (keep === undefined) delete process.env.PULSE_CI; else process.env.PULSE_CI = keep; }
});
