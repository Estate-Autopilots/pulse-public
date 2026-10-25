// ERP-INVOICE end to end, through the real API and the built web app, on a disposable synthetic tenant
// (tests/core/test_erp_invoice.py::test_erp_screens_in_the_browser). Synthetic company address, clients, contacts,
// projects, packages and figures only. Optional screenshots: PULSE_ERP_SCREENSHOTS=<dir>.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { addDays, buildModel, FONT_URLS, renderPdf } from '@pulse/invoice-doc';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool); let apiChecks = 0, browserChecks = 0;
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS);
const shots = process.env.PULSE_ERP_SCREENSHOTS;
const call = async (path, body, role = 'founder', expected = 200) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${role} ${path}: ${r.body.slice(0, 400)}`);
  return r.headers['content-type']?.includes('json') ? r.json() : r.rawPayload;
};
const ist = (days = 0) => new Date(Date.now() + 5.5 * 36e5 + days * 864e5).toISOString().slice(0, 10);
const check = (condition, msg) => { browserChecks++; assert.ok(condition, msg); };

// ---------------------------------------------------------------------------------------------- the company's ERP
await call('erp');
await call('erp/settings', { company: { legalName: 'Vikriya Solutions LLP', tradeName: 'Estate Autopilots', gstin: '27AAXFV2138F1ZR', address: ['Office 2, Synthetic Business Park, Baner', 'Pune 411045, Maharashtra'],
  email: 'billing@example.test', phone: '+91 90000 00000', website: 'estateautopilots.com' }, dueDays: 15, roundTotal: true, inventoryEnabled: true });
const member = await app.inject({ url: '/api/v0/erp', headers: { 'cf-access-authenticated-user-email': emails.member } }); apiChecks++;
assert.equal(member.statusCode, 403, 'a member has no ERP');
assert.equal((await call('erp/settings', { company: { legalName: 'X' } }, 'member', 403)).error, 'Invoicing is for leadership and the Finance role');
const svc = async (body) => (await call('erp/items', { gstRate: 18, status: 'active', ...body })).id;
const film = await svc({ kind: 'service', name: 'Model-led brand film', sac: '999612', unit: 'video', price: 2400000, cost: 1280000 });
const ads = await svc({ kind: 'service', name: 'Meta ads management', sac: '998361', unit: 'month', price: 1200000, cost: 480000 });
const single = await svc({ kind: 'service', name: 'Single image performance ad', sac: '998391', unit: 'creative', price: 120000, cost: 40000 });
const brochure = await svc({ kind: 'consumable', name: 'Site brochure (printed)', sac: '4911', unit: 'nos', price: 4500, cost: 2200, gstRate: 12, trackStock: true, reorderLevel: 100 });
await call(`erp/items/${brochure}/stock`, { kind: 'in', qty: 500, note: 'Synthetic print run' });
await call(`erp/items/${brochure}/stock`, { kind: 'out', qty: 430, note: 'Riverside site launch' });
const pkg = await svc({ kind: 'package', name: '4 Month real-estate marketing', sac: '998361', unit: 'package', price: 12000000, cost: 7800000, status: 'draft',
  description: 'Strategy, model-led films, ads and reports for a project launch', milestones: [1, 2, 3, 4].map((n) => ({ label: `Month ${n}`, percent: 25, offsetDays: 30 * (n - 1) })) });
assert.deepEqual((await call(`erp/items/${pkg}/parts`, { parts: [
  { label: 'Research, big idea and positioning', quantity: 1, deliverables: ['Positioning note', 'Big idea'], where: 'Client folder › Strategy', setup: 'Creative strategist', derives: 'Scripts and every ad', price: 1000000, cost: 70000 },
  { label: 'Model-led brand films', itemId: film, quantity: 3, unit: 'video', deliverables: ['3 model-led films'], where: 'Drive › Edits', setup: 'Strategist, model, videographer, editor', derives: 'Meta ads, site screens', price: 7200000, cost: 3840000 },
  { label: 'Meta ads management', itemId: ads, quantity: 4, unit: 'month', deliverables: ['Campaigns', 'Weekly lead report'], where: 'Meta Business Manager', setup: 'Performance marketer', derives: 'Leads for the sales team', price: 4800000, cost: 1920000 },
] })), { parts: 3 });
await call(`erp/items/${pkg}`, { name: '4 Month real-estate marketing', price: 12000000, cost: 7800000, gstRate: 18, sac: '998361', unit: 'package', status: 'active',
  description: 'Strategy, model-led films, ads and reports for a project launch', milestones: [1, 2, 3, 4].map((n) => ({ label: `Month ${n}`, percent: 25, offsetDays: 30 * (n - 1) })) });
const item = await call(`erp/items/${pkg}`);
assert.equal(item.parts.length, 3); assert.ok(item.versions.length >= 3, 'every save is a version'); assert.equal(item.item.status, 'active');
// A logo for the bold template: a synthetic wordmark drawn by the browser below; Classic uses none.

// ----------------------------------------------------------------- a package sold on a project, invoiced by month
const start = ist(-57);
const eng = (await call('erp/engagements', { projectId: E.riverside, packageId: pkg, startsOn: start })).id;
let ctx = await call(`erp/projects/${E.riverside}`);
const ms = ctx.engagements.find((e) => e.id === eng).milestones;
assert.deepEqual(ms.map((m) => m.amount), [3000000, 3000000, 3000000, 3000000]);
assert.equal(ctx.contacts[0].name, 'Asha Kireteso', 'the client contact is fetched');
const issueDraft = async (id, day, extra = {}) => {
  const d = await call(`erp/documents/${id}`);
  const lines = d.lines.map(({ id: _x, taxable: _a, cgst: _b, sgst: _c, igst: _d, total: _e, ...l }) => l);
  await call(`erp/documents/${id}`, { ...d.document, issueDate: day, dueDate: addDays(day, 15), lines, ...extra });
  return (await call(`erp/documents/${id}/issue`, {})).number;
};
await call(`erp/parties/${E.north}`, { name: 'Northstar Homes LLP', gstin: '27AABCS5678K1ZS', address: ['Office 4, Riverside Plaza, Baner Road', 'Pune 411045'], contactPersonId: E.asha, contactName: 'Asha Kireteso', email: 'accounts@northstar.example', phone: '+91 90000 00001' });
const m1 = (await call(`erp/milestones/${ms[0].id}/invoice`, {})).id;
const n1 = await issueDraft(m1, ist(-56));
assert.match(n1, /^INV\/\d\d-\d\d\/0001$/);
const d1 = await call(`erp/documents/${m1}`);
assert.equal(d1.document.buyer.gstin, '27AABCS5678K1ZS'); assert.equal(d1.document.taxMode, 'intra');
assert.deepEqual([d1.document.taxable, d1.document.cgst, d1.document.sgst, d1.document.total], [3000000, 270000, 270000, 3540000]);
assert.equal(d1.document.amountWords, 'Rupees Thirty Five Thousand Four Hundred Only');
assert.ok(d1.file?.sha256, 'the issued PDF is filed');
await call(`erp/documents/${m1}/payments`, { amount: 3540000, receivedOn: ist(-45), method: 'bank', reference: 'UTR SYNTH0001' });
assert.equal((await call(`erp/documents/${m1}`)).document.status, 'paid');
// The filed PDF is exactly what @pulse/invoice-doc draws for the stored document and its frozen template.
{
  const fonts = { regular: await readFile(FONT_URLS.regular), semibold: await readFile(FONT_URLS.semibold) };
  const stored = Buffer.from(await call(`erp/documents/${m1}/pdf`));
  const doc = d1.document;
  const input = { docType: doc.docType, status: 'issued', number: doc.number, issueDate: doc.issueDate, dueDate: doc.dueDate, validUntil: doc.validUntil, seller: doc.seller, buyer: doc.buyer,
    placeOfSupply: doc.placeOfSupply, reference: doc.reference, against: null, notes: doc.notes || null, terms: doc.terms, reverseCharge: doc.reverseCharge, zeroRated: doc.zeroRated, roundTotal: doc.roundTotal, paid: 0, credited: 0,
    lines: d1.lines.map((l) => ({ description: l.description, details: l.details, sac: l.sac, unit: l.unit, qty: l.qty, rate: l.rate, discount: l.discount, discountPercent: l.discountPercent, gstRate: l.gstRate })) };
  const again = Buffer.from((await renderPdf(buildModel(d1.template.design, input, {}), { fonts })).bytes);
  assert.ok(stored.equals(again), 'the issued copy is byte-identical to the renderer output for the same document');
  apiChecks++;
}
const m2 = (await call(`erp/milestones/${ms[1].id}/invoice`, {})).id;
const n2 = await issueDraft(m2, ist(-27));
await call(`erp/documents/${m2}/mark`, { action: 'sent' });
await call(`erp/documents/${m2}/payments`, { amount: 2000000, receivedOn: ist(-10), method: 'upi' });
const cn = (await call('erp/documents', { docType: 'credit_note', againstId: m2 })).id;
const cnDoc = await call(`erp/documents/${cn}`);
await call(`erp/documents/${cn}`, { ...cnDoc.document, issueDate: ist(-9), lines: [{ description: 'Goodwill credit: one film re-shoot', sac: '998361', qty: 1, rate: 200000, gstRate: 18 }] });
const cnNo = (await call(`erp/documents/${cn}/issue`, {})).number;
assert.match(cnNo, /^CN\/\d\d-\d\d\/0001$/);
const after = (await call(`erp/documents/${m2}`)).document;
assert.deepEqual([after.status, after.paid, after.credited], ['part_paid', 2000000, 236000]);
assert.equal((await call(`erp/documents/${m2}/payments`, { amount: 3540000, receivedOn: ist() }, 'founder', 400)).error.startsWith('That is more than the balance due'), true);
// A quotation for the client in another state: IGST; it gets an acceptance link.
const q = (await call('erp/documents', { docType: 'quotation', projectId: E.towers })).id;
const qd = await call(`erp/documents/${q}`);
assert.equal(qd.document.buyer.gstin, '29AAACN1234F1ZT', 'the GSTIN comes from the Zoho invoice FIN-LIVE read');
await call(`erp/documents/${q}`, { ...qd.document, issueDate: ist(-3), validUntil: ist(27), buyer: { ...qd.document.buyer, address: ['12 Lake Road, Indiranagar', 'Bengaluru 560038'] },
  lines: [{ itemId: pkg, description: '4 Month real-estate marketing', details: 'Strategy, three model-led films, Meta ads for four months', sac: '998361', qty: 1, rate: 12000000, gstRate: 18 },
    { itemId: brochure, description: 'Site brochure (printed)', sac: '4911', qty: 250, unit: 'nos', rate: 4500, gstRate: 12 }] });
const qn = (await call(`erp/documents/${q}/issue`, {})).number;
const qdoc = (await call(`erp/documents/${q}`)).document;
assert.equal(qdoc.taxMode, 'inter'); assert.equal(qdoc.igst, 2160000 + 135000);
await call(`erp/documents/${q}/mark`, { action: 'sent' }); // EST-1239: a sent quotation has a follow-up (EST-1238)
const link = (await call(`erp/documents/${q}/link`, { days: 30 })).url;
const token = link.split('/accept/')[1];
// Exports for the books.
const tally = (await call(`erp/exports/tally?from=${ist(-200)}&to=${ist()}`)).toString();
assert.match(tally, /VCHTYPE="Sales"[^]*VCHTYPE="Credit Note"/); assert.ok(tally.includes(n1) && tally.includes(cnNo));
const zoho = (await call(`erp/exports/zoho-books?from=${ist(-200)}&to=${ist()}`)).toString();
assert.ok(zoho.includes('"27AABCS5678K1ZS","MH"'));

// ------------------------------------------------------------------------------------------------ the browser
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
  env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: 'production', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next' }, stdio: 'ignore' });
let browser;
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }); await page.waitForTimeout(300); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await ready(page); };
// The live preview's own section: "Customer's copy" in the document composer; the template editor names it after the
// template and kind ("Bold band · Invoice"), at both widths (EST-1688).
const COPY = `section[aria-label="Customer's copy"]`, BOLD_BAND = 'section[aria-label^="Bold band · "]';
const drawn = async (page, preview = COPY) => {
  await expect(page.locator('[aria-live="polite"]', { hasText: 'exactly as exported' }).first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator(`${preview} canvas[data-pdf-page="1"]`).first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(400); browserChecks++;
};
try {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 199) throw Error('ERP browser web did not start'); }
  browser = await chromium.launch({ headless: true });
  const context = async (role, width = 1440, theme = 'light') => {
    const c = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, ...(role ? { extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } } : {}) });
    await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private mode */ } }, theme);
    c.on('page', (p) => {
      p.on('pageerror', (e) => console.error('PAGEERROR', p.url().replace(base, ''), e.message, (e.stack ?? '').split('\n').slice(0, 4).join(' | ')));
      p.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', p.url().replace(base, ''), m.text().slice(0, 600)); });
    });
    return c;
  };
  // A synthetic wordmark for the bold template, drawn here and uploaded through the API.
  {
    const c = await context(null); const p = await c.newPage();
    await p.setContent('<div id="m" style="display:inline-flex;align-items:center;gap:10px;padding:6px 10px;font:700 34px system-ui;color:#1f2a44"><span style="width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#7c6cf2,#3b2bb5);display:inline-block"></span>Estate&nbsp;Autopilots</div>');
    const png = await p.locator('#m').screenshot({ omitBackground: true });
    const asset = (await call('erp/assets', { kind: 'logo', mime: 'image/png', data: png.toString('base64') })).id;
    const tpls = await call('erp/templates');
    const bold = tpls.templates.find((t) => t.name === 'Bold band');
    await call(`erp/templates/${bold.id}`, { logoId: asset, design: { ...bold.design, style: 'band', accent: '#1f2a44', terms: 'Payment within 15 days of the invoice date. Interest at 18% a year on late payment.', footer: 'Synthetic data for screenshots.',
      bank: { accountName: 'Vikriya Solutions LLP', bankName: 'Synthetic Bank', branch: 'Baner, Pune', accountNumber: '000000000000', ifsc: 'SYNT0000001', upi: 'synthetic@bank' }, signature: { label: 'Authorised signatory', name: 'Neha Founder', title: 'Designated partner' } } });
    const classic = tpls.templates.find((t) => t.name === 'Classic');
    await call(`erp/templates/${classic.id}`, { design: { ...classic.design, bank: { accountName: 'Vikriya Solutions LLP', bankName: 'Synthetic Bank', branch: 'Baner, Pune', accountNumber: '000000000000', ifsc: 'SYNT0000001' },
      signature: { label: 'Authorised signatory', name: 'Neha Founder', title: 'Designated partner' }, footer: 'Synthetic data for screenshots.' } });
    await c.close();
  }
  // 1. Leadership: the overview shows milestone 3 due; one click gives its invoice to the Finance person as a task.
  const lead = await context('founder'); const page = await lead.newPage();
  page.on('dialog', (d) => d.accept());
  await go(page, '/erp');
  await expect(page.getByRole('heading', { name: 'Billing', exact: true, level: 2 })).toBeVisible(); browserChecks++;
  const due = page.locator('section', { has: page.getByRole('heading', { name: /Invoices due/ }) });
  await expect(due.getByText('Riverside Residences launch · Month 3')).toBeVisible(); browserChecks++;
  await due.getByRole('button', { name: 'Assign' }).first().click();
  await due.getByRole('combobox', { name: 'Who generates this invoice' }).selectOption({ label: 'Kedab Accounts' });
  const assigned = page.waitForResponse((r) => r.url().includes('/invoice') && r.request().method() === 'POST');
  await due.getByRole('button', { name: 'Assign', exact: true }).click();
  const made = await (await assigned).json(); check(made.taskId && made.id, 'the task is created with the draft attached');
  // 2. The Finance person opens the draft in the Billing composer: the client (with its GSTIN) and the package line are
  // already there; a catalogue chip adds a line and its +/− sets the quantity; the total and the customer's copy follow.
  const fin = await context('finance'); const f = await fin.newPage(); f.on('dialog', (d) => d.accept());
  await go(f, `/erp/documents/${made.id}`);
  await expect(f.getByRole('button', { name: /^Client: Northstar Homes LLP/ })).toBeVisible(); browserChecks++;
  await expect(f.getByRole('list', { name: 'Lines' }).getByText('4 Month real-estate marketing: Month 3')).toBeVisible(); browserChecks++;
  await drawn(f);
  await f.getByRole('group', { name: 'Add from the catalogue' }).getByRole('button', { name: 'Single image performance ad' }).click();
  const qty = f.getByRole('spinbutton', { name: 'Quantity of Single image performance ad' });
  await expect(qty).toHaveValue('1'); browserChecks++;
  await f.getByRole('button', { name: 'More: Quantity of Single image performance ad' }).click();
  await qty.fill('4');
  await expect(f.getByText('₹41,064').first()).toBeVisible(); browserChecks++;
  await drawn(f);
  if (shots) await f.screenshot({ path: `${shots}/02b-invoice-editor-catalog-line-1440-light.png` });
  const issued = f.waitForResponse((r) => r.url().endsWith('/issue') && r.request().method() === 'POST');
  await f.getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Approve', exact: true }).click();
  const n3 = (await (await issued).json()).number; check(/^INV\/\d\d-\d\d\/0003$/.test(n3), `the third invoice number: ${n3}`);
  await expect(f.getByRole('heading', { name: `Tax Invoice ${n3}` })).toBeVisible(); browserChecks++;
  const d3 = await call(`erp/documents/${made.id}`);
  check(d3.document.total === 4106400 && d3.document.cgst === 313200, 'GST and total as previewed');
  // The task is done only now: before the issue the database refused it (checked in test_erp_invoice.py); now it is accepted.
  const moved = await app.inject({ url: `/api/v0/tasks/${made.taskId}/move`, method: 'POST', headers: { 'cf-access-authenticated-user-email': emails.finance }, payload: { status: 'done' } }); apiChecks++;
  check(moved.statusCode === 200 && moved.json().status === 'done', `the invoice task is done once the invoice is issued: ${moved.body.slice(0, 200)}`);
  // 3. Record the client's payment: FIN-LIVE's bank credit (after 2% TDS) is offered and settles it.
  const worker = new Pool(JSON.parse(process.env.TEST_WORKER_CONFIG ?? process.env.TEST_API_CONFIG));
  if (process.env.TEST_WORKER_CONFIG) {
    const w = await worker.connect();
    try {
      await w.query('begin'); await w.query("select set_config('pulse.org_id',$1,true)", [process.env.TEST_ORG]);
      const credit = (d3.document.total - Math.round(d3.document.taxable * 0.02)) / 100;
      await w.query("insert into pulse_priv.finance_live_record(org_id,kind,key,scope,body,source,hash,confidence) values($1,'bank_line','synthetic-credit-1|dated','statement',$2,'{\"type\":\"statement\"}',$3,'high')",
        [process.env.TEST_ORG, { date: ist(), amount: credit, direction: 'in', counterparty: 'NORTHSTAR HOMES LLP', reference: 'NEFT SYNTH0003', category: 'Client receipts', kind: 'client', selected: true }, 'c'.repeat(64)]);
      // EST-1239: create due follow-up work on a synthetic clock, scoped to this disposable tenant.
      await w.query("select pulse.quote_followup_tick(now()+interval '3 days')");
      await w.query('commit');
    } finally { w.release(); }
    await go(f, `/erp/documents/${made.id}`);
    // An approved invoice's next step is sending it; recording a payment waits in the "…" menu until then.
    await f.getByRole('button', { name: 'More actions' }).click();
    await f.getByRole('menuitem', { name: 'Record payment' }).click();
    const payment = f.getByRole('dialog', { name: 'Record a payment' });
    await payment.getByRole('button', { name: 'Use' }).first().click();
    if (shots) await f.screenshot({ path: `${shots}/04-record-payment-bank-match-1440-light.png` });
    const paid = f.waitForResponse((r) => r.url().endsWith('/payments') && r.request().method() === 'POST');
    await payment.getByRole('button', { name: /^Record ₹/ }).click(); await paid;
    await expect(f.locator('[data-tone="success"]', { hasText: /^Paid$/ }).first()).toBeVisible(); browserChecks++;
    check((await call(`erp/documents/${made.id}`)).document.status === 'paid', 'the bank credit with 2% TDS settles the invoice');
  }
  await worker.end();
  // EST-1239 (Billing Blueprint): the sent quotation shows its follow-up at the company's 09:00, two days on; "Log reply"
  // links to its task and back; opens the kit Drawer; a refused close keeps the note; Call again later keeps it waiting.
  await go(page, `/erp/documents/${q}`);
  const fu = page.getByRole('region', { name: 'Follow-up' });
  await expect(fu.getByText('Waiting for a reply')).toBeVisible({ timeout: 20000 }); browserChecks++;
  await expect(fu.getByText(/Next follow-up .*09:00/i)).toBeVisible(); browserChecks++;
  if (process.env.TEST_WORKER_CONFIG) {
    // A client-side Link finishes navigation before QuoteFollowUp's own fetch finishes.
    // Observe that fetch before clicking, then check the loaded card with the original assertions.
    const followUpResponse = () => {
      const pending = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v0/quotes/${q}/follow-up` && r.request().method() === 'GET');
      pending.catch(() => null); // Navigation failures still report normally while this waiter winds down.
      return pending;
    };
    const followUpReady = async (response, region) => {
      const r = await response;
      check(r.status() === 200, 'the linked follow-up loaded successfully');
      const saved = await r.json();
      check(saved.documentId === q && saved.state === 'scheduled' && !!saved.nextDueAt, 'the linked card received the scheduled quotation follow-up');
      await expect(region).toBeVisible();
      await expect(region).not.toHaveAttribute('aria-busy', 'true', { timeout: 20000 });
    };
    const taskLoaded = followUpResponse();
    await fu.getByRole('link', { name: 'Open the follow-up task', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/tasks/[0-9a-f-]+$`)); browserChecks++;
    const taskFollowUp = page.getByRole('region', { name: 'Follow-up' });
    await followUpReady(taskLoaded, taskFollowUp);
    await expect(taskFollowUp.getByText(/Next follow-up .*09:00/i)).toBeVisible(); browserChecks++;
    await expect(taskFollowUp.getByText("Finishing this task alone keeps the next follow-up; log the customer's reply instead.")).toBeVisible(); browserChecks++;
    const quotationLoaded = followUpResponse();
    await taskFollowUp.getByRole('link', { name: 'Open the quotation', exact: true }).click();
    await expect(page).toHaveURL(`${base}/erp/documents/${q}`); browserChecks++;
    await followUpReady(quotationLoaded, fu);
    await expect(fu.getByText(/Next follow-up .*09:00/i)).toBeVisible(); browserChecks++;
  }
  // Billing's one next step is the only "Log reply": the card in its slot keeps the task link but hides its own button.
  const reply = page.getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Log reply', exact: true });
  await expect(fu.getByRole('button', { name: 'Log reply' })).toHaveCount(0); browserChecks++;
  await reply.click();
  const dlg = page.getByRole('dialog', { name: 'Log reply' });
  await expect(dlg).toBeVisible(); browserChecks++;
  await dlg.getByRole('textbox', { name: 'Note (optional)' }).fill('Synthetic: call back Monday');
  await dlg.getByRole('radio', { name: 'Close it' }).check();
  await dlg.getByRole('button', { name: 'Close the follow-up' }).click();
  await expect(dlg.getByRole('alert')).toHaveText('Choose how it ended'); browserChecks++;
  await expect(dlg.getByRole('textbox', { name: 'Note (optional)' })).toHaveValue('Synthetic: call back Monday'); browserChecks++;
  await dlg.getByRole('radio', { name: 'Call again later' }).check();
  await dlg.getByRole('button', { name: 'Move the follow-up' }).click();
  await expect(dlg).toBeHidden({ timeout: 15000 }); browserChecks++;
  await expect(fu.getByText('Waiting for a reply')).toBeVisible(); browserChecks++;
  if (shots) for (const theme of ['light', 'dark']) {  // EST-1239 for UI Guard: the card and the Log reply sheet at 390 px
    const c = await context('founder', 390, theme); const p = await c.newPage();
    await go(p, `/erp/documents/${q}`); const card = p.getByRole('region', { name: 'Follow-up' });
    await expect(card.getByText('Waiting for a reply')).toBeVisible({ timeout: 20000 }); await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: `${shots}/15-quote-followup-card-390-${theme}.png` });
    await p.getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Log reply', exact: true }).click(); await expect(p.getByRole('dialog', { name: 'Log reply' })).toBeVisible(); await p.waitForTimeout(500);
    await p.screenshot({ path: `${shots}/16-quote-followup-log-reply-390-${theme}.png` }); await c.close();
  }
  // 4. A client accepts through the signed-out link while the salesperson is typing a reply.
  await reply.click();
  const refusedNote = 'Synthetic: reply entered before the client accepted';
  await dlg.getByRole('textbox', { name: 'Note (optional)' }).fill(refusedNote);
  const out = await context(null); const o = await out.newPage();
  await o.goto(`${base}/accept/${token}`, { waitUntil: 'load' });
  await expect(o.getByRole('heading', { name: `Quotation ${qn}` })).toBeVisible(); browserChecks++;
  await expect(o.locator('canvas[data-pdf-page="1"]')).toBeVisible({ timeout: 30000 }); browserChecks++;
  if (shots) await o.screenshot({ path: `${shots}/11-client-acceptance-link-1440-light.png` });
  await o.getByRole('textbox', { name: 'Your full name (your signature)' }).fill('Ravi Menon');
  await o.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(o.getByText('Your answer (accepted) is recorded')).toBeVisible(); browserChecks++;
  check((await call(`erp/documents/${q}`)).document.status === 'accepted', 'the quotation is accepted');
  const refused = page.waitForResponse((r) => r.url().endsWith(`/quotes/${q}/follow-up`) && r.request().method() === 'POST');
  await dlg.getByRole('button', { name: 'Save reply', exact: true }).click();
  const refusal = await refused;
  check(!refusal.ok(), 'the server rejects a reply after the client accepted');
  await expect(dlg.getByRole('alert')).toHaveText('This follow-up is closed'); browserChecks++;
  await expect(dlg.getByRole('textbox', { name: 'Note (optional)' })).toHaveValue(refusedNote); browserChecks++;
  await expect(page.getByText('Reply logged', { exact: true })).toHaveCount(0); browserChecks++;
  await go(page, `/erp/documents/${q}`);
  await expect(page.getByRole('region', { name: 'Follow-up' }).getByText('No more follow-ups: the client accepted it.')).toBeVisible({ timeout: 20000 }); browserChecks++;
  await out.close();
  // Billing: the accepted quotation's one next step makes the proforma; making it again (a retry, a second tap) opens
  // the draft already made instead of a second one (EST-1237).
  await go(page, `/erp/documents/${q}`);
  await expect(page.getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Make proforma' })).toBeVisible(); browserChecks++;
  const pf = await call('erp/documents', { docType: 'proforma', sourceId: q });
  const pfAgain = await call('erp/documents', { docType: 'proforma', sourceId: q });
  check(!pf.existing && pfAgain.existing && pfAgain.id === pf.id, 'a retried conversion opens the proforma already made');
  await go(page, `/erp/documents/${q}`);
  await expect(page.getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Open the proforma' })).toBeVisible(); browserChecks++;
  // 5. A member has no ERP: no rail entry, and the page says why.
  const mem = await context('member'); const mp = await mem.newPage();
  await mp.goto(base + '/erp', { waitUntil: 'load' });
  await expect(mp.locator('#main-content').getByText('ERP is for leadership, Finance and the Accountant').first()).toBeVisible(); browserChecks++;
  check(await mp.locator('nav a[href="/erp"]').count() === 0, 'members have no ERP in the rail');
  check(await f.locator('a[href="/erp"]').count() > 0, 'the Finance role has ERP in the rail');
  await mem.close();
  // 6. The template editor redraws the real PDF on every change.
  await go(page, '/erp/templates');
  await expect(page.locator('canvas[data-pdf-page="1"]').first()).toBeVisible({ timeout: 30000 }); browserChecks++;
  const tpls = await call('erp/templates');
  await go(page, `/erp/templates/${tpls.templates.find((x) => x.name === 'Bold band').id}`);
  await drawn(page, BOLD_BAND);
  await page.getByRole('button', { name: '#0f766e' }).click();
  await drawn(page, BOLD_BAND);
  await page.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible(); browserChecks++;
  // A second client package, sold a few weeks ago: its first milestone is late and the second is due, for the overview.
  await call('erp/engagements', { projectId: E.towers, packageId: pkg, startsOn: ist(-25) });
  const later = (await call(`erp/projects/${E.riverside}`)).engagements.find((e) => e.id === eng).milestones[3];
  // 7. Screens: both widths and themes.
  if (shots) {
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      const c = await context('founder', width, theme); const p = await c.newPage();
      const shot = async (name) => { await p.screenshot({ path: `${shots}/${name}-${width}-${theme}.png` }); };
      await go(p, '/erp'); await shot('01-overview');
      await go(p, `/erp/documents/${m2}`); await expect(p.locator('canvas[data-pdf-page="1"]')).toBeVisible({ timeout: 30000 }); await shot('03-issued-invoice-part-paid');
      await go(p, `/erp/documents/${q}`); await expect(p.locator('canvas[data-pdf-page="1"]')).toBeVisible({ timeout: 30000 }); await shot('05-quotation-accepted');
      await go(p, `/erp/new?project=${E.towers}`); await p.getByText('From Zoho invoice').first().waitFor({ timeout: 20000 }).catch(() => {}); await shot('06-new-from-project');
      await go(p, '/erp/documents'); await shot('07-documents');
      await go(p, '/erp/templates'); await p.locator('canvas[data-pdf-page="1"]').first().waitFor({ timeout: 30000 }); await shot('08-templates');
      await go(p, `/erp/templates/${tpls.templates.find((x) => x.name === 'Bold band').id}`); await drawn(p, BOLD_BAND); await shot('09-template-editor');
      await go(p, '/erp/catalog'); await shot('10-catalog');
      await go(p, `/erp/catalog/${pkg}`); await shot('12-package-parts-versions');
      await go(p, '/erp/inventory'); await shot('13-inventory');
      await go(p, '/erp/settings'); await shot('14-settings-exports');
      await go(p, '/erp/log'); await shot('15-log');
      const draft = (await call(`erp/milestones/${later.id}/invoice`, {})).id;   // milestone 4, with its package line
      await go(p, `/erp/documents/${draft}`); await drawn(p); await shot('02-invoice-editor-live-preview');
      await call(`erp/documents/${draft}/delete`, {});
      await c.close();
    }
  }
  const receipt = JSON.stringify({ apiChecks, browserChecks, numbers: [n1, n2, n3, cnNo, qn] });
  await writeFile(process.env.PULSE_ERP_REPORT, receipt); console.log(receipt);
} catch (e) {
  for (const c of browser?.contexts() ?? []) for (const p of c.pages()) console.error('PAGE', p.url().replace(base, ''), (await p.locator('main').innerText().catch(() => '')).slice(0, 800));
  throw e;
} finally { await browser?.close(); server.kill(); await app.close(); await pool.end(); }
