// BILLING (owner, 4 Nov 2026; Kazuk's flow of 3 Nov): the money path end to end through the real API, and with
// PULSE_AUTH_BROWSER=1 through the built web app at 390 and 1440 px (tests/core/test_billing_flow.py). A blank quotation
// with no client project; the client picked from Clients or Contacts or typed in; lines from the catalogue; approved and
// numbered; revised after negotiation (same number, versions kept); invoiced as it is; paid; the project starts by itself
// and a project head assigns its owner and client category; a cancelled quotation re-issued under the next number.
// Synthetic company, clients, contacts and figures only. Optional screenshots: PULSE_BILLING_SCREENSHOTS=<dir>.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { testMail } from '../dist/mail-send.js';
import { testCompanyMail } from '../dist/mailbox.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool); let apiChecks = 0, browserChecks = 0;
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS);
const shots = process.env.PULSE_BILLING_SCREENSHOTS, browserOn = process.env.PULSE_AUTH_BROWSER === '1';
const call = async (path, body, role = 'finance', expected = 200) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${role} ${path}: ${r.body.slice(0, 400)}`);
  return r.headers['content-type']?.includes('json') ? r.json() : r.rawPayload;
};
const check = (condition, msg) => { browserChecks++; assert.ok(condition, msg); };
/** A refusal: its status (4xx) and message. */
const refused = async (path, body, role = 'finance') => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method: 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, payload: body ?? {} });
  assert.ok(r.statusCode >= 400 && r.statusCode < 500, `${role} ${path} should be refused: ${r.statusCode} ${r.body.slice(0, 300)}`);
  return { status: r.statusCode, error: r.json().error ?? '' };
};
const ist = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
/** The draft as the composer saves it, with `patch` over it. */
const draftBody = (doc, lines, patch = {}) => ({ issueDate: doc.issueDate, dueDate: doc.dueDate, validUntil: doc.validUntil, buyer: doc.buyer, placeOfSupply: doc.placeOfSupply,
  reference: doc.reference ?? {}, notes: doc.notes ?? '', terms: doc.terms, reverseCharge: doc.reverseCharge, zeroRated: doc.zeroRated, roundTotal: doc.roundTotal, templateId: doc.templateId,
  clientId: doc.clientId, contactPersonId: doc.contactPersonId, siteLocation: doc.siteLocation,
  lines: lines.map((l) => ({ itemId: l.itemId, description: l.description, details: l.details ?? '', sac: l.sac, unit: l.unit, qty: l.qty, rate: l.rate, discount: l.discount ?? 0, discountPercent: l.discountPercent ?? null, gstRate: l.gstRate })), ...patch });

// ------------------------------------------------------------------------------------------------ the catalogue
const item = async (body) => (await call('erp/items', { gstRate: 18, status: 'active', ...body }, 'founder')).id;
const film = await item({ kind: 'service', name: 'Model-led brand film', sac: '999612', unit: 'video', price: 2400000 });
const ads = await item({ kind: 'service', name: 'Meta ads management', sac: '998361', unit: 'month', price: 1200000 });
const catalogue = { [film]: { name: 'Model-led brand film', sac: '999612', unit: 'video', price: 2400000 }, [ads]: { name: 'Meta ads management', sac: '998361', unit: 'month', price: 1200000 } };
const line = (id, qty) => ({ itemId: id, description: catalogue[id].name, details: '', sac: catalogue[id].sac, unit: catalogue[id].unit, qty, rate: catalogue[id].price, gstRate: 18 });

// ---------------------------------------------- 1. a blank quotation: no project, no client, nothing to choose first
const blank = await call('erp/documents', { docType: 'quotation' });
let q = await call(`erp/documents/${blank.id}`);
assert.equal(q.document.status, 'draft'); assert.equal(q.document.projectId, null); assert.equal(q.document.clientId, null);
assert.equal(q.events[0].detail.from, 'blank', 'logged as a blank start');

// The picker reads Clients and Contacts (no client project): a client by company, a contact (a lead too) by name or phone.
const people = await call('erp/parties');
assert.ok(people.clients.some((c) => c.name === 'Northstar Homes') && people.contacts.some((p) => p.name === 'Asha Kireteso'), 'the client list loads without a search');
assert.deepEqual((await call('erp/parties?q=Northstar%20Homes%20LLP')).clients.map((c) => c.name), ['Northstar Homes'], 'found by the company name');
const byPhone = await call('erp/parties?q=90000%2000002');
assert.deepEqual(byPhone.contacts.map((p) => p.name), ['Ravi Menon'], 'a contact by phone');
assert.equal(byPhone.contacts[0].clientName, 'Lakeview Developers');
await call('erp/parties', undefined, 'member', 403);

// Picking Asha (a contact of Northstar) bills Northstar with Asha as the point of contact and the project's location.
const asha = await call(`erp/parties/pick?contact=${E.asha}`);
assert.equal(asha.clientId, E.north); assert.equal(asha.contactPersonId, E.asha);
assert.equal(asha.buyer.contactName, 'Asha Kireteso'); assert.equal(asha.buyer.email, 'accounts@northstar.example'); assert.equal(asha.siteLocation, 'Moshi, Pune');
await call(`erp/parties/pick?contact=${E.finance}`, undefined, 'finance', 400); // staff are not contacts
await call(`erp/documents/${blank.id}`, draftBody(q.document, [line(film, 2)], { buyer: { ...asha.buyer, address: ['Office 4, Baner, Pune'] }, clientId: asha.clientId, contactPersonId: asha.contactPersonId, siteLocation: asha.siteLocation }));
q = await call(`erp/documents/${blank.id}`);
assert.equal(q.document.clientId, E.north); assert.equal(q.document.contactPersonId, E.asha); assert.equal(q.document.siteLocation, 'Moshi, Pune');
assert.deepEqual(q.document.buyer.address, ['Office 4, Baner, Pune'], 'the office / billing address is apart from the project location');
assert.equal(q.document.total, 5664000, '2 films at ₹24,000 + 18% GST');
// A different client typed in instead clears the picked one (nothing is written to Clients yet).
await call(`erp/documents/${blank.id}`, draftBody(q.document, [line(film, 2)], { buyer: { name: 'Typed Over', address: [] }, clientId: null, contactPersonId: null }));
assert.equal((await call(`erp/documents/${blank.id}`)).document.clientId, null);
await call(`erp/documents/${blank.id}`, draftBody(q.document, [line(film, 2)]));
await call(`erp/documents/${blank.id}`, draftBody(q.document, [line(film, 2)], { clientId: '00000000-0000-4000-8000-000000000000' }), 'finance', 400);

// One tap from the new-document page: a quotation started for a client or a contact comes filled in.
const forClient = await call('erp/documents', { docType: 'quotation', clientId: E.lake });
const lake = (await call(`erp/documents/${forClient.id}`)).document;
assert.equal(lake.buyer.contactName, 'Ravi Menon'); assert.equal(lake.contactPersonId, E.ravi); assert.equal(lake.siteLocation, 'Baner');
assert.equal((await call(`erp/documents/${forClient.id}`)).events[0].detail.from, 'client');
await call(`erp/documents/${forClient.id}/delete`, {});

// ------------------------------- 2. a new client typed in: booked in Clients and Contacts when the invoice is issued
const typed = await call('erp/documents', { docType: 'quotation', buyer: { name: 'Synthetic Orchid Realty', contactName: 'Rumam Synthetic', phone: '+91 90000 33333', email: 'rumam@orchid.example' }, siteLocation: 'Hinjewadi, Pune' });
let t = (await call(`erp/documents/${typed.id}`)).document;
assert.equal(t.buyer.name, 'Synthetic Orchid Realty'); assert.equal(t.siteLocation, 'Hinjewadi, Pune'); assert.equal(t.clientId, null);
await call(`erp/documents/${typed.id}`, draftBody(t, [line(film, 1), line(ads, 3)]));
const qIssued = await call(`erp/documents/${typed.id}/issue`, {}), qNo = qIssued.number;
assert.match(qNo, /^QT/, `a quotation number: ${qNo}`);
// BILLING-WL (Akabod, 4 Nov 2026: "saving the quotation creates the client profile, no double entry"): the approved
// quotation books the customer as a Prospect; the invoice finds them and makes them Active.
assert.ok(qIssued.booked?.newClient && qIssued.booked?.newContact, `the approved quotation books the client and contact: ${JSON.stringify(qIssued.booked)}`);
assert.equal((await call('clients', undefined, 'founder')).clients.filter((c) => c.name === 'Synthetic Orchid Realty').length, 1, 'booked once');
const inv = await call('erp/documents', { docType: 'invoice', sourceId: typed.id });
const invDoc = (await call(`erp/documents/${inv.id}`)).document;
assert.equal(invDoc.siteLocation, 'Hinjewadi, Pune'); assert.equal(invDoc.buyer.contactName, 'Rumam Synthetic', 'client details carry over unchanged');
const issuedInv = await call(`erp/documents/${inv.id}/issue`, {});
assert.ok(issuedInv.booked && !issuedInv.booked.newClient && issuedInv.booked.clientId === qIssued.booked.clientId, `the invoice finds the client its quotation booked: ${JSON.stringify(issuedInv.booked)}`);
const orchid = (await call('clients', undefined, 'founder')).clients.find((c) => c.name === 'Synthetic Orchid Realty');
assert.ok(orchid, 'the client is in Clients'); assert.equal(orchid.contactName, 'Rumam Synthetic', 'the POC is its primary contact');
const contacts = (await call('contacts', undefined, 'founder')).contacts.filter((p) => p.name === 'Rumam Synthetic');
assert.equal(contacts.length, 1); assert.equal(contacts[0].clientName, 'Synthetic Orchid Realty');
assert.equal((await call(`erp/documents/${typed.id}`)).document.clientId, orchid.id, 'the quotation is linked to the booked client');
// Billing the same client again finds them (no duplicate): by name in the picker, and booking is idempotent.
assert.equal((await call('erp/parties?q=Orchid')).clients.length, 1);

// ------------------------------------ 3. negotiation: revise the same quotation (same number, the approved copy kept)
const n1 = (await call(`erp/documents/${blank.id}/issue`, {})).number;
// BILLING-EMAIL (Kazuk, 5 Nov 2026): sent by e-mail from its page, the PDF attached and the acceptance link in the message.
// The composer only proposes; nothing goes until it is posted. Billing's writers only. The sink keeps what would go out.
let emailed = 0;
{
  const composer = await call(`erp/documents/${blank.id}/email`);
  assert.equal(composer.to[0].email, 'accounts@northstar.example', "the customer's address on the document comes first");
  assert.ok(composer.subject.startsWith(`Quotation ${n1} from `), composer.subject);
  assert.ok(composer.body.startsWith('Hello Asha,') && composer.acceptLink && composer.file.endsWith('.pdf'), JSON.stringify(composer));
  assert.equal((await call(`erp/documents/${blank.id}`)).document.status, 'issued', 'opening the composer sends nothing');
  await call(`erp/documents/${blank.id}/email`, undefined, 'member', 403);
  assert.equal((await refused(`erp/documents/${blank.id}/email`, { to: ['buyer@example.com'], subject: 'Synthetic', body: 'Hello' }, 'member')).status, 403);
  assert.match((await refused(`erp/documents/${blank.id}/email`, { to: ['not-an-address'], subject: 'Synthetic', body: 'Hello' })).error, /not an e-mail address/);
  assert.match((await refused(`erp/documents/${blank.id}/email`, { to: [], subject: 'Synthetic', body: 'Hello' })).error, /Add the customer's e-mail/);
  const draftQuote = await call('erp/documents', { docType: 'quotation' });
  assert.equal((await refused(`erp/documents/${draftQuote.id}/email`, { to: ['buyer@example.com'], subject: 'Synthetic', body: 'Hello' })).status, 409, 'a draft is approved first');
  await call(`erp/documents/${draftQuote.id}/delete`, {});
  // The sink only (PULSE_CI): a synthetic key makes a company without a mailbox take the platform's route, into the sink too.
  const keepKey = process.env.RESEND_API_KEY, n = [testMail.length, testCompanyMail.length];
  process.env.RESEND_API_KEY = 'synthetic-sink-only';
  let out;
  try { out = await call(`erp/documents/${blank.id}/email`, { to: ['accounts@northstar.example', 'Buyer@Example.com'], subject: composer.subject, body: composer.body, acceptLink: true }); }
  finally { if (keepKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = keepKey; }
  assert.deepEqual(out, { sent: ['accounts@northstar.example', 'buyer@example.com'], failed: [], status: 'sent', acceptLink: true });
  const mails = [...testMail.slice(n[0]), ...testCompanyMail.slice(n[1])];
  assert.deepEqual(mails.map((m) => m.to).sort(), ['accounts@northstar.example', 'buyer@example.com'], 'one message per address');
  for (const m of mails) {
    assert.equal(m.title, composer.subject);
    assert.match(m.body, /See the quotation and accept it: https?:\/\/[^\s]+\/accept\/[A-Za-z0-9_-]{43}/);
    assert.equal(m.attachments?.[0]?.contentType, 'application/pdf'); assert.ok(m.attachments[0].size > 1000 && m.attachments[0].filename === composer.file, JSON.stringify(m.attachments));
  }
  const after = await call(`erp/documents/${blank.id}`);
  assert.equal(after.document.status, 'sent'); assert.ok(after.document.sentAt, 'marked sent');
  const ev = after.events.find((e) => e.kind === 'emailed');
  assert.deepEqual(ev.detail.to, ['accounts@northstar.example', 'buyer@example.com']); assert.equal(ev.actor, 'Kedab Accounts'); assert.ok(ev.at, 'who, when and to whom');
  assert.equal(after.links.filter((l) => !l.revokedAt).length, 1, 'one live acceptance link, the one in the e-mail');
  assert.equal((await call(`erp/documents/${blank.id}/email`)).sent[0].to.length, 2, 'the composer shows it was sent before');
  emailed = mails.length;
}
await call(`erp/documents/${blank.id}/mark`, { action: 'sent' });
await call(`erp/documents/${blank.id}/link`, { days: 30 });
const rev = await call(`erp/documents/${blank.id}/revise`, { reason: 'Synthetic: client asked for three films' });
assert.deepEqual(rev, { revision: 1, number: n1 });
let r1 = await call(`erp/documents/${blank.id}`);
assert.equal(r1.document.status, 'draft'); assert.equal(r1.document.number, n1, 'the revision keeps its number'); assert.equal(r1.document.revision, 1);
assert.equal(r1.versions.length, 1); assert.equal(r1.versions[0].revision, 0); assert.ok(r1.versions[0].pdf, 'the approved copy and its PDF are kept');
assert.equal(r1.versions[0].reason, 'Synthetic: client asked for three films');
assert.ok(r1.links.every((l) => l.revokedAt), 'the acceptance link of the old copy no longer works');
assert.ok(r1.events.some((e) => e.kind === 'revised'), 'the revision is in the activity');
assert.match((await refused(`erp/documents/${blank.id}/delete`)).error, /keeps its number/);
await refused(`erp/documents/${blank.id}/revise`, {}); // a draft is not revised again
// Undo puts the approved copy back as it was.
await call(`erp/documents/${blank.id}`, draftBody(r1.document, [line(film, 5)]));
assert.equal((await call(`erp/documents/${blank.id}/revise/undo`, {})).status, 'sent');
r1 = await call(`erp/documents/${blank.id}`);
assert.equal(r1.document.status, 'sent'); assert.equal(r1.document.total, 5664000); assert.equal(r1.document.revision, 0); assert.equal(r1.versions.length, 0);
assert.equal(r1.lines.length, 1); assert.equal(r1.lines[0].qty, 2); assert.ok(r1.file?.sha256, 'the filed PDF is back');
// Revise for real: three films, approved again under the same number; the series does not move.
await call(`erp/documents/${blank.id}/revise`, { reason: 'Synthetic: three films' });
r1 = await call(`erp/documents/${blank.id}`);
await call(`erp/documents/${blank.id}`, draftBody(r1.document, [line(film, 3)]));
const again = await call(`erp/documents/${blank.id}/issue`, {});
assert.equal(again.number, n1); assert.equal(again.revision, 1);
r1 = await call(`erp/documents/${blank.id}`);
assert.equal(r1.document.status, 'issued'); assert.equal(r1.document.total, 8496000, '3 films'); assert.equal(r1.versions[0].total, 5664000, 'the earlier copy is kept');
const oldPdf = await app.inject({ url: `/api/v0/erp/documents/${blank.id}/versions/0/pdf`, headers: { 'cf-access-authenticated-user-email': emails.finance } }); apiChecks++;
assert.equal(oldPdf.statusCode, 200); assert.equal(oldPdf.rawPayload.subarray(0, 4).toString(), '%PDF', 'the earlier copy downloads as filed');
const probeQ = await call('erp/documents', { docType: 'quotation', clientId: E.lake });
const probeDoc = (await call(`erp/documents/${probeQ.id}`)).document;
await call(`erp/documents/${probeQ.id}`, draftBody(probeDoc, [line(ads, 1)]));
const n3 = (await call(`erp/documents/${probeQ.id}/issue`, {})).number;
assert.equal(Number(n3.slice(-4)), Number(qNo.slice(-4)) + 2, `re-approving a revision takes no number: ${qNo}, ${n1}, then ${n3}`);

// ---------------------------- 4. invoiced as it is, paid: the project starts by itself and the heads are asked to assign it
const inv2 = await call('erp/documents', { docType: 'invoice', sourceId: blank.id });
const inv2No = (await call(`erp/documents/${inv2.id}/issue`, {})).number;
assert.equal((await call(`erp/documents/${blank.id}`)).document.status, 'converted', 'the quotation shows as converted');
await refused(`erp/documents/${blank.id}/revise`, {}); // a converted quotation is not revised
let paid = await call(`erp/documents/${inv2.id}`);
assert.equal(paid.startedProject, null, 'no project before the money is in');
await call(`erp/documents/${inv2.id}/payments`, { amount: 4000000, receivedOn: ist(), method: 'bank', reference: 'SYNTH-UTR-1' });
paid = await call(`erp/documents/${inv2.id}`);
assert.equal(paid.document.status, 'part_paid');
assert.ok(paid.startedProject?.id, 'the first money in starts the project'); assert.equal(paid.startedProject.assigned, false);
assert.ok(paid.events.some((e) => e.kind === 'project_started'));
const projectId = paid.startedProject.id;
await call(`erp/documents/${inv2.id}/payments`, { amount: 8496000 - 4000000, receivedOn: ist(), method: 'upi', reference: 'SYNTH-UTR-2' });
paid = await call(`erp/documents/${inv2.id}`);
assert.equal(paid.document.status, 'paid'); assert.equal(paid.startedProject.id, projectId, 'paying the rest makes no second project');
assert.equal((await call(`erp/documents/${inv2.id}/project`, {})).projectId, projectId, 'starting it by hand opens the same project');
// BILLING (review, 4 Nov 2026): more work for a client whose project is live (Lakeview Towers) starts no second project by
// itself; the paid invoice says why and offers "Start the project".
const inv3 = await call('erp/documents', { docType: 'invoice', sourceId: probeQ.id });
await call(`erp/documents/${inv3.id}/issue`, {});
const inv3Total = (await call(`erp/documents/${inv3.id}`)).document.total;
await call(`erp/documents/${inv3.id}/payments`, { amount: inv3Total, receivedOn: ist(), method: 'bank', reference: 'SYNTH-UTR-3' });
const more = await call(`erp/documents/${inv3.id}`);
assert.equal(more.document.status, 'paid'); assert.equal(more.startedProject, null, 'no second project for a client being served');
assert.equal(more.projectOffer?.reason, 'live'); assert.equal(more.projectOffer.project, 'Lakeview Towers phase 2');
const asHead = await call(`projects/${projectId}/assign`, undefined, 'head');
assert.equal(asHead.needed, true); assert.equal(asHead.canAssign, true); assert.equal(asHead.location, 'Moshi, Pune', 'the project is at the project location');
assert.equal(asHead.client, 'Northstar Homes'); assert.equal(asHead.invoice, inv2No); assert.equal(asHead.quotation, n1);
assert.deepEqual(asHead.categories.map((c) => c.key), ['sell_out', 'competitive', 'normal']);
assert.ok(asHead.owners.find((p) => p.id === E.pgs)?.strategist, 'growth strategists are offered first');
const work = await call(`tasks/projects/${projectId}`, undefined, 'head');
assert.deepEqual(work.tasks.map((x) => x.title).sort(), ['Model-led brand film #1', 'Model-led brand film #2', 'Model-led brand film #3'], 'three films sold, three tasks');
assert.equal((await call(`projects/${projectId}/assign`, undefined, 'pgs')).canAssign, false, 'a growth strategist does not assign');
await refused(`projects/${projectId}/assign`, { ownerId: E.pgs, category: 'normal' }, 'pgs');
assert.match((await refused(`projects/${projectId}/assign`, { ownerId: E.pgs, category: 'premium' }, 'head')).error, /client category/);
if (!browserOn) {
  const done = await call(`projects/${projectId}/assign`, { ownerId: E.pgs, category: 'competitive' }, 'head');
  assert.equal(done.tasks, 3, 'the quotation\'s work goes to the owner');
  const after = await call(`projects/${projectId}/assign`, undefined, 'head');
  assert.equal(after.needed, false); assert.equal(after.ownerId, E.pgs); assert.equal(after.category, 'competitive');
}

// ----------------------------------------- 5. cancelled keeps its number; a re-issue takes the next and links the two
const toCancel = await call('erp/documents', { docType: 'quotation', contactPersonId: E.ravi });
const cDoc = (await call(`erp/documents/${toCancel.id}`)).document;
await call(`erp/documents/${toCancel.id}`, draftBody(cDoc, [line(ads, 2)]));
const cNo = (await call(`erp/documents/${toCancel.id}/issue`, {})).number;
await call(`erp/documents/${toCancel.id}/mark`, { action: 'cancel', note: 'Synthetic: wrong scope' });
const re = await call(`erp/documents/${toCancel.id}/reissue`, {});
assert.equal((await call(`erp/documents/${toCancel.id}/reissue`, {})).id, re.id, 'a second tap opens the re-issue already made');
const reDoc = await call(`erp/documents/${re.id}`);
assert.equal(reDoc.document.reissueOf, toCancel.id); assert.equal(reDoc.document.number, null); assert.equal(reDoc.lines.length, 1);
assert.equal(reDoc.document.contactPersonId, E.ravi, 'the re-issue keeps the client and contact');
const reNo = (await call(`erp/documents/${re.id}/issue`, {})).number;
assert.equal(Number(reNo.slice(-4)), Number(cNo.slice(-4)) + 1, `the re-issue takes the next number: ${cNo} then ${reNo}`);
const cancelled = await call(`erp/documents/${toCancel.id}`);
assert.equal(cancelled.document.status, 'cancelled'); assert.equal(cancelled.document.number, cNo, 'the cancelled one keeps its number');
assert.equal(cancelled.reissue.id, re.id);
await refused(`erp/documents/${re.id}/reissue`, {}); // only a cancelled one is re-issued

// ------------------------------------------------------------------------------------------------ the browser
if (browserOn) {
  const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
    env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: 'production', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next' }, stdio: 'ignore' });
  let browser, current = null;
  const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }); await page.waitForTimeout(300); };
  const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await ready(page); };
  const fits = async (page, what) => check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${what}: no sideways scroll at ${page.viewportSize().width} px`);
  const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}-${page.viewportSize().width}.png`, fullPage: true }); };
  try {
    for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 199) throw Error('web did not start'); }
    browser = await chromium.launch({ headless: true });
    const context = async (role, width) => {
      const c = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
      c.on('page', (p) => { current = p; p.on('pageerror', (e) => console.error('PAGEERROR', p.url().replace(base, ''), e.message)); });
      // window.confirm and window.prompt (approve, revise, cancel) are answered yes, with a synthetic reason.
      c.on('dialog', (d) => void d.accept(d.type() === 'prompt' ? 'Synthetic reason' : undefined));
      return c;
    };
    for (const width of [390, 1440]) {
      const c = await context('finance', width); const p = await c.newPage();
      // The new quotation: the client list loads, and the one obvious button starts it blank.
      await go(p, '/erp/new?type=quotation');
      await expect(p.getByRole('list', { name: 'Clients' }).getByRole('button', { name: 'Choose client Lakeview Developers' })).toBeVisible(); browserChecks++;
      await expect(p.getByRole('button', { name: 'Start blank quotation' })).toBeVisible(); browserChecks++;
      await fits(p, 'new quotation'); await shot(p, '01-new-quotation');
      await p.getByRole('button', { name: 'Start blank quotation' }).click();
      await p.waitForURL(/\/erp\/documents\/[0-9a-f-]{36}$/); await ready(p);
      // "Prepared for" opens the search over Clients and Contacts; a contact fills in their client and themselves.
      await p.getByRole('button', { name: /^Client: not chosen/ }).click();
      await p.getByRole('searchbox', { name: 'Search Clients and Contacts' }).fill(width < 500 ? 'Asha' : 'Lakeview');
      await shot(p, '02-find-client');
      if (width < 500) await p.getByRole('button', { name: 'Choose contact Asha Kireteso' }).click();
      else await p.getByRole('button', { name: 'Choose client Lakeview Developers' }).click();
      await expect(p.getByLabel('Project location')).toHaveValue(width < 500 ? 'Moshi, Pune' : 'Baner'); browserChecks++;
      await expect(p.getByLabel('Contact person')).toHaveValue(width < 500 ? 'Asha Kireteso' : 'Ravi Menon'); browserChecks++;
      await fits(p, 'prepared for'); await shot(p, '03-prepared-for');
      await p.getByRole('button', { name: 'Done', exact: true }).click();
      await p.getByRole('group', { name: 'Add from the catalogue' }).getByRole('button', { name: 'Model-led brand film' }).click();
      await expect(p.getByRole('button', { name: width < 500 ? /^Client: Northstar Homes LLP/ : /^Client: Lakeview Developers/ })).toBeVisible(); browserChecks++;
      await fits(p, 'composer'); await shot(p, '04-composer');
      const issued = p.waitForResponse((r) => r.url().endsWith('/issue') && r.request().method() === 'POST');
      await p.getByRole('button', { name: 'Approve', exact: true }).last().click(); // the phone's sheet or the computer's next step
      const no = (await (await issued).json()).number; check(/^QT/.test(no), `approved and numbered: ${no}`);
      await expect(p.getByRole('heading', { name: new RegExp(`Quotation ${no.replace(/\//g, '\\/')}`) })).toBeVisible(); browserChecks++;
      await shot(p, '05-quotation-approved');
      await c.close();
    }
    let browserProject = null;
    // The money path on a phone: revise after negotiation, invoice it as it is, mark it paid, open the project.
    {
      const c = await context('finance', 390); const p = await c.newPage();
      const qq = await call('erp/documents', { docType: 'quotation', contactPersonId: E.asha });
      const qd = (await call(`erp/documents/${qq.id}`)).document;
      await call(`erp/documents/${qq.id}`, draftBody(qd, [line(film, 1)]));
      const qn = (await call(`erp/documents/${qq.id}/issue`, {})).number;
      await call(`erp/documents/${qq.id}/mark`, { action: 'accepted', note: 'Synthetic: agreed on the phone' });
      await go(p, `/erp/documents/${qq.id}`);
      const step = p.getByRole('region', { name: 'Next step' });
      await expect(step.getByRole('button', { name: 'Make tax invoice' })).toBeVisible(); browserChecks++;
      await step.getByRole('button', { name: 'Make tax invoice' }).click();
      const choice = p.getByRole('dialog', { name: 'Make the tax invoice' });
      await expect(choice.getByRole('button', { name: 'Invoice it as it is' })).toBeVisible(); browserChecks++;
      await fits(p, 'invoice or revise'); await shot(p, '06-invoice-or-revise');
      await choice.getByRole('button', { name: 'Revise it first' }).click();
      await expect(p.getByText(`${qn} R2 · revision 1 · keeps its number`).first()).toBeVisible({ timeout: 20000 }); browserChecks++;
      await shot(p, '07-revision-draft');
      await p.getByRole('button', { name: 'More: Quantity of Model-led brand film' }).first().click();
      const issued = p.waitForResponse((r) => r.url().endsWith('/issue') && r.request().method() === 'POST');
      await p.getByRole('button', { name: 'Approve revision' }).last().click();
      check((await (await issued).json()).number === qn, 'the revision is approved under the same number');
      await expect(p.getByText('Versions').first()).toBeVisible(); browserChecks++;
      await call(`erp/documents/${qq.id}/mark`, { action: 'accepted', note: 'Synthetic: agreed to two films' });
      await go(p, `/erp/documents/${qq.id}`);
      await step.getByRole('button', { name: 'Make tax invoice' }).click();
      await p.getByRole('dialog', { name: 'Make the tax invoice' }).getByRole('button', { name: 'Invoice it as it is' }).click();
      await p.waitForURL((u) => !u.pathname.endsWith(qq.id), { timeout: 20000 }); await ready(p);
      const invIssued = p.waitForResponse((r) => r.url().endsWith('/issue') && r.request().method() === 'POST');
      await p.getByRole('button', { name: 'Approve', exact: true }).last().click();
      await invIssued; await ready(p);
      await expect(step.getByRole('button', { name: 'Send on WhatsApp' })).toBeVisible(); browserChecks++;
      // BILLING-EMAIL: Send by email beside it opens the composer, which sends nothing until Send is pressed.
      await step.getByRole('button', { name: 'Send by email' }).click();
      const mailSheet = p.getByRole('dialog', { name: 'Send by email' });
      await expect(mailSheet.getByLabel('Subject')).toHaveValue(/^Tax invoice /, { timeout: 20000 }); browserChecks++;
      await expect(mailSheet.getByText(/is attached/)).toBeVisible(); browserChecks++;
      await mailSheet.getByRole('button', { name: 'Cancel' }).click();
      await shot(p, '08-invoice-approved');
      // The sales person marks it paid (the money came in before it was marked sent): Record payment is in the menu.
      await step.getByRole('button', { name: 'More actions' }).click();
      await p.getByRole('menuitem', { name: /Record payment/ }).click();
      const pay = p.getByRole('dialog', { name: 'Record a payment' });
      await pay.getByRole('button', { name: /^Record ₹/ }).click();
      // BILLING (review): Northstar's project from the first quotation is live, so this payment starts nothing by itself;
      // the invoice says so and starting it (new work after all) is one tap.
      await expect(step.getByRole('button', { name: 'Start the project' })).toBeVisible({ timeout: 20000 }); browserChecks++;
      await expect(step.getByText(/is already running, so no new project started/)).toBeVisible(); browserChecks++;
      await fits(p, 'paid invoice, project offered'); await shot(p, '09a-paid-project-offered');
      const invUrl = p.url();
      await step.getByRole('button', { name: 'Start the project' }).click();
      await p.waitForURL(/\/tasks\/projects\/[0-9a-f-]{36}/, { timeout: 20000 });
      browserProject = p.url().match(/projects\/([0-9a-f-]{36})/)[1];
      await go(p, invUrl.replace(base, ''));
      await expect(step.getByRole('button', { name: 'Open the project' })).toBeVisible({ timeout: 20000 }); browserChecks++;
      await expect(p.getByRole('list', { name: 'Project' })).toBeVisible(); browserChecks++;
      await fits(p, 'paid invoice'); await shot(p, '09-paid-project-started');
      await c.close();
    }
    // A project head, on a phone and on a computer: the new client's project asks for its owner and client category.
    for (const width of [390, 1440]) {
      const c = await context('head', width); const p = await c.newPage();
      const pid = width < 500 ? projectId : browserProject;
      await go(p, `/tasks/projects/${pid}`);
      const box = p.getByRole('region', { name: 'Assign the new client' });
      await expect(box).toBeVisible(); browserChecks++;
      await fits(p, 'assign the new client'); await shot(p, '10-assign-new-client');
      await box.getByLabel('PGS (head and point of contact)').selectOption({ label: 'Project Lead' });
      await box.getByLabel('Client category').selectOption({ label: width < 500 ? 'Competitive' : 'Sell-out' });
      await box.getByRole('button', { name: 'Assign the project' }).click();
      await expect(box).toHaveCount(0, { timeout: 20000 }); browserChecks++;
      await c.close();
    }
    const assigned = await call(`projects/${projectId}/assign`, undefined, 'head');
    check(assigned.needed === false && assigned.ownerId === E.pgs && assigned.category === 'competitive', 'the head\'s choice is saved');
    // A cancelled quotation on a phone: the one next step re-issues it.
    {
      const c = await context('finance', 390); const p = await c.newPage();
      await go(p, `/erp/documents/${toCancel.id}`);
      await expect(p.getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Open the re-issue' })).toBeVisible(); browserChecks++;
      await shot(p, '11-cancelled-reissue');
      await c.close();
    }
    // A new client typed in, on a computer: the drawer offers "New client" with what was typed.
    {
      const c = await context('finance', 1440); const p = await c.newPage();
      await go(p, '/erp/new?type=quotation');
      await p.getByRole('button', { name: 'Start blank quotation' }).click();
      await p.waitForURL(/\/erp\/documents\/[0-9a-f-]{36}$/); await ready(p);
      await p.getByRole('button', { name: /^Client: not chosen/ }).click();
      await p.getByRole('searchbox', { name: 'Search Clients and Contacts' }).fill('Synthetic Lotus Homes');
      await expect(p.getByText('No client, contact or lead matches')).toBeVisible(); browserChecks++;
      await p.getByRole('button', { name: 'New client Synthetic Lotus Homes' }).click();
      await expect(p.getByLabel('Name (legal name for the invoice)')).toHaveValue('Synthetic Lotus Homes'); browserChecks++;
      await p.getByLabel('Phone').fill('+91 90000 44444');
      await p.getByLabel('Project location').fill('Kharadi, Pune');
      await expect(p.getByLabel("Client's GSTIN")).toHaveCount(0); browserChecks++; // GST only when the billing includes it
      await p.getByLabel('The client is GST-registered (bill with their GSTIN)').check();
      await expect(p.getByLabel("Client's GSTIN")).toBeVisible(); browserChecks++;
      await p.getByLabel('The client is GST-registered (bill with their GSTIN)').uncheck();
      await p.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(p.getByRole('button', { name: /^Client: Synthetic Lotus Homes/ })).toBeVisible(); browserChecks++;
      await c.close();
    }
  } catch (e) {
    // What the page showed when a check failed (with PULSE_BILLING_SCREENSHOTS), and its notices.
    if (current) {
      if (shots) await current.screenshot({ path: `${shots}/zz-failed.png`, fullPage: true }).catch(() => undefined);
      console.error('FAILED AT', current.url().replace(base, ''), (await current.locator('[role="status"],[role="alert"]').allInnerTexts().catch(() => [])).join(' | ').slice(0, 600));
    }
    throw e;
  } finally {
    await browser?.close(); server.kill(); await app.close();
  }
}

const receipt = JSON.stringify({ apiChecks, browserChecks, emailed });
await writeFile(process.env.PULSE_BILLING_REPORT, receipt); console.log(receipt);
await pool.end();
