// BILLING-WL (owner, 4 Nov 2026; Akabod Soniba of Willow Lane's meeting, "Billing" 1-8): Willow Lane's billing end to end
// through the real API, and with PULSE_AUTH_BROWSER=1 through the built web app at 390 and 1440 px
// (tests/core/test_billing_willow_lane.py). A blank quotation for a customer found however they are typed (a contact by
// "mifos asohiv", a Sales X-Ray lead by "ajay", a phone by its digits), Pure Power 5.0 found as "purepower 5", an
// extended warranty on its line, sent by the salesperson for approval and approved by the owner with one tap (both told),
// the customer booked as a Prospect, the lead linked; "Send on WhatsApp" saying plainly that WhatsApp Business is not
// linked; revised as R2 under the same number; invoiced with the serial number of each unit, which leaves the stock.
// Synthetic company, people, products, serials and figures only. Optional screenshots: PULSE_BILLING_SCREENSHOTS=<dir>.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool); let apiChecks = 0, browserChecks = 0;
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS);
const shots = process.env.PULSE_BILLING_SCREENSHOTS, browserOn = process.env.PULSE_AUTH_BROWSER === '1';
const call = async (path, body, role = 'finance', expected = 200) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${role} ${path}: ${r.body.slice(0, 400)}`);
  return r.headers['content-type']?.includes('json') ? r.json() : r;
};
const refused = async (path, body, role = 'finance') => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method: 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, payload: body ?? {} });
  assert.ok(r.statusCode >= 400 && r.statusCode < 500, `${role} ${path} should be refused: ${r.statusCode} ${r.body.slice(0, 300)}`);
  return { status: r.statusCode, error: r.json().error ?? '' };
};
const check = (condition, msg) => { browserChecks++; assert.ok(condition, msg); };
const draftBody = (doc, lines, patch = {}) => ({ issueDate: doc.issueDate, dueDate: doc.dueDate, validUntil: doc.validUntil, buyer: doc.buyer, placeOfSupply: doc.placeOfSupply,
  reference: doc.reference ?? {}, notes: doc.notes ?? '', terms: doc.terms, reverseCharge: doc.reverseCharge, zeroRated: doc.zeroRated, roundTotal: doc.roundTotal, templateId: doc.templateId,
  clientId: doc.clientId, contactPersonId: doc.contactPersonId, siteLocation: doc.siteLocation, sxLeadId: doc.sxLeadId ?? null, lines, ...patch });

// ------------------------------------------------------------------------------------ the catalogue and the stock
const item = async (body) => (await call('erp/items', { gstRate: 18, status: 'active', kind: 'product', unit: 'nos', ...body }, 'founder')).id;
const pp5 = await item({ name: 'Pure Power 5.0', code: 'PP-5', sac: '850440', price: 4500000, trackStock: true, serialised: true, warrantyMonths: 60,
  warrantyOptions: [{ months: 24, price: 900000 }, { months: 12, price: 500000 }] });
await item({ name: 'Pure Power 12', code: 'PP-12', sac: '850440', price: 9000000 });
await item({ name: 'Pure Power 120.0', code: 'PP-120', sac: '850440', price: 60000000 });
await item({ name: 'Installation', kind: 'service', sac: '998719', price: 0 });
const pp = await call(`erp/items/${pp5}`);
assert.deepEqual(pp.item.warrantyOptions, [{ months: 12, price: 500000 }, { months: 24, price: 900000 }], 'extensions in order of length');
assert.equal(pp.item.serialised, true); assert.equal(pp.item.warrantyMonths, 60);
assert.match((await refused(`erp/items/${pp5}`, { ...pp.item, warrantyOptions: [{ months: 12, price: 1 }, { months: 12, price: 2 }] }, 'founder')).error, /different number of months/);
// Stock in names each unit; set current stock counts the shelf.
assert.equal((await call(`erp/items/${pp5}/stock`, { kind: 'in', serials: ['syn-pp5-001', 'SYN-PP5-002', 'SYN-PP5-003'], note: 'Synthetic supplier' })).onHand, 3);
assert.match((await refused(`erp/items/${pp5}/stock`, { kind: 'in', serials: ['SYN-PP5-002'] })).error, /already in Pulse/);
await refused(`erp/items/${pp5}/stock`, { kind: 'in', serials: ['SYN-PP5-009'] }, 'member');
const set = await call(`erp/items/${pp5}/stock/set`, { serials: ['SYN-PP5-001', 'SYN-PP5-002', 'SYN-PP5-003', 'SYN-PP5-004'], note: 'Synthetic count' });
assert.deepEqual([set.onHand, set.change, set.serialsIn], [4, 1, 1]);
assert.equal((await call(`erp/items/${pp5}/serials?status=in_stock`)).serials.length, 4);
assert.equal((await call(`erp/items/${pp5}`)).serials.length, 4, 'the item page lists its serials');

// ------------------------------------------------------- 1-2. the customer, found however they are typed
const found = async (q) => call(`erp/parties?q=${encodeURIComponent(q)}`);
for (const q of ['Asohiv Mifos', 'asohiv  mifos', 'mifos asohiv', 'ASOHIV', '98765 43210', '9876543210']) {
  assert.ok((await found(q)).contacts.some((p) => p.id === E.asohiv), `Asohiv Mifos found by "${q}"`);
}
for (const q of ['ajay', 'Ajay Kireteso', 'majestic', '90000 00111']) assert.ok((await found(q)).leads.some((l) => l.id === E.lead), `the lead found by "${q}"`);
assert.ok((await found('northstar homes llp')).clients.some((c) => c.id === E.north), 'a client by its company');
const best = await found('Northstar');
assert.equal(best.clients[0].id, E.north, 'best match first');
assert.equal((await found('zzqx')).clients.length + (await found('zzqx')).contacts.length + (await found('zzqx')).leads.length, 0);
await call('erp/parties?q=ajay', undefined, 'member', 403);
// A lead picked: its name, company, phone and e-mail; a quotation started for it remembers it.
const lead = await call(`erp/parties/pick?lead=${E.lead}`);
assert.deepEqual([lead.buyer.name, lead.buyer.contactName, lead.buyer.phone, lead.clientId, lead.sxLeadId], ['Synthetic Majestic Infra', 'Ajay Kireteso', '+91 90000 00111', null, E.lead]);
// Who a typed customer already is: the same phone however written.
const twins = await call(`erp/parties/twins?phone=${encodeURIComponent('098765-43210')}`);
assert.deepEqual(twins.contacts.map((c) => c.id), [E.asohiv]);

// ------------------------------- 3-6. a quotation from the lead, a warranty on the line, sent for approval, approved
const q = await call('erp/documents', { docType: 'quotation', sxLeadId: E.lead });
let d = await call(`erp/documents/${q.id}`);
assert.equal(d.document.sxLeadId, E.lead); assert.equal(d.document.buyer.name, 'Synthetic Majestic Infra'); assert.equal(d.events[0].detail.from, 'lead');
assert.equal(d.whatsapp.connected, false, 'WhatsApp Business is not linked'); assert.match(d.whatsapp.next, /not part of Pulse yet/);
const pick = d.items.find((i) => i.id === pp5);
assert.equal(pick.serialised, true); assert.equal(pick.warrantyOptions.length, 2);
const lines = [
  { itemId: pp5, description: 'Pure Power 5.0', details: '', sac: '850440', unit: 'nos', qty: 2, rate: 4500000, discount: 0, discountPercent: null, gstRate: 18 },
  { itemId: null, description: 'Extended warranty +2 years: Pure Power 5.0', details: '', sac: null, unit: 'nos', qty: 2, rate: 900000, discount: 0, discountPercent: null, gstRate: 18, parentIndex: 0, warrantyMonths: 24 },
];
assert.match((await refused(`erp/documents/${q.id}`, draftBody(d.document, [{ ...lines[1], parentIndex: null }]))).error, /belongs to the line it extends/);
await call(`erp/documents/${q.id}`, draftBody(d.document, lines));
d = await call(`erp/documents/${q.id}`);
assert.equal(d.lines[1].warrantyMonths, 24); assert.equal(d.document.total, Math.round((9000000 + 1800000) * 1.18), '2 units and 2 two-year extensions, with GST');
assert.equal(d.approval.required, true); assert.equal(d.approval.canApprove, false, 'Finance (not leadership) sends quotations for approval');
assert.ok(d.approval.approvers.some((p) => p.id === E.founder));
assert.match((await refused(`erp/documents/${q.id}/issue`, {})).error, /send it for approval/);
const asked = await call(`erp/documents/${q.id}/approval`, { to: E.founder, note: 'Synthetic: the customer wants it today' });
assert.equal(asked.reminder, false);
assert.equal((await call(`erp/documents/${q.id}/approval`, { to: E.founder })).reminder, true, 'asking again is a reminder');
const forFounder = await call(`erp/documents/${q.id}`, undefined, 'founder');
assert.equal(forFounder.approval.asked.forMe, true); assert.equal(forFounder.approval.canApprove, true); assert.equal(forFounder.approval.asked.by, 'Kedab Accounts');
const home = await call('erp', undefined, 'founder');
assert.ok(home.forMe.some((x) => x.id === q.id), 'the owner\'s Billing home starts with it');
assert.ok((await call('erp')).waiting.some((x) => x.id === q.id), 'the salesperson sees it waiting');
if (!browserOn) {
  const ok = await call(`erp/documents/${q.id}/issue`, {}, 'founder');
  assert.match(ok.number, /^QT/);
  assert.equal(ok.booked.newClient, true, 'approving the quotation books the customer');
  const client = (await call('clients', undefined, 'founder')).clients.find((c) => c.id === ok.booked.clientId);
  assert.equal(client.name, 'Synthetic Majestic Infra');
  assert.equal((await found('majestic')).leads.length, 0, 'the lead is linked to the client now, so it is not offered twice');
  assert.ok((await call('erp')).toSend.some((x) => x.id === q.id), 'approved: it waits to be sent');
}

// ------------------------------------------------- 5. a revision shows R2 and keeps its number; its PDF says so
const q2 = await call('erp/documents', { docType: 'quotation', contactPersonId: E.asohiv });
let d2 = (await call(`erp/documents/${q2.id}`)).document;
assert.equal(d2.buyer.name, 'Asohiv Mifos'); assert.equal(d2.buyer.phone, '+91 98765 43210');
await call(`erp/documents/${q2.id}`, draftBody(d2, [lines[0]].map((l) => ({ ...l, qty: 1 }))));
const n2 = (await call(`erp/documents/${q2.id}/issue`, {}, 'founder')).number;
await call(`erp/documents/${q2.id}/revise`, { reason: 'Synthetic: add the warranty' }, 'founder');
d2 = (await call(`erp/documents/${q2.id}`)).document;
await call(`erp/documents/${q2.id}`, draftBody(d2, [{ ...lines[0], qty: 1 }, { ...lines[1], qty: 1 }]), 'founder');
assert.equal((await call(`erp/documents/${q2.id}/issue`, {}, 'founder')).number, n2, 'the revision keeps its number');
const pdf = await app.inject({ url: `/api/v0/erp/documents/${q2.id}/pdf`, headers: { 'cf-access-authenticated-user-email': emails.finance } }); apiChecks++;
assert.equal(pdf.statusCode, 200); assert.match(pdf.headers['content-disposition'], new RegExp(`${n2.replace(/[^A-Za-z0-9-]+/g, '-')}-R2_`), 'the file is the R2 copy');
const versions = (await call(`erp/documents/${q2.id}`)).versions;
assert.equal(versions.length, 1); assert.equal(versions[0].revision, 0, 'the first copy is kept');

// --------------------------------------------- 4. the invoice names each unit's serial; they leave the stock
const inv = await call('erp/documents', { docType: 'invoice', sourceId: q2.id });
let id = (await call(`erp/documents/${inv.id}`));
assert.deepEqual(id.stockSerials[pp5], ['SYN-PP5-001', 'SYN-PP5-002', 'SYN-PP5-003', 'SYN-PP5-004'], 'the serials in stock are offered');
assert.equal(id.lines[1].warrantyMonths, 24, 'the warranty carries over from the quotation');
assert.match((await refused(`erp/documents/${inv.id}/issue`, {})).error, /Pick 1 serial number for Pure Power 5.0/);
const withSerial = id.lines.map((l, n) => ({ ...l, parentIndex: n === 1 ? 0 : null, serials: n === 0 ? ['syn-pp5-002'] : [] }));
if (!browserOn) {
  await call(`erp/documents/${inv.id}`, draftBody(id.document, withSerial));
  await call(`erp/documents/${inv.id}/issue`, {});
  const after = await call(`erp/items/${pp5}/serials`);
  assert.equal(after.serials.find((x) => x.serial === 'SYN-PP5-002').status, 'sold'); assert.equal(after.serials.filter((x) => x.status === 'in_stock').length, 3);
  const invPdf = await app.inject({ url: `/api/v0/erp/documents/${inv.id}/pdf`, headers: { 'cf-access-authenticated-user-email': emails.finance } }); apiChecks++;
  assert.equal(invPdf.statusCode, 200);
}
// The opening-stock import through Billing (a dry run).
const imp = await call('erp/stock/import', { rows: [{ code: 'pp 5', serials: ['SYN-PP5-001'] }, { name: 'Nothing like it', qty: 2 }] });
assert.deepEqual([imp.applied, imp.matched.length, imp.missing.length], [false, 1, 1]);

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
  let dialogs = 0;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 199) throw Error('web did not start'); }
    browser = await chromium.launch({ headless: true });
    const context = async (role, width) => {
      const c = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
      c.on('page', (p) => { current = p; p.on('pageerror', (e) => console.error('PAGEERROR', p.url().replace(base, ''), e.message)); });
      c.on('dialog', (x) => { dialogs++; void x.accept(x.type() === 'prompt' ? 'Synthetic reason' : undefined); });
      return c;
    };
    // The salesperson, on a phone and on a computer: a blank quotation, the customer typed however, Pure Power found as
    // "purepower 5", a two-year extension on its line, sent to the owner for approval.
    const sent = {};
    for (const width of [390, 1440]) {
      const c = await context('finance', width); const p = await c.newPage();
      await go(p, '/erp/new?type=quotation');
      await p.getByRole('button', { name: 'Start blank quotation' }).click();
      await p.waitForURL(/\/erp\/documents\/[0-9a-f-]{36}$/); await ready(p);
      sent[width] = p.url().match(/documents\/([0-9a-f-]{36})/)[1];
      await p.getByRole('button', { name: /^Client: not chosen/ }).click();
      await p.getByRole('searchbox', { name: 'Search Clients and Contacts' }).fill(width < 500 ? 'mifos asohiv' : '98765 43210');
      await expect(p.getByRole('button', { name: 'Choose contact Asohiv Mifos' })).toBeVisible(); browserChecks++;
      await p.getByRole('searchbox', { name: 'Search Clients and Contacts' }).fill('ajay');
      await expect(p.getByRole('list', { name: 'Leads' }).getByRole('button', { name: 'Choose lead Ajay Kireteso' })).toBeVisible(); browserChecks++;
      await fits(p, 'find the customer'); await shot(p, '01-find-customer');
      await p.getByRole('searchbox', { name: 'Search Clients and Contacts' }).fill(width < 500 ? 'asohiv' : 'mifos');
      await p.getByRole('button', { name: 'Choose contact Asohiv Mifos' }).click();
      await expect(p.getByLabel('Phone')).toHaveValue('+91 98765 43210'); browserChecks++;
      await p.getByRole('button', { name: 'Done', exact: true }).click();
      await p.getByRole('button', { name: 'Whole catalogue' }).click();
      await p.getByRole('textbox', { name: 'Search the catalogue' }).fill(width < 500 ? 'purepower 5' : 'pure power5.0');
      const matches = p.getByRole('list', { name: 'Catalogue matches' });
      await expect(matches.getByRole('button').first()).toHaveAccessibleName('Add Pure Power 5.0'); browserChecks++;
      await shot(p, '02-catalogue-forgiving');
      await matches.getByRole('button', { name: 'Add Pure Power 5.0' }).click();
      await p.getByRole('button', { name: 'Pure Power 5.0: details' }).first().click();
      const line = p.getByRole('dialog', { name: 'Pure Power 5.0' });
      await expect(line.getByRole('radiogroup', { name: 'Extended warranty' })).toBeVisible(); browserChecks++;
      await line.getByText('+2 years', { exact: false }).click();
      await expect(line.getByText(/On the quotation as its own line: Extended warranty \+2 years: Pure Power 5.0/)).toBeVisible(); browserChecks++;
      await fits(p, 'extended warranty'); await shot(p, '03-extended-warranty');
      await line.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(p.getByRole('button', { name: 'Extended warranty +2 years: Pure Power 5.0: details' }).first()).toBeVisible(); browserChecks++;
      // The one main button sends it for approval (this company's quotations wait for a manager or the owner).
      const main = p.getByRole('button', { name: 'Send for approval' }).last();
      await expect(main).toBeVisible(); browserChecks++;
      await fits(p, 'composer'); await shot(p, '04-composer-send-for-approval');
      await main.click();
      const ask = p.getByRole('dialog', { name: 'Send for approval' });
      await ask.getByRole('radio', { name: /Neha Founder/ }).check();
      await ask.getByLabel('A word for them (optional)').fill('Synthetic: customer wants it today');
      await shot(p, '05-send-for-approval');
      const asked = p.waitForResponse((r) => r.url().endsWith('/approval') && r.request().method() === 'POST');
      await ask.getByRole('button', { name: 'Send for approval' }).click();
      check((await asked).ok(), 'sent for approval');
      await expect(p.getByText('Sent to Neha Founder for approval').first()).toBeVisible({ timeout: 20000 }); browserChecks++;
      await expect(p.getByRole('button', { name: /Remind Neha Founder/ }).last()).toBeVisible(); browserChecks++;
      await shot(p, '06-waiting-for-approval');
      await c.close();
    }
    // The owner: Billing starts with the approval; one tap approves it (no dialog), and the page moves on to sending.
    for (const width of [390, 1440]) {
      const c = await context('founder', width); const p = await c.newPage();
      await go(p, '/erp');
      const start = p.getByRole('region', { name: 'Start with' });
      await expect(start.getByRole('link', { name: /Approve the quotation for Asohiv Mifos/ }).first()).toBeVisible(); browserChecks++;
      await fits(p, 'billing home'); await shot(p, '07-billing-home');
      await go(p, `/erp/documents/${sent[width]}`);
      await expect(p.getByText('Kedab Accounts asked you to approve this')).toBeVisible(); browserChecks++;
      const before = dialogs;
      const issued = p.waitForResponse((r) => r.url().endsWith('/issue') && r.request().method() === 'POST');
      await p.getByRole('button', { name: 'Approve', exact: true }).last().click();
      const no = (await (await issued).json()).number; check(/^QT/.test(no), `approved: ${no}`);
      check(dialogs === before, 'approving what was sent to you is one tap: no dialog');
      await expect(p.getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Send on WhatsApp' })).toBeVisible({ timeout: 20000 }); browserChecks++;
      await shot(p, '08-approved');
      // "Send on WhatsApp" answers at once and says what is missing.
      await p.getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Send on WhatsApp' }).click();
      const sheet = p.getByRole('dialog', { name: 'Send on WhatsApp' });
      await expect(sheet.getByText(/can.t send WhatsApp messages for you yet/)).toBeVisible({ timeout: 3000 }); browserChecks++;
      await expect(sheet.getByText(/not part of Pulse yet/)).toBeVisible(); browserChecks++;
      await fits(p, 'send on WhatsApp'); await shot(p, '09-whatsapp-not-linked');
      await c.close();
    }
    // The tax invoice on a phone: the line asks for the serial number; one tap on a serial in stock, then it approves.
    {
      const c = await context('finance', 390); const p = await c.newPage();
      const fresh = await call('erp/documents', { docType: 'invoice', sourceId: q2.id });
      await go(p, `/erp/documents/${fresh.id}`);
      await expect(p.getByText('Pick 1 serial number for Pure Power 5.0').filter({ visible: true }).first()).toBeVisible(); browserChecks++; // the phone's sheet says it
      await shot(p, '10-invoice-needs-serial');
      await p.getByRole('button', { name: 'Pure Power 5.0: details' }).first().click();
      const line = p.getByRole('dialog', { name: 'Pure Power 5.0' });
      await line.getByRole('button', { name: 'Pick serial SYN-PP5-003' }).click();
      await expect(line.getByRole('button', { name: 'Remove serial SYN-PP5-003' })).toBeVisible(); browserChecks++;
      await fits(p, 'serial numbers'); await shot(p, '11-serial-picked');
      await line.getByRole('button', { name: 'Done', exact: true }).click();
      const issued = p.waitForResponse((r) => r.url().endsWith('/issue') && r.request().method() === 'POST');
      await p.getByRole('button', { name: 'Approve', exact: true }).last().click();
      check((await issued).ok(), 'the invoice is approved with its serial');
      await ready(p);
      const s3 = (await call(`erp/items/${pp5}/serials`)).serials.find((x) => x.serial === 'SYN-PP5-003');
      check(s3.status === 'sold', 'the unit left the stock');
      await c.close();
    }
    // The catalogue item: its warranty, its stock by serial number and "Set current stock".
    for (const width of [390, 1440]) {
      const c = await context('founder', width); const p = await c.newPage();
      await go(p, `/erp/catalog/${pp5}`);
      await expect(p.getByRole('region', { name: 'Warranty' })).toBeVisible(); browserChecks++;
      await expect(p.getByRole('button', { name: 'Set current stock' })).toBeVisible(); browserChecks++;
      await fits(p, 'catalogue item'); await shot(p, '12-item-stock-warranty');
      await go(p, '/erp/catalog');
      await p.getByRole('searchbox', { name: /Search/ }).first().fill('PUREPOWER 120');
      await expect(p.getByText('Pure Power 120.0').first()).toBeVisible(); browserChecks++;
      await expect(p.getByText('Installation', { exact: true })).toHaveCount(0); browserChecks++;
      await c.close();
    }
  } catch (e) {
    if (current) {
      if (shots) await current.screenshot({ path: `${shots}/zz-failed.png`, fullPage: true }).catch(() => undefined);
      console.error('FAILED AT', current.url().replace(base, ''), (await current.locator('[role="status"],[role="alert"]').allInnerTexts().catch(() => [])).join(' | ').slice(0, 600));
    }
    throw e;
  } finally {
    await browser?.close(); server.kill(); await app.close();
  }
}

const receipt = JSON.stringify({ apiChecks, browserChecks });
await writeFile(process.env.PULSE_BILLING_REPORT, receipt); console.log(receipt);
await pool.end();
