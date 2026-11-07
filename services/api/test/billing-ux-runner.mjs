// UX-BILLING (owner, 5 Nov 2026: "there is no UX/UI improvement in anything: billing, finance, work"): every Billing
// screen through the real API and the built web app, at 390 and 1440 px, light and dark, held to the Work → My day
// standard: no sideways scroll on a phone, one obvious main action where there is something to do, a heading, a visible
// keyboard focus, empty states that say what to do (tests/core/test_billing_ux.py). Synthetic company, people, clients,
// products, serials and figures only.
//   PULSE_BILLING_UX_SHOTS=<dir>   writes every screen (<name>-<width>-<theme>.png)
//   PULSE_BILLING_UX_CHECKS=0      screenshots only (the "before" pass of a redesign)
//   PULSE_BILLING_UX_DEV=1         `next dev` (NEXT_DIST_DIR) instead of `next start`
//   PULSE_BILLING_UX_HOLD=<file>   keeps the API and the web app up: writes <file>.json (the address and ids), takes the
//                                  screens again whenever <file>.go appears ({"only":[..],"widths":[..],"themes":[..],"dir":".."}),
//                                  and stops when <file>.stop appears (a lane's iteration loop; never in CI)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool); let apiChecks = 0, browserChecks = 0;
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS);
const shots = process.env.PULSE_BILLING_UX_SHOTS, checks = process.env.PULSE_BILLING_UX_CHECKS !== '0', hold = process.env.PULSE_BILLING_UX_HOLD;
const call = async (path, body, role = 'founder', expected = 200) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${role} ${path}: ${r.body.slice(0, 400)}`);
  return r.headers['content-type']?.includes('json') ? r.json() : r.rawPayload;
};
const ist = (days = 0) => new Date(Date.now() + 5.5 * 36e5 + days * 864e5).toISOString().slice(0, 10);
const check = (condition, msg) => { browserChecks++; assert.ok(condition, msg); };
const strip = (lines) => lines.map(({ id: _x, taxable: _a, cgst: _b, sgst: _c, igst: _d, total: _e, ...l }) => l);
const save = async (id, patch = {}, role = 'founder') => { const d = await call(`erp/documents/${id}`, undefined, role); await call(`erp/documents/${id}`, { ...d.document, lines: strip(d.lines), ...patch }, role); return d; };
const issue = async (id, role = 'founder') => (await call(`erp/documents/${id}/issue`, {}, role)).number;

// ------------------------------------------------------------------------------- a synthetic company's billing
await call('erp/settings', { company: { legalName: 'Synthetic Studio LLP', tradeName: 'Synthetic Studio', gstin: '27AAXFV2138F1ZR', address: ['Unit 7, Synthetic Business Park', 'Pune 411045, Maharashtra'],
  email: 'billing@synthetic.example', phone: '+91 90000 00000' }, dueDays: 15, roundTotal: true, inventoryEnabled: true, quoteApproval: true });
const item = async (body) => (await call('erp/items', { gstRate: 18, status: 'active', unit: 'nos', ...body })).id;
const film = await item({ kind: 'service', name: 'Brand film', sac: '999612', unit: 'video', price: 2400000, cost: 1280000 });
const ads = await item({ kind: 'service', name: 'Meta ads management', sac: '998361', unit: 'month', price: 1200000, cost: 480000 });
await item({ kind: 'service', name: 'Installation', sac: '998719', price: 150000 });
await item({ kind: 'service', name: 'Drone shoot (half day)', sac: '999612', price: 900000, status: 'draft' });
const brochure = await item({ kind: 'consumable', name: 'Site brochure (printed)', sac: '4911', price: 4500, cost: 2200, gstRate: 12, trackStock: true, reorderLevel: 100 });
await call(`erp/items/${brochure}/stock`, { kind: 'in', qty: 500, note: 'Synthetic print run' });
await call(`erp/items/${brochure}/stock`, { kind: 'out', qty: 430, note: 'Synthetic site launch' });
const inverter = await item({ kind: 'product', name: 'Synthetic Inverter 5 kVA', code: 'SI-5', sac: '850440', price: 4500000, trackStock: true, serialised: true, reorderLevel: 2, warrantyMonths: 24,
  warrantyOptions: [{ months: 12, price: 500000 }, { months: 24, price: 900000 }] });
await call(`erp/items/${inverter}/stock`, { kind: 'in', serials: ['SYN-SI5-001', 'SYN-SI5-002', 'SYN-SI5-003', 'SYN-SI5-004'], note: 'Synthetic supplier' });
const pkg = await item({ kind: 'package', name: 'Launch package, 4 months', sac: '998361', unit: 'package', price: 12000000, cost: 7800000, status: 'draft',
  description: 'Strategy, films, ads and reports for a launch', milestones: [1, 2, 3, 4].map((n) => ({ label: `Month ${n}`, percent: 25, offsetDays: 30 * (n - 1) })) });
await call(`erp/items/${pkg}/parts`, { parts: [
  { label: 'Research and positioning', quantity: 1, price: 1000000, cost: 70000 },
  { label: 'Brand films', itemId: film, quantity: 3, unit: 'video', price: 7200000, cost: 3840000 },
  { label: 'Meta ads management', itemId: ads, quantity: 4, unit: 'month', price: 4800000, cost: 1920000 },
] });
await call(`erp/items/${pkg}`, { name: 'Launch package, 4 months', price: 12000000, cost: 7800000, gstRate: 18, sac: '998361', unit: 'package', status: 'active',
  description: 'Strategy, films, ads and reports for a launch', milestones: [1, 2, 3, 4].map((n) => ({ label: `Month ${n}`, percent: 25, offsetDays: 30 * (n - 1) })) });
// The client's billing details, kept for every document.
await call(`erp/parties/${E.north}`, { name: 'Northstar Homes LLP', gstin: '27AABCS5678K1ZS', address: ['Office 4, Synthetic Plaza, Baner Road', 'Pune 411045'], contactPersonId: E.asha, contactName: 'Asha Kireteso', email: 'accounts@northstar.example', phone: '+91 90000 00001' });

// Documents in every state, oldest first (numbers follow the dates).
const line = (id, name, qty, rate, extra = {}) => ({ itemId: id, description: name, details: '', sac: '998361', unit: 'nos', qty, rate, discount: 0, discountPercent: null, gstRate: 18, ...extra });
const eng = (await call('erp/engagements', { projectId: E.riverside, packageId: pkg, startsOn: ist(-57) })).id;
const ms = (await call(`erp/projects/${E.riverside}`)).engagements.find((e) => e.id === eng).milestones;
const paid = (await call(`erp/milestones/${ms[0].id}/invoice`, {})).id;
await save(paid, { issueDate: ist(-56), dueDate: ist(-41) }); await issue(paid);
await call(`erp/documents/${paid}/payments`, { amount: 3540000, receivedOn: ist(-45), method: 'bank', reference: 'UTR SYNTH0001' });
const overdue = (await call('erp/documents', { docType: 'invoice', clientId: E.lake })).id;
await save(overdue, { issueDate: ist(-40), dueDate: ist(-25), lines: [line(film, 'Brand film', 1, 2400000, { sac: '999612', unit: 'video' })] }); await issue(overdue);
await call(`erp/documents/${overdue}/mark`, { action: 'sent' });
const part = (await call(`erp/milestones/${ms[1].id}/invoice`, {})).id;
await save(part, { issueDate: ist(-27), dueDate: ist(3) }); await issue(part);
await call(`erp/documents/${part}/mark`, { action: 'sent' });
await call(`erp/documents/${part}/payments`, { amount: 2000000, receivedOn: ist(-10), method: 'upi', reference: 'UPI SYNTH0002' });
const cn = (await call('erp/documents', { docType: 'credit_note', againstId: part })).id;
await save(cn, { issueDate: ist(-9), lines: [{ description: 'Goodwill credit: one film re-shoot', sac: '998361', qty: 1, rate: 200000, gstRate: 18 }] }); await issue(cn);
await call('erp/engagements', { projectId: E.towers, packageId: pkg, startsOn: ist(-25) });
// An approved quotation waiting to be sent; a revised one (R2); a proforma from it.
const toSend = (await call('erp/documents', { docType: 'quotation', clientId: E.north })).id;
await save(toSend, { lines: [line(pkg, 'Launch package, 4 months', 1, 12000000)] }); await issue(toSend);
const revised = (await call('erp/documents', { docType: 'quotation', contactPersonId: E.ravi })).id;
await save(revised, { lines: [line(ads, 'Meta ads management', 3, 1200000, { unit: 'month' })] }); await issue(revised);
await call(`erp/documents/${revised}/mark`, { action: 'sent' });
await call(`erp/documents/${revised}/revise`, { reason: 'Synthetic: the client asked for six months' });
await save(revised, { lines: [line(ads, 'Meta ads management', 6, 1150000, { unit: 'month' })] }); await issue(revised);
const proforma = (await call('erp/documents', { docType: 'proforma', sourceId: toSend })).id;
// A quotation the salesperson sent to the owner for approval: a product with a warranty extension on its line.
const asked = (await call('erp/documents', { docType: 'quotation', contactPersonId: E.asohiv }, 'finance')).id;
await save(asked, { lines: [line(inverter, 'Synthetic Inverter 5 kVA', 2, 4500000, { sac: '850440' }),
  line(null, 'Extended warranty +2 years: Synthetic Inverter 5 kVA', 2, 900000, { sac: null, parentIndex: 0, warrantyMonths: 24 }), line(null, 'Installation', 1, 150000, { sac: '998719' })] }, 'finance');
await call(`erp/documents/${asked}/approval`, { to: E.founder, note: 'Synthetic: the customer wants it today' }, 'finance');
// An invoice from the approved quotation, waiting for its serial numbers; a blank quotation, just started.
const fromQuote = (await call('erp/documents', { docType: 'quotation', contactPersonId: E.asohiv })).id;
await save(fromQuote, { lines: [line(inverter, 'Synthetic Inverter 5 kVA', 1, 4500000, { sac: '850440' })] }); await issue(fromQuote);
const serialInvoice = (await call('erp/documents', { docType: 'invoice', sourceId: fromQuote })).id;
const blank = (await call('erp/documents', { docType: 'quotation' })).id;
const ids = { paid, overdue, part, cn, toSend, revised, proforma, asked, serialInvoice, blank, inverter, pkg, brochure, film };
const template = (await call('erp/templates')).templates.find((t) => !t.archived)?.id;

// ------------------------------------------------------------------------------------------------ the screens
// Each: where it is, who looks, what it waits for, whether it has a main action (data-primary), and an optional step.
const SCREENS = [
  { name: '01-home', path: '/erp', primary: true },
  { name: '02-documents', path: '/erp/documents', primary: true },
  { name: '03-documents-empty-search', path: '/erp/documents?q=zzqx', primary: true, empty: true },
  { name: '04-new-quotation', path: '/erp/new?type=quotation', primary: true },
  { name: '05-blank-quotation', path: `/erp/documents/${blank}`, primary: true },
  { name: '06-prepared-for', path: `/erp/documents/${blank}`, step: async (p) => { await p.getByRole('button', { name: /^Client: not chosen/ }).first().click(); await p.getByRole('dialog').first().waitFor(); await p.waitForTimeout(400); }, dialog: true },
  { name: '07-approve-quotation', path: `/erp/documents/${asked}`, primary: true },
  { name: '08-quotation-to-send', path: `/erp/documents/${toSend}`, primary: true, pdf: true },
  { name: '09-quotation-revised', path: `/erp/documents/${revised}`, primary: true, pdf: true },
  { name: '10-proforma-draft', path: `/erp/documents/${proforma}`, primary: true },
  { name: '11-invoice-needs-serial', path: `/erp/documents/${serialInvoice}`, primary: true },
  { name: '12-invoice-overdue', path: `/erp/documents/${overdue}`, primary: true, pdf: true },
  { name: '13-invoice-part-paid', path: `/erp/documents/${part}`, primary: true, pdf: true },
  { name: '14-record-payment', path: `/erp/documents/${part}`, step: async (p) => { await p.getByRole('button', { name: /^Record (a )?payment/ }).last().click(); await p.getByRole('dialog').first().waitFor(); await p.waitForTimeout(400); }, dialog: true },
  { name: '15-invoice-paid', path: `/erp/documents/${paid}`, pdf: true },
  { name: '16-catalogue', path: '/erp/catalog', primary: true },
  { name: '17-catalogue-product', path: `/erp/catalog/${inverter}`, primary: true },
  { name: '18-catalogue-package', path: `/erp/catalog/${pkg}`, primary: true },
  { name: '19-stock', path: '/erp/inventory', primary: true },
  { name: '20-templates', path: '/erp/templates', primary: true },
  // Nothing changed yet: no main button (a grey "Saved" is not an action); after a change, Save is the one main action.
  { name: '21-template-editor', path: `/erp/templates/${template}` },
  { name: '22-settings', path: '/erp/settings' },
  { name: '22b-settings-changed', path: '/erp/settings', primary: true, step: async (p) => { await p.getByRole('switch', { name: /Round totals to the rupee/ }).click(); await p.waitForTimeout(200); } },
  { name: '23-log', path: '/erp/log' },
  { name: '24-catalogue-empty-view', path: '/erp/catalog?view=archived', primary: true, empty: true },
];
// UX-BILLING (review): the same screens through other eyes. Finance writes but does not approve (its own quotation waits
// for the owner: the main action reminds them); a member has no Billing and is told so, with no main action.
const ROLE_SCREENS = [
  { role: 'finance', name: 'f01-home', path: '/erp', primary: true },
  { role: 'finance', name: 'f02-documents', path: '/erp/documents', primary: true },
  { role: 'finance', name: 'f07-waiting-for-approval', path: `/erp/documents/${asked}`, primary: true, text: /Remind|approval/ },
  { role: 'member', name: 'm01-no-billing', path: '/erp', none: true },
];

const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const dev = process.env.PULSE_BILLING_UX_DEV === '1';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
  env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: dev ? 'development' : 'production', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next' }, stdio: dev ? ['ignore', 'ignore', 'inherit'] : 'ignore' });
let browser; const failures = [];
const ready = async (page) => {
  await page.waitForFunction(() => document.querySelector('main h1,main h2') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: dev ? 180000 : 60000 });
  await page.waitForTimeout(350);
};

/** Text that is hard to read: WCAG contrast below 4.5:1 (3:1 for large text) against the nearest painted background. */
const lowContrast = (p) => p.evaluate(() => {
  const rgb = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bg = (e) => { for (let x = e; x; x = x.parentElement) { const st = getComputedStyle(x); const c = rgb(st.backgroundColor); if (c && c.a > 0.5 && st.backgroundImage === 'none') return c; } return rgb(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255 }; };
  const bad = [];
  for (const e of document.querySelectorAll('main :is(h1,h2,h3,p,b,strong,small,span,a,button,label,dt,dd,li)')) {
    const text = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (!text || e.closest('[disabled],[aria-disabled="true"],[inert],canvas,svg,[aria-hidden="true"]')) continue;
    const st = getComputedStyle(e), r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || Number(st.opacity) < 0.95) continue;
    const fg = rgb(st.color); if (!fg || fg.a < 0.5) continue;
    const a = lum(fg), b = lum(bg(e)), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const size = parseFloat(st.fontSize), large = size >= 24 || (size >= 18.6 && Number(st.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) bad.push(`${text.slice(0, 40)} (${ratio.toFixed(2)})`);
  }
  return bad.slice(0, 6);
});

/** The standard every screen is held to (UX-BILLING), in light and dark: no sideways scroll; a heading; exactly one main
 *  action you can press where there is something to do, never a second, never a grey disabled one; readable contrast;
 *  the keyboard's focus is visible. */
async function standard(p, s, width, theme = 'light') {
  const where = `${s.name} at ${width} px, ${theme}`;
  check(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${where}: no sideways scroll`);
  if (s.dialog) return;
  check(await p.locator('main :is(h1, h2)').count() >= 1, `${where}: a heading`);
  const seen = await p.locator('[data-primary]').evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden'; })
    .map((e) => ({ off: !!e.disabled || e.getAttribute('aria-disabled') === 'true' || !!e.closest('fieldset[disabled]'), text: e.textContent.trim() })));
  const mains = seen.filter((x) => !x.off).length;
  check(!seen.some((x) => x.off), `${where}: no grey, disabled main action (${seen.filter((x) => x.off).map((x) => x.text).join(', ')})`);
  if (s.primary) check(mains === 1, `${where}: exactly one main action you can press (found ${mains}: ${seen.map((x) => x.text).join(', ')})`);
  else check(mains <= 1, `${where}: no more than one main action in view (found ${mains})`);
  if (s.none) check(mains === 0, `${where}: nothing to do, so no main action`);
  if (s.text) check(s.text.test(seen.map((x) => x.text).join(' ')), `${where}: the main action says ${s.text}`);
  if (s.empty) check(await p.locator('main [data-empty]').count() >= 1, `${where}: an empty state that says what to do`);
  const hard = await lowContrast(p);
  check(!hard.length, `${where}: text is readable (contrast): ${hard.join('; ')}`);
  // Tab into the page: whatever takes the focus shows it.
  await p.locator('main').first().evaluate((m) => { m.setAttribute('tabindex', '-1'); m.focus(); m.removeAttribute('tabindex'); });
  for (let i = 0; i < 3; i++) await p.keyboard.press('Tab');
  const ring = await p.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return 'none'; const st = getComputedStyle(e); return st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0 ? 'outline' : st.boxShadow !== 'none' ? 'shadow' : 'none'; });
  check(ring !== 'none', `${where}: the keyboard focus is visible`);
  await p.keyboard.press('Escape');
  await p.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
}

/** The whole page: on a computer the page scrolls inside its own box, so the window grows to its height for the picture. */
async function snap(p, path, full) {
  const size = p.viewportSize();
  const tall = full ? await p.evaluate(() => Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll('main, main *')].filter((e) => { const o = getComputedStyle(e).overflowY; return (o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 4; }).map((e) => e.scrollHeight + e.getBoundingClientRect().top + 24))) : size.height;
  if (tall > size.height) { await p.setViewportSize({ width: size.width, height: Math.min(tall, 6000) }); await p.waitForTimeout(250); }
  await p.screenshot({ path, fullPage: full });
  if (tall > size.height) await p.setViewportSize(size);
}

async function pass({ only, widths = [390, 1440], themes = ['light', 'dark'], dir = shots, standards = checks } = {}) {
  const list = only?.length ? SCREENS.filter((s) => only.some((o) => s.name.startsWith(o))) : SCREENS;
  for (const width of widths) for (const theme of themes) {
    const c = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails.founder } });
    await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private mode */ } }, theme);
    const p = await c.newPage();
    p.on('pageerror', (e) => console.error('PAGEERROR', p.url().replace(base, ''), e.message));
    for (const s of list) {
      try {
        await p.goto(base + s.path, { waitUntil: 'load' }); await ready(p);
        if (dev) await p.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
        if (s.pdf) await p.locator('canvas[data-pdf-page="1"]').first().waitFor({ timeout: 30000 }).catch(() => undefined);
        if (s.step) await s.step(p);
        if (standards) await standard(p, s, width, theme);
        if (dir) await snap(p, `${dir}/${s.name}-${width}-${theme}.png`, !s.dialog);
      } catch (e) {
        if (dir) await p.screenshot({ path: `${dir}/zz-failed-${s.name}-${width}-${theme}.png`, fullPage: true }).catch(() => undefined);
        console.error('FAILED AT', s.name, width, theme, String(e?.message ?? e).slice(0, 600));
        failures.push(`${s.name} ${width} ${theme}: ${String(e?.message ?? e).slice(0, 400)}`);
        if (!hold) throw e;
      }
    }
    await c.close();
  }
}

/** Finance and a member, at 390 and 1440, light and dark. */
async function rolePass() {
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) for (const role of ['finance', 'member']) {
    const c = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
    await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private mode */ } }, theme);
    const p = await c.newPage();
    for (const s of ROLE_SCREENS.filter((x) => x.role === role)) {
      await p.goto(base + s.path, { waitUntil: 'load' });
      await p.waitForFunction(() => document.querySelector('main h1,main h2') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: dev ? 180000 : 60000 }); await p.waitForTimeout(350);
      await standard(p, s, width, theme);
      if (shots) await snap(p, `${shots}/${s.name}-${width}-${theme}.png`, true);
    }
    await c.close();
  }
}

try {
  for (let i = 0; i < 800; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 799) throw Error('web did not start'); }
  browser = await chromium.launch({ headless: true });
  if (hold) {
    await writeFile(`${hold}.json`, JSON.stringify({ base, origin, ids, emails }, null, 1));
    for (;;) {
      if (existsSync(`${hold}.stop`)) break;
      if (existsSync(`${hold}.go`)) {
        const text = await readFile(`${hold}.go`, 'utf8'); await rm(`${hold}.go`, { force: true });
        const t0 = Date.now(); let error = null;
        try { browserChecks = 0; await pass(JSON.parse(text || '{}')); } catch (e) { error = String(e?.message ?? e); }
        await writeFile(`${hold}.done`, JSON.stringify({ seconds: Math.round((Date.now() - t0) / 1000), browserChecks, error, failures: failures.splice(0) }, null, 1));
      }
      await delay(1000);
    }
  } else {
    await pass();
    // The documents list, empty for a search, says what to do and offers the way out.
    if (checks) {
      const c = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails.founder } }); const p = await c.newPage();
      await p.goto(base + '/erp/documents?q=zzqx'); await ready(p);
      check(await p.locator('main [data-empty]').getByRole('button').or(p.locator('main [data-empty]').getByRole('link')).count() >= 1, 'an empty list offers a way on');
      await p.goto(base + '/erp/catalog?view=archived'); await ready(p);
      check(await p.locator('main [data-empty]').getByRole('button').count() >= 1, 'an empty catalogue view offers Show all');
      // An active item's Archive asks first: dismissing the question leaves it active.
      await p.goto(base + `/erp/catalog/${film}`); await ready(p);
      let question = '';
      p.once('dialog', (d) => { question = d.message(); void d.dismiss(); });
      await p.getByRole('button', { name: 'Archive', exact: true }).click(); await p.waitForTimeout(300);
      check(/Archive Brand film\?/.test(question), `Archive asks before taking an item off new documents (${question})`);
      check((await call(`erp/items/${film}`)).item.status === 'active', 'a dismissed Archive leaves the item active');
      await c.close();
      await rolePass();
      // Stock off: the Stock screen says so and how to turn it on (last: it changes the company's settings).
      const now = await call('erp/settings');
      await call('erp/settings', { company: now.company, dueDays: now.dueDays, roundTotal: now.roundTotal, quoteApproval: true, inventoryEnabled: false });
      const o = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails.founder } }); const op = await o.newPage();
      await op.goto(base + '/erp/inventory'); await ready(op);
      check(await op.locator('main [data-empty]').count() >= 1, 'stock off: an empty state that says what to do');
      check(await op.locator('main [data-empty]').getByRole('link').or(op.locator('main [data-empty]').getByRole('button')).count() >= 1, 'stock off: a way to turn it on');
      await o.close();
    }
  }
} finally {
  await browser?.close(); server.kill(); await app.close();
}

const receipt = JSON.stringify({ apiChecks, browserChecks });
if (process.env.PULSE_BILLING_UX_REPORT) await writeFile(process.env.PULSE_BILLING_UX_REPORT, receipt);
console.log(receipt);
await pool.end();
