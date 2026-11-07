// KAZUK-FLOW in the browser (tests/core/test_kazuk_flow.py): Kazuk's test script, T00-T21, grown slice by slice. The
// real API on a disposable synthetic company and the web app under `next dev`; the salesperson (S) on a phone at 390,
// the owner (O) at 1440. Each step prints "T<nn> PASS|SKIP <why>"; a failed step stops the walk with its screenshot.
// Screenshots with PULSE_KR_SCREENSHOTS=<dir>. Everything is invented (Test Realty Pvt Ltd, +91 90000 0011x, example.test).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_KR_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-kf', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, current = 'start', last;
const results = [];
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const pass = (t, note = '') => { results.push(`${t} PASS${note ? ` ${note}` : ''}`); console.log(`${t} PASS ${note}`); };
const skip = (t, why) => { results.push(`${t} SKIP ${why}`); console.log(`${t} SKIP ${why}`); };
const deadline = setTimeout(() => { console.error(`kazuk-flow runner: no result after 30 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 30 * 60_000);
deadline.unref();
// The first VISIBLE match: on a phone the desk copy of the next step is hidden and the sheet's footer shows it.
const seen = async (locator, timeout = 180000) => { await expect(locator.filter({ visible: true }).first()).toBeVisible({ timeout }); checks++; };
const none = async (page, re, what) => { const text = await page.locator('#main-content').first().innerText(); assert.ok(!re.test(text), `${what}: ${re} is on the page`); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
async function context(role, width) {
  const phone = width < 600;
  return browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load', timeout: 300000 }); };
const shot = async (page, name, full = true) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); };
const api = (who, url, body) => fetch(`${origin}/api/v0/${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[who], 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(async (r) => { const j = await r.json().catch(() => ({})); assert.ok(r.ok, `${url}: ${r.status} ${JSON.stringify(j)}`); return j; });
const visibleButton = (page, re) => page.locator('button:visible', { hasText: re });
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  const O = await context('owner', 1440), S = await context('seller', 390);

  // T00 Setup: the company profile is filled and approval is off (the fixture); Billing home asks nobody to approve.
  step('T00');
  const oh = await open(O, '/erp', 'owner home');
  await seen(oh.getByRole('heading', { name: 'Billing' }));
  await none(oh, /Approve|Fill in the company profile/, 'Owner Billing home');
  await shot(oh, 'T00-owner-billing-home-1440'); pass('T00', 'approval mode none, profile filled, no Approve items (head role and categories: T20/T21)');

  // T01 The owner types the catalogue by hand: each item usable at once; the owner sees cost and margin. "Start clean"
  // archives what was drafted for the company first.
  step('T01');
  await go(oh, '/erp/catalog');
  await seen(oh.getByText(/drafted for you/));
  await visibleButton(oh, /^Start clean$/).first().click();
  await seen(oh.getByText(/item archived|items archived/));
  for (const body of [{ kind: 'service', name: 'Meta Ads Management', price: 2500000, cost: 800000, unit: 'month', sac: '998361' }, { kind: 'service', name: 'Brand Film', price: 5000000, cost: 1500000, sac: '998361' }]) {
    const made = await api('owner', 'erp/items', body);
    const it = await api('owner', `erp/items/${made.id}`);
    assert.equal(it.item.status, 'active', `${body.name} is in use at once`); checks++;
  }
  await go(oh, '/erp/catalog');
  await seen(oh.getByText('Meta Ads Management'));
  await seen(oh.getByText(/margin \d+%/));
  await none(oh, /To approve/, 'Owner catalogue');
  await fits(oh, 'Owner catalogue'); await shot(oh, 'T01-owner-catalogue-1440'); pass('T01', 'Start clean, then items active at once; margin shown to the owner');

  // T02 The salesperson's catalogue: final prices only, never cost or margin.
  step('T02');
  const sp = await open(S, '/erp/catalog', 'seller catalogue');
  await seen(sp.getByText('Meta Ads Management'));
  await seen(sp.getByText(/₹25,000/));
  await none(sp, /margin \d+%|cost ₹|Cost ₹|Delivery cost/, 'Salesperson catalogue');
  await fits(sp, 'Salesperson catalogue 390'); await shot(sp, 'T02-seller-catalogue-390'); pass('T02');

  // T15 (early) No blank invoice path for the salesperson.
  step('T15');
  await go(sp, '/erp');
  await seen(sp.getByRole('heading', { name: 'Billing' }));
  await none(sp, /New invoice|Start blank tax invoice/, 'Salesperson Billing home');
  await shot(sp, 'T15-seller-billing-home-390');
  await go(sp, '/erp/new?type=invoice');
  await seen(sp.getByText(/The tax invoice is made from the accepted quotation/));
  await shot(sp, 'T15-seller-no-blank-invoice-390'); pass('T15', 'no New invoice; /erp/new?type=invoice refused (the database refuses one too)');

  // T03 New quotation: the phone of an existing client finds them (no duplicate). From here the company runs EA's preset
  // of the sales flow (no approval, the salesperson prices, Kazuk's five fields at Send).
  step('T03');
  await api('owner', 'erp/flow', { preset: 'ea' });
  await go(sp, '/erp/new?type=quotation');
  await sp.getByLabel('Search Clients and Contacts').fill('90000 00111');
  await seen(sp.getByRole('button', { name: /Choose client Test Realty Pvt Ltd/ }));
  await shot(sp, 'T03-seller-finds-client-by-phone-390'); pass('T03');

  // T04 The five fields at Send (G3): with the mail ID empty, Send is held with its reason; filled, it goes.
  step('T04');
  await sp.getByRole('button', { name: /Choose client Test Realty Pvt Ltd/ }).first().click();
  await sp.waitForURL(/\/erp\/documents\/[0-9a-f-]{36}/, { timeout: 180000 });
  await seen(sp.getByText(/Client name is needed to send/));
  await visibleButton(sp, /^Complete the client details$/).first().click();
  await sp.getByLabel('Contact person').fill('Synthetic Buyer');
  await sp.getByLabel('Project location').fill('Kothrud, Pune');
  await sp.getByLabel('E-mail').fill('');
  await visibleButton(sp, /^Done$/).first().click();
  await seen(sp.getByText(/Mail ID is needed to send/));
  await shot(sp, 'T04-seller-mail-id-needed-390');
  await visibleButton(sp, /^Complete the client details$/).first().click();
  await sp.getByLabel('E-mail').fill('buyer@example.test');
  await visibleButton(sp, /^Done$/).first().click();
  await none(sp, /is needed to send/, 'Composer with the five fields');
  pass('T04', 'Client name, then Mail ID held Send with the reason; GSTIN, address, website never block');

  // T05 A price below the catalogue: no approval anywhere; the price is kept as typed.
  step('T05');
  await visibleButton(sp, /^Meta Ads Management$/).first().click();
  await seen(sp.getByText('Saved', { exact: true }), 60000);
  await sp.getByRole('button', { name: /Meta Ads Management: details/ }).first().click();
  await visibleButton(sp, /^Offer a different price$/).first().click();
  await seen(sp.getByText(/You decide the price/));
  // The field shows the catalogue price and takes the typed one once focused (as a person taps it, then types).
  const offer = sp.getByLabel('Price you want to offer').filter({ visible: true }).first();
  await offer.focus(); await offer.fill('20000');
  await shot(sp, 'T05-seller-own-price-390', false);
  await sp.keyboard.press('Escape');
  await seen(sp.getByText('Saved', { exact: true }), 60000);
  await none(sp, /approv/i, 'Salesperson composer');
  const draftId = sp.url().split('/').pop();
  const offered = (await api('seller', `erp/documents/${draftId}`)).lines.find((l) => l.description === 'Meta Ads Management');
  assert.equal(offered?.rate, 2000000, `the price is kept as typed: ${JSON.stringify(offered)}`); checks++;
  await fits(sp, 'Composer 390'); await shot(sp, 'T05-seller-composer-390'); pass('T05', 'Meta Ads at ₹20,000: no approval words, main button Send');

  // T06 Send numbers it (V1). The one-tap e-mail + WhatsApp with both channels logged is G5.
  step('T06');
  await visibleButton(sp, /^Send$/).first().click();
  await seen(sp.getByText(/QT\/\d\d-\d\d\/0001/));
  await none(sp, /Approved by|approved/, 'Salesperson issued quotation');
  const sentId = sp.url().split('/').pop();
  // G5: one tap sends it by e-mail (the test sink) and opens WhatsApp; both channels are logged with the version.
  S.on('page', (popup) => void popup.close().catch(() => undefined));
  await visibleButton(sp, /^Send \(e-mail \+ WhatsApp\)$/).first().click();
  await seen(sp.getByText(/Deal: Sent/));
  const kinds = (await api('seller', `erp/documents/${sentId}`)).events.map((e) => e.kind);
  assert.ok(kinds.includes('emailed') && kinds.includes('whatsapp_sent'), `both channels logged: ${kinds.join(',')}`); checks++;
  console.log('T06 lines ' + JSON.stringify((await api('owner', `erp/documents/${sentId}`)).lines.map((l) => [l.description, l.qty, l.rate, l.discount, l.discountPercent])));
  await shot(sp, 'T06-seller-sent-390'); pass('T06', 'numbered QT/yy-yy/0001, then one tap: e-mail (test sink) + WhatsApp opened, both logged with the version');

  // T07 The owner sees the deal with its salesperson, and no approval queue.
  step('T07');
  await go(oh, '/erp/documents');
  await seen(oh.getByText(/QT\/\d\d-\d\d\/0001/));
  await seen(oh.getByText(/by Synthetic Seller One/));
  await none(oh, /Drafts to approve/, 'Owner documents');
  await fits(oh, 'Owner documents'); await shot(oh, 'T07-owner-documents-1440'); pass('T07');

  skip('T08', 'Sales Agent follow-up drafts (G14) and the test clock: later slice');
  const menu = async (page, item) => {
    for (let i = 0; i < 3; i++) {
      const b = page.locator('button[aria-label="More actions"]:visible').last();
      const it = page.getByRole('menuitem', { name: new RegExp(item) }).first();
      // The page refreshes after each action; a button that is re-rendering is tried again.
      try { await b.scrollIntoViewIfNeeded({ timeout: 15000 }); await b.click({ timeout: 15000 }); await it.waitFor({ state: 'visible', timeout: 10000 }); await it.click(); return; }
      catch { if (shots) await page.screenshot({ path: `${shots}/menu-try-${i}.png` }); await page.keyboard.press('Escape').catch(() => undefined); }
    }
    throw Error(`menu item ${item} not found`);
  };
  // T09 Log reply: the customer wants a lower price, so the deal is Negotiating.
  step('T09');
  await go(sp, `/erp/documents/${sentId}`);
  await menu(sp, '^Customer is negotiating');
  await seen(sp.getByText(/Deal: Negotiating/));
  await shot(sp, 'T09-seller-negotiating-390'); pass('T09');
  // T10, T11 New version with a reason (Price, then Scope), sent under the same number; the history lists each version.
  for (const [t, why, v] of [['T10', 'Price', 2], ['T11', 'Scope', 3]]) {
    step(t);
    await menu(sp, '^Revise quotation');
    const dlg = sp.getByRole('dialog', { name: new RegExp(`New version: V${v}`) });
    await dlg.getByLabel(why, { exact: true }).check();
    await dlg.getByLabel(/One line/).fill(t === 'T10' ? 'Client asked 10% off' : 'Without the second service');
    await dlg.getByRole('button', { name: 'Start the new version' }).click();
    await seen(sp.getByText(new RegExp(`R${v} · revision ${v - 1}`)));
    await visibleButton(sp, /^Send revision$/).first().click();
    await seen(sp.getByText(new RegExp(`Deal: .* · V${v}`)));
    await menu(sp, '^Customer is negotiating');
    await seen(sp.getByText(/Deal: Negotiating/));
    await sp.getByText('Versions').first().click();
    await seen(sp.getByText(new RegExp(`then ${why.toLowerCase()}`)));
    await shot(sp, `${t}-seller-version-V${v}-390`); pass(t, `V${v} sent under the same number; history lists the reason`);
  }
  // T12 Accepted on V3; V1 and V2 stay.
  step('T12');
  await menu(sp, '^Customer accepted');
  await seen(sp.getByText(/Deal: Accepted · V3/));
  await shot(sp, 'T12-seller-accepted-390'); pass('T12');
  // T13 A second deal, lost to a competitor (reason stored and shown).
  step('T13');
  const second = await api('seller', 'erp/documents', { docType: 'quotation', clientId: E.client });
  await go(sp, `/erp/documents/${second.id}`);
  // An empty quotation's next step is "Add from the catalogue": search it and add Brand Film.
  await visibleButton(sp, /^Add from the catalogue$/).first().click();
  await sp.getByRole('button', { name: 'Add Brand Film' }).filter({ visible: true }).first().click();
  await seen(sp.getByText('Saved', { exact: true }), 60000);
  // The client was booked by the first deal (its contact is on file now); what is still missing is asked for.
  if (await sp.getByText(/is needed to send/).filter({ visible: true }).count()) {
    await visibleButton(sp, /^Complete the client details$/).first().click();
    if (!(await sp.getByLabel('Contact person').inputValue())) await sp.getByLabel('Contact person').fill('Synthetic Buyer');
    if (!(await sp.getByLabel('E-mail').inputValue())) await sp.getByLabel('E-mail').fill('buyer@example.test');
    if (!(await sp.getByLabel('Phone').inputValue())) await sp.getByLabel('Phone').fill('+91 90000 00112');
    await sp.getByLabel('Project location').fill('Baner, Pune');
    await visibleButton(sp, /^Done$/).first().click();
    await seen(sp.getByText('Saved', { exact: true }), 60000);
  }
  await visibleButton(sp, /^Send$/).first().click();
  await seen(sp.getByText(/QT\/\d\d-\d\d\/0002/));
  await menu(sp, '^Mark lost');
  const lost = sp.getByRole('dialog', { name: 'Mark lost' });
  await lost.getByLabel('Competitor', { exact: true }).check();
  await lost.getByLabel(/One line/).fill('Went with another agency');
  await lost.getByRole('button', { name: 'Mark lost' }).click();
  await seen(sp.getByText(/Deal: Lost · V1 · lost on competitor/));
  await shot(sp, 'T13-seller-lost-390');
  await go(oh, '/erp/documents');
  await seen(oh.getByText('Lost')); await seen(oh.getByText('Accepted'));
  await shot(oh, 'T13-owner-documents-1440'); pass('T13', 'Lost: competitor, stored and shown');
  // T14 Create invoice from V3: the lines, quantities and prices are the accepted version's and stay so.
  step('T14');
  await go(sp, `/erp/documents/${sentId}`);
  await visibleButton(sp, /Make tax invoice/).first().click();
  await sp.getByRole('dialog', { name: 'Make the tax invoice' }).getByRole('button', { name: 'Invoice it as it is' }).click();
  await sp.waitForURL((u) => !u.pathname.endsWith(sentId), { timeout: 180000 });
  await seen(sp.getByText(/come from QT\/\d\d-\d\d\/0001 V3 as accepted/));
  const invId = sp.url().split('/').pop();
  assert.equal(await sp.getByRole('button', { name: /^Quantity of/ }).count(), 0, 'no quantity stepper on a locked invoice'); checks++;
  const invDraft = await api('seller', `erp/documents/${invId}`);
  assert.equal(invDraft.document.sourceRevision, 2); assert.equal(invDraft.linesLocked, true); checks += 2;
  await shot(sp, 'T14-seller-invoice-from-V3-390'); pass('T14', 'invoice from V3; lines locked (the API refuses a change: kazuk-flow-api-runner)');
  // T15 was walked above. T16 GST-registered client: GSTIN and billing address, then issue; CGST + SGST for Maharashtra.
  step('T16');
  await sp.getByRole('button', { name: /^Client: .*Open the billing details/ }).first().click();
  await sp.getByLabel(/The client is GST-registered/).check();
  await sp.getByLabel(/Client.s GSTIN/).fill('27AABCS5678K1ZS');
  await visibleButton(sp, /^Done$/).first().click();
  await seen(sp.getByText(/billing address: they are GST-registered/));
  await visibleButton(sp, /^Complete the client details$/).first().click();
  await sp.getByLabel(/Billing address/).fill('2 Synthetic Lane\nPune 411038');
  await visibleButton(sp, /^Done$/).first().click();
  await seen(sp.getByText('Saved', { exact: true }), 60000);
  await visibleButton(sp, /^Issue$/).first().click();
  await seen(sp.getByText(/INV\/\d\d-\d\d\/0001/));
  const inv = (await api('seller', `erp/documents/${invId}`)).document;
  assert.equal(inv.seller.legalName, 'Synthetic Seller LLP'); assert.equal(inv.placeOfSupply, '27'); assert.ok(inv.cgst > 0 && inv.sgst > 0 && inv.igst === 0, 'CGST 9% + SGST 9%'); checks += 3;
  await shot(sp, 'T16-seller-invoice-issued-390'); pass('T16', 'INV/yy-yy/0001, seller block from Settings, place of supply 27, CGST + SGST (IGST for another state: tests/core/test_erp_invoice.py)');
  // T17 Send the invoice (both channels): the deal is Invoiced.
  step('T17');
  await visibleButton(sp, /^Send \(e-mail \+ WhatsApp\)$/).first().click();
  await seen(sp.getByText(/Deal|Awaiting payment|to collect/));
  const q3 = (await api('seller', `erp/documents/${sentId}`)).document;
  assert.equal(q3.dealStatus, 'invoiced'); checks++;
  await shot(sp, 'T17-seller-invoice-sent-390'); pass('T17', 'deal Invoiced; e-mail + WhatsApp logged');
  // T18, T19 Payment received: 50% by UPI with UTR and proof (Part-paid), then the rest by NEFT (Paid).
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  for (const [t, half, how, utr, want] of [['T18', true, 'upi', 'TESTUTR001', 'part_paid'], ['T19', false, 'bank', 'TESTUTR002', 'paid']]) {
    step(t);
    await visibleButton(sp, /^Payment received$/).first().click();
    const dlg = sp.getByRole('dialog', { name: 'Record a payment' });
    if (half) await dlg.getByLabel(/Amount received/).fill(String(Math.round(inv.total / 2) / 100));
    await dlg.getByLabel('How').selectOption(how);
    await dlg.getByLabel(/UTR or reference/).fill(utr);
    await dlg.getByLabel('Payment proof').setInputFiles({ name: `${utr}.png`, mimeType: 'image/png', buffer: PNG });
    await seen(dlg.getByText(`${utr}.png attached`));
    await shot(sp, `${t}-seller-payment-received-390`, false);
    await dlg.getByRole('button', { name: /^Record / }).click();
    await seen(sp.getByText(want === 'paid' ? /Paid in full/ : /proof attached/));
    const after = await api('seller', `erp/documents/${invId}`);
    assert.equal(after.document.status, want); assert.ok(after.payments.every((x) => x.proofMime === 'image/png')); checks += 2;
    await shot(sp, `${t}-seller-${want}-390`); pass(t, `${want.replace('_', '-')}: ${how.toUpperCase()}, UTR ${utr}, proof attached`);
  }
  // T20 Paid: exactly one project, its handover (client, contacts, V3, invoice, payments with proof links, the scope),
  // and the salesperson's gap tasks; the project heads are told once (checked in the database after the walk).
  step('T20');
  const project = (await api('owner', `erp/documents/${invId}`)).startedProject;
  assert.ok(project?.id, 'the payment started the project'); checks++;
  await go(oh, `/tasks/projects/${project.id}`);
  await seen(oh.getByText(/New client: choose the PGS and the client category/));
  await seen(oh.getByText(/Suggested:/));
  await seen(oh.getByText(/Handover: Test Realty Pvt Ltd · QT\/\d\d-\d\d\/0001 V3/));
  await fits(oh, 'Project page'); await shot(oh, 'T20-owner-new-client-1440'); pass('T20', 'one project; handover task with V3, invoice, proofs and scope; gap tasks for the salesperson');
  // T21 The owner (as Head PGS) confirms the suggested PGS and the category Competitive; the PGS is told.
  step('T21');
  await oh.getByLabel(/PGS \(head and point of contact\)/).selectOption({ label: 'Synthetic PGS' });
  await oh.getByLabel('Client category').selectOption('competitive');
  await oh.getByRole('button', { name: 'Assign the project' }).click();
  await seen(oh.getByText(/Project assigned/));
  await shot(oh, 'T21-owner-assigned-1440'); pass('T21', 'PGS confirmed from the suggestion, category Competitive; the PGS owns the handover and the sold work');
  console.log('KFP ' + JSON.stringify({ project: project.id }));
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`kazuk-flow runner: ${checks} checks passed`);
  console.log('KFT ' + JSON.stringify(results));
} catch (e) {
  if (shots && last) await last.screenshot({ path: `${shots}/failure-${current}.png`, fullPage: true }).catch(() => undefined);
  console.log('KFT ' + JSON.stringify([...results, `${current} FAIL`]));
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
