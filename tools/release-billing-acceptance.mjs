// Staging only, on request (EST-1964; tools/release_billing_acceptance.py issued the quotation): EST-1237's issued
// synthetic quotation in a real browser, as that pass's synthetic leadership issuer, at 1440 and 390 in light and dark.
// It shares (headless has no file share, so the PDF downloads), fails a share on purpose, converts the quotation once,
// approves the proforma and makes the tax-invoice draft; the synthetic `person` opens the same quotation. Private 0600
// screenshots and one receipt file, written even when a step fails: verdicts, the staging number and layout facts only.
import { chromium } from '../tests/e2e/node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';
import { overflowOf } from './release-overflow.mjs';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { origin, port, out, environment, quote } = input;
const result = { passed: false, step: null, checks: [], screenshots: [], nativeFileShare: null };
const quoteUrl = `${origin}/erp/documents/${quote.id}`;
const docPath = /^\/erp\/documents\/([0-9a-f-]{36})$/;
const sharedPdf = (u) => u.pathname === `/api/v0/erp/documents/${quote.id}/pdf` && !u.search; // not the page's ?inline=1 preview
const creating = (u) => u.pathname === '/api/v0/erp/documents';
const busyPrimary = () => [...document.querySelectorAll('section[aria-label="Summary"] button')].some((b) => b.textContent.trim() === 'Send on WhatsApp' && b.disabled);
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

// The release browser's routing (tools/release-browser.mjs): the public origin is served from this server's port.
async function context(width, theme, session) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 980 }, colorScheme: theme, acceptDownloads: true });
  await ctx.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v0/chats/events') { await route.abort(); return; }
    try {
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}`, headers: { ...route.request().headers(), host: new URL(origin).host },
        maxRedirects: 0, maxRetries: ['GET', 'HEAD'].includes(route.request().method()) ? 2 : 0, timeout: 50000 });
      await route.fulfill({ response });
    } catch { await route.abort().catch(() => {}); }
  });
  // Only "Open WhatsApp" would leave Pulse, and the pass never taps it; should anything try, it goes nowhere.
  await ctx.route(/^https:\/\/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\//, (route) => route.abort());
  await ctx.addCookies([{ name: 'pulse_session', value: session, domain: new URL(origin).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  await ctx.addInitScript((t) => {
    localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.notify.browser.asked', '1');
    window.__pulseCspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__pulseCspViolations.push(e.violatedDirective));
    // Headless Chromium on Linux cannot hand a file to another app. Were that to change, the check stays on the download path.
    const probe = new File(['%PDF'], 'probe.pdf', { type: 'application/pdf' });
    window.__nativeFileShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] });
    if (window.__nativeFileShare) Object.defineProperty(Navigator.prototype, 'canShare', { value: undefined, configurable: true });
  }, theme);
  return ctx;
}
function watch(page) {
  const seen = { errors: 0, marks: 0, creates: 0, writes: 0, dialogs: [] };
  page.on('pageerror', () => { seen.errors++; });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (r.method() !== 'POST' || !u.pathname.startsWith('/api/v0/erp/')) return;
    seen.writes++;
    if (u.pathname.endsWith('/mark')) seen.marks++;
    if (u.pathname === '/api/v0/erp/documents') seen.creates++;
  });
  return seen;
}
async function healthy(page, seen, label) {
  const csp = await page.evaluate(() => window.__pulseCspViolations.length);
  const overflow = await overflowOf(page);
  if (seen.errors || csp || overflow) throw Error(`${label}: ${seen.errors ? 'page error' : csp ? 'CSP violation' : 'overflow ' + JSON.stringify(overflow.wide.slice(0, 3))}`);
  return { pageErrors: 0, csp: 0, overflow: false };
}
async function shot(target, name, full = false) {
  const file = `${environment}-billing-acceptance-${name}.png`;
  await target.screenshot({ path: `${out}/${file}`, ...(full ? { fullPage: true } : {}) });
  fs.chmodSync(`${out}/${file}`, 0o600); result.screenshots.push(file);
  return file;
}
const read = (page, id) => page.evaluate(async (id) => { const r = await fetch('/api/v0/erp/documents/' + id, { cache: 'no-store' }); return r.ok ? r.json() : { status: r.status }; }, id);
const digits = (text) => text.replace(/\D/g, '');
async function step(name, run) { result.step = name; result.checks.push({ step: name, ...(await run()), passed: true }); }
async function openIssued(page, label) {
  const response = await page.goto(quoteUrl, { waitUntil: 'load' });
  if (response?.status() !== 200) throw Error(`${label}: HTTP ${response?.status()}`);
  const summary = page.getByRole('region', { name: 'Summary' });
  await summary.getByText(quote.number, { exact: true }).waitFor({ timeout: 20000 });
  return summary;
}
const menuOf = async (page, summary) => {
  await summary.getByRole('button', { name: 'More actions', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'More actions' }); await menu.waitFor();
  return menu;
};
async function closeMenu(page, menu) { await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' }); }

try {
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const ctx = await context(width, theme, input.issuer);
    try {
      const page = await ctx.newPage(); const seen = watch(page); const at = `${width}-${theme}`;
      // a. The issued quotation: number, buyer, the catalogue line, total, Issued and the one main button.
      await step(`quotation ${at}`, async () => {
        const summary = await openIssued(page, 'quotation');
        const api = await read(page, quote.id);
        const d = api.document, text = await summary.innerText();
        const total = digits(await summary.locator('[class*="headTotal"]').innerText());
        const facts = { number: true, buyer: text.includes(`Quotation · ${quote.buyer}`), issued: d.status === 'issued' && await page.locator('#main-content').getByText('Issued', { exact: true }).first().isVisible(),
          total: total === String(d.total % 100 ? d.total : d.total / 100), catalogueLine: api.lines.length === 1 && api.lines[0].itemId === quote.itemId && api.lines[0].qty === 1,
          primary: await summary.getByRole('button', { name: 'Send on WhatsApp', exact: true }).isEnabled() ? 'Send on WhatsApp' : null };
        if (!facts.buyer || !facts.issued || !facts.total || !facts.catalogueLine || !facts.primary) throw Error('quotation facts ' + JSON.stringify(facts));
        if (width > 600) await page.getByRole('region', { name: 'Filed copy' }).locator('canvas[data-pdf-page="1"]').waitFor({ timeout: 30000 });
        result.nativeFileShare = await page.evaluate(() => window.__nativeFileShare);
        return { ...facts, filedCopy: width > 600 ? 'beside' : 'Preview', ...(await healthy(page, seen, 'quotation')), screenshot: await shot(page, `quotation-${at}`, true) };
      });
      if (width === 390 && theme === 'light') {
        await step(`quotation menu ${at}`, async () => {
          const summary = page.getByRole('region', { name: 'Summary' }); const menu = await menuOf(page, summary);
          for (const name of ['Make proforma', 'Make tax invoice']) await menu.getByRole('menuitem', { name, exact: true }).waitFor();
          const screenshot = await shot(page, `quotation-menu-${at}`);
          await closeMenu(page, menu);
          return { items: ['Make proforma', 'Make tax invoice'], screenshot };
        });
        await step(`quotation preview ${at}`, async () => {
          await page.getByRole('region', { name: 'Summary' }).getByRole('button', { name: 'Preview', exact: true }).click();
          const drawer = page.getByRole('dialog', { name: `Quotation ${quote.number}` });
          await drawer.locator('canvas[data-pdf-page="1"]').waitFor({ timeout: 30000 }); await page.waitForTimeout(400);
          return { filedCopy: true, screenshot: await shot(page, `quotation-preview-${at}`) }; // the next step reloads the page
        });
        // e. A share whose PDF request fails says "Not shared" and marks nothing.
        await step(`not shared ${at}`, async () => {
          const summary = await openIssued(page, 'not shared'); const marks = seen.marks;
          const abort = (route) => route.abort();
          await page.route(sharedPdf, abort);
          await summary.getByRole('button', { name: 'Send on WhatsApp', exact: true }).click();
          await page.getByText('Not shared', { exact: true }).first().waitFor({ timeout: 15000 });
          const screenshot = await shot(page, `not-shared-${at}`);
          await page.unroute(sharedPdf, abort);
          await summary.getByRole('button', { name: 'Send on WhatsApp', exact: true }).waitFor();
          const panel = await page.getByRole('region', { name: 'Share it yourself' }).count();
          if (seen.marks !== marks || panel || (await read(page, quote.id)).document.status !== 'issued') throw Error('a failed share changed something');
          return { toast: 'Not shared', marks: 0, status: 'issued', primary: 'Send on WhatsApp', screenshot };
        });
        await page.goto(quoteUrl, { waitUntil: 'load' });
      }
      // c + d + g. While the PDF is on its way the main button is disabled; then the PDF downloads, the panel says so and
      // the main button becomes Mark sent. Nothing is marked: the quotation stays Issued. The panel is captured at rest.
      await step(`share ${at}`, async () => {
        const summary = page.getByRole('region', { name: 'Summary' }); const marks = seen.marks;
        const slow = async (route) => { await later(2500); await route.fallback(); };
        await page.route(sharedPdf, slow);
        const downloading = page.waitForEvent('download', { timeout: 30000 });
        await summary.getByRole('button', { name: 'Send on WhatsApp', exact: true }).click();
        const pending = await page.waitForFunction(busyPrimary, null, { timeout: 2000 }).then(() => true, () => false);
        const download = await downloading;
        await page.unroute(sharedPdf, slow);
        const file = fs.readFileSync(await download.path()); await download.delete();
        const panel = page.getByRole('region', { name: 'Share it yourself' });
        await panel.getByText('The PDF is downloaded.', { exact: true }).waitFor();
        const markSent = summary.getByRole('button', { name: 'Mark sent', exact: true }); await markSent.waitFor();
        const status = (await read(page, quote.id)).document.status;
        if (!pending || file.subarray(0, 4).toString('latin1') !== '%PDF' || seen.marks !== marks || status !== 'issued'
          || !await page.locator('#main-content').getByText('Issued', { exact: true }).first().isVisible()) throw Error('share ' + JSON.stringify({ pending, marks: seen.marks - marks, status }));
        await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur()); await page.waitForTimeout(600);
        const buttons = { preview: summary.getByRole('button', { name: 'Preview', exact: true }), markSent, openWhatsApp: panel.getByRole('button', { name: 'Open WhatsApp', exact: true }) };
        const look = (b) => b.evaluate((el) => { const s = getComputedStyle(el); return { background: s.backgroundColor, color: s.color, opacity: s.opacity, border: s.borderTopColor, disabled: el.disabled, hover: el.matches(':hover'), focus: el.matches(':focus-visible') }; });
        const rest = {};
        for (const [key, b] of Object.entries(buttons)) if (await b.count()) rest[key] = await look(b);
        const screenshots = [await shot(summary, `share-summary-${at}`), await shot(panel, `share-panel-${at}`), await shot(page, `share-${at}`, true)];
        // The same buttons under the pointer, to tell a hover fill from the style at rest.
        for (const [key, b] of Object.entries(buttons)) if (rest[key]) { await b.hover(); await page.waitForTimeout(300); rest[key].hoverBackground = await b.evaluate((el) => getComputedStyle(el).backgroundColor); }
        await page.mouse.move(0, 0);
        return { pending, pdf: { download: true, magic: true, bytes: file.length }, panel: 'The PDF is downloaded.', primary: 'Mark sent', status: 'issued', marks: 0, rest, ...(await healthy(page, seen, 'share')), screenshots };
      });
    } finally { await ctx.close(); }
  }
  // e. The synthetic `person` (no Billing role) on the same quotation: "Read only." without actions, or a clean refusal.
  for (const width of [1440, 390]) {
    const ctx = await context(width, 'light', input.person);
    try {
      const page = await ctx.newPage(); const seen = watch(page);
      await step(`read only ${width}-light`, async () => {
        const response = await page.goto(quoteUrl, { waitUntil: 'load' }); await page.waitForTimeout(1500);
        const api = await page.evaluate(async (id) => (await fetch('/api/v0/erp/documents/' + id, { cache: 'no-store' })).status, quote.id);
        const readOnly = await page.getByText('Read only.', { exact: true }).count() > 0;
        const actions = await page.getByRole('button', { name: /^(Send on WhatsApp|Mark sent|Make proforma|Make tax invoice|Record payment|Approve)$/ }).count();
        if (actions || seen.writes || !(readOnly || api === 403)) throw Error('read only ' + JSON.stringify({ api, readOnly, actions, writes: seen.writes }));
        return { pageStatus: response?.status() ?? null, apiStatus: api, shown: readOnly ? 'Read only.' : 'refused', redirected: new URL(page.url()).pathname !== `/erp/documents/${quote.id}`,
          actions: 0, writes: 0, ...(await healthy(page, seen, 'read only')), screenshot: await shot(page, `read-only-${width}-light`, true) };
      });
    } finally { await ctx.close(); }
  }
  // b, c, f on the phone: Make proforma once (the main button disabled while it answers), the same draft again as "Open the
  // proforma", the proforma approved in its editor, and its Make tax invoice.
  const ctx = await context(390, 'light', input.issuer);
  try {
    const page = await ctx.newPage(); const seen = watch(page); const at = '390-light';
    let approving = false;
    // The approval's confirm is the one question expected; leaving an untouched draft never needs one.
    page.on('dialog', (d) => { seen.dialogs.push(d.type()); void (d.type() === 'beforeunload' || (approving && d.type() === 'confirm' && d.message().startsWith('Approve this proforma invoice?')) ? d.accept() : d.dismiss()); });
    let proforma;
    await step(`make proforma ${at}`, async () => {
      const summary = await openIssued(page, 'make proforma');
      const slow = async (route) => { if (route.request().method() === 'POST') await later(2000); await route.fallback(); };
      await page.route(creating, slow);
      const menu = await menuOf(page, summary);
      await menu.getByRole('menuitem', { name: 'Make proforma', exact: true }).click();
      const pending = await page.waitForFunction(busyPrimary, null, { timeout: 1800 }).then(() => true, () => false);
      await page.waitForURL((u) => docPath.test(u.pathname) && u.pathname !== `/erp/documents/${quote.id}`, { timeout: 30000 });
      await page.unroute(creating, slow);
      proforma = docPath.exec(new URL(page.url()).pathname)[1];
      const { document: d, lines } = await read(page, proforma);
      const carried = { docType: d.docType === 'proforma', draft: d.status === 'draft', buyer: d.buyer?.name === quote.buyer, sourceLink: d.sourceId === quote.id,
        line: lines.length === 1 && lines[0].itemId === quote.itemId, qty: lines[0]?.qty === 1, gst: lines[0]?.gstRate === quote.gstRate };
      await page.getByRole('navigation', { name: 'Document chain' }).locator(`a[href="/erp/documents/${quote.id}"]`).waitFor();
      if (!pending || seen.creates !== 1 || Object.values(carried).some((v) => !v)) throw Error('make proforma ' + JSON.stringify({ pending, creates: seen.creates, carried }));
      return { pending, creates: 1, carried, chainLinksQuotation: true, ...(await healthy(page, seen, 'proforma draft')), screenshot: await shot(page, `proforma-draft-${at}`, true) };
    });
    await step(`open the proforma ${at}`, async () => {
      const summary = await openIssued(page, 'open the proforma'); const menu = await menuOf(page, summary);
      await menu.getByRole('menuitem', { name: 'Open the proforma', exact: true }).waitFor();
      if (await menu.getByRole('menuitem', { name: 'Make proforma', exact: true }).count()) throw Error('Make proforma offered twice');
      const screenshot = await shot(page, `quotation-menu-open-proforma-${at}`);
      await menu.getByRole('menuitem', { name: 'Open the proforma', exact: true }).click();
      await page.waitForURL((u) => u.pathname === `/erp/documents/${proforma}`, { timeout: 30000 });
      const drafts = await page.evaluate(async (id) => (await (await fetch('/api/v0/erp/documents?type=proforma', { cache: 'no-store' })).json()).documents.filter((d) => d.sourceId === id).length, quote.id);
      if (seen.creates !== 1 || drafts !== 1) throw Error('open the proforma ' + JSON.stringify({ creates: seen.creates, drafts }));
      return { label: 'Open the proforma', creates: 1, proformaDrafts: 1, sameDraft: true, screenshot };
    });
    // f. The proforma approved in its editor (a staging number), then its Make tax invoice.
    await step(`approve the proforma ${at}`, async () => {
      approving = true;
      await page.locator('button:visible').filter({ hasText: /^Approve$/ }).first().click();
      await page.getByText(/^Proforma Invoice \S+ approved$/).first().waitFor({ timeout: 30000 });
      approving = false;
      const summary = page.getByRole('region', { name: 'Summary' }); await summary.waitFor({ timeout: 30000 });
      const d = (await read(page, proforma)).document, q = (await read(page, quote.id)).document;
      if (d.status !== 'issued' || !d.number || q.status !== 'converted') throw Error('approve ' + JSON.stringify({ proforma: d.status, quotation: q.status }));
      return { number: d.number, status: 'issued', quotation: 'converted', ...(await healthy(page, seen, 'issued proforma')), screenshot: await shot(page, `proforma-issued-${at}`, true) };
    });
    await step(`make tax invoice ${at}`, async () => {
      const menu = await menuOf(page, page.getByRole('region', { name: 'Summary' }));
      await menu.getByRole('menuitem', { name: 'Make tax invoice', exact: true }).click();
      await page.waitForURL((u) => docPath.test(u.pathname) && u.pathname !== `/erp/documents/${proforma}`, { timeout: 30000 });
      const { document: d, lines } = await read(page, docPath.exec(new URL(page.url()).pathname)[1]);
      const carried = { docType: d.docType === 'invoice', draft: d.status === 'draft', buyer: d.buyer?.name === quote.buyer, sourceLink: d.sourceId === proforma,
        line: lines.length === 1 && lines[0].itemId === quote.itemId, qty: lines[0]?.qty === 1, gst: lines[0]?.gstRate === quote.gstRate };
      await page.getByRole('navigation', { name: 'Document chain' }).locator(`a[href="/erp/documents/${proforma}"]`).waitFor();
      if (Object.values(carried).some((v) => !v)) throw Error('tax invoice draft ' + JSON.stringify(carried));
      return { carried, chainLinksProforma: true, ...(await healthy(page, seen, 'tax invoice draft')), screenshot: await shot(page, `invoice-draft-${at}`, true) };
    });
    if (JSON.stringify(seen.dialogs.filter((t) => t !== 'beforeunload')) !== '["confirm"]') throw Error('unexpected dialogs ' + JSON.stringify(seen.dialogs));
  } finally { await ctx.close(); }
  result.passed = true; result.step = null;
} catch (error) {
  result.error = String(error instanceof Error ? error.message : error).split('\n')[0].slice(0, 300);
  process.exitCode = 1;
} finally {
  await browser.close();
  const file = `${out}/${environment}-billing-acceptance-browser.json`;
  fs.writeFileSync(file, JSON.stringify(result, null, 2)); fs.chmodSync(file, 0o600);
  console.log(JSON.stringify({ passed: result.passed, step: result.step, checks: result.checks.length }));
}
