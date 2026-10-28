import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
test.use({ extraHTTPHeaders: { 'Cf-Access-Authenticated-User-Email': 'admin@billing-one.example' }, reducedMotion: 'reduce' });
test.skip(!!process.env.PULSE_REAL_SMOKE, 'Synthetic API only');
const doc = '/api/v0/erp/documents/synthetic-review', url = '/erp/documents/synthetic-review';
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
async function reset(page: Page) { await expect(await page.request.post('/api/v0/erp/test-reset', { headers: { Origin: process.env.PLAYWRIGHT_TEST_BASE_URL! } })).toBeOK(); }
async function open(page: Page) {
  await reset(page);
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'New quotation', exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'More details' }).click();
  return page.getByRole('textbox', { name: 'PO / reference', exact: true });
}
for (const action of ['reload', 'pdf', 'docx', 'approve', 'failed older save', 'failed latest save']) {
  test(`pending autosave drains B before ${action}`, async ({ page }) => {
    const field = await open(page), held = gate(), received: string[] = [], committed: string[] = [];
    let settled = false;
    await page.route('**'+doc, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const po = route.request().postDataJSON().reference.po; received.push(po);
      if (po === 'A') { await held.promise; if (action === 'failed older save' || action === 'failed latest save') { settled = true; return route.fulfill({ status: 500, json: { error: 'Synthetic failure' } }); } }
      await route.fulfill({ response: await route.fetch() }); committed.push(po); settled = true;
    });
    await field.fill('A'); await expect.poll(() => received).toEqual(['A']);
    if (action === 'failed latest save') { held.resolve(); await expect(page.getByText('Not saved: Synthetic failure', { exact: true })).toBeVisible(); }
    await field.fill('B'); await page.waitForTimeout(1400);
    if (action !== 'failed latest save') { expect(received).toEqual(['A']); await expect(page.getByText('Saved', { exact: true })).toHaveCount(0); }
    let acted: string | undefined;
    // Chromium's download manager sends neither the Access header nor anything a route sees, so the proxy refuses the
    // file itself here (401, "canceled"; a session cookie counts only with public sign-in). The test owns the order: the
    // browser asks for the export only once B is committed, and that same URL then serves B (EST-1688).
    const exported = action === 'pdf' || action === 'docx' ? page.waitForEvent('download').then((download) => ({ download, after: committed.at(-1) })) : null;
    const finish = async (route: Route) => { expect(settled).toBe(true); expect(committed.at(-1)).toBe('B'); acted = (await (await page.request.get(doc)).json()).document.reference.po; return route.fulfill({ status: action === 'approve' ? 500 : 200, contentType: 'application/octet-stream', body: action === 'approve' ? '{"error":"Synthetic stop after flush"}' : 'synthetic export' }); };
    if (action === 'approve') { await page.route('**'+doc+'/issue', async (route) => { expect(route.request().postDataJSON().draft.reference.po).toBe('B'); return finish(route); }); page.on('dialog', (d) => d.accept()); await page.getByRole('button', { name: 'Approve', exact: true }).click(); }
    if (exported) { await page.getByRole('button', { name: 'More actions', exact: true }).click(); await page.getByRole('menuitem', { name: action === 'pdf' ? 'Download PDF' : 'Download Word file', exact: true }).click(); }
    if (['pdf', 'docx', 'approve'].includes(action)) expect(acted).toBeUndefined();
    held.resolve(); await expect.poll(() => committed.at(-1)).toBe('B');
    if (exported) {
      const { download, after } = await exported; expect(after).toBe('B'); expect(new URL(download.url()).pathname).toBe(`${doc}/${action}`);
      acted = (await (await page.request.get(download.url())).json()).po;
    }
    if (['pdf', 'docx', 'approve'].includes(action)) await expect.poll(() => acted).toBe('B');
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.reload(); await page.locator('summary').filter({ hasText: 'More details' }).click(); await expect(field).toHaveValue('B');
  });
}
for (const phase of ['failed', 'pending']) {
  test(`delete works with a ${phase} save without starting another save`, async ({ page }) => {
    const field = await open(page), held = gate(), deleting = gate();
    let saves = 0, deletes = 0, settled = false;
    await page.route('**'+doc, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      saves++;
      if (phase === 'pending') await held.promise;
      settled = true;
      await route.fulfill({ status: 500, json: { error: 'Synthetic failure' } });
    });
    await page.route('**'+doc+'/delete', async (route) => {
      expect(settled).toBe(true); deletes++;
      await deleting.promise;
      await route.fulfill({ json: { ok: true } });
    });
    try {
      await field.fill('Cannot save'); await expect.poll(() => saves).toBe(1);
      if (phase === 'failed') { await expect(page.getByText('Not saved: Synthetic failure', { exact: true })).toBeVisible(); await field.fill('Still unsaved'); }
      page.on('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Delete draft', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'PO / reference', exact: true, includeHidden: true }).locator('xpath=ancestor::*[@inert]')).toHaveCount(1);
      await page.waitForTimeout(1400); expect(saves).toBe(1);
      if (phase === 'pending') { expect(deletes).toBe(0); held.resolve(); }
      await expect.poll(() => deletes).toBe(1); expect(saves).toBe(1);
      deleting.resolve(); await expect(page).toHaveURL(/\/erp\/documents$/);
    } finally { held.resolve(); deleting.resolve(); }
  });
}
const switches = { validity: 'Valid until', project: 'Project or campaign', poNumber: "Client's PO number", costMargin: 'Cost and margin', deliverables: 'Deliverables per part', partSetup: 'Where it lives, setup, what it feeds', months: 'Months and milestone plan', discount: 'Discount column', addOns: 'Add-on chips' };
test('saved controls work both ways across companies and retain hidden data', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await reset(page);
  for (const on of [false, true]) {
    await page.goto('/erp/settings');
    for (const name of Object.values(switches)) await page.getByRole('switch', { name, exact: false }).setChecked(on);
    await expect(page.getByRole('switch', { name: 'Model number', exact: false })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Team per part', exact: false })).toBeDisabled();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
    await page.goto(url); await page.locator('summary').filter({ hasText: 'More details' }).click();
    for (const name of ['Valid until', 'Project', 'PO / reference', 'Milestone']) await expect(page.getByLabel(name, { exact: true })).toHaveCount(on ? 1 : 0);
    await expect(page.locator('button[title^="Add-on for"]')).toHaveCount(on ? 1 : 0);
    if (!on) { await page.getByRole('button', { name: 'Add a note for the customer', exact: true }).click(); await page.getByLabel('Note for the customer', { exact: true }).fill('Synthetic edit with hidden fields'); await expect(page.getByText('Saved', { exact: true })).toBeVisible(); }
    await page.getByRole('button', { name: 'Synthetic Review Package: details', exact: true }).click();
    await page.getByRole('button', { name: 'Ask for a different price', exact: true }).click();
    await expect(page.getByLabel('Or a discount %', { exact: true })).toHaveCount(on ? 1 : 0);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.goto('/erp/catalog'); await page.getByRole('button', { name: /^Synthetic Review Package(?: |$)/ }).click();
    await page.getByRole('button', { name: /^Synthetic Review Part(?: |$)/ }).click();
    await expect(page.getByRole('heading', { name: 'What it delivers', exact: true })).toHaveCount(on ? 1 : 0);
    await expect(page.getByRole('textbox', { name: 'Cost', exact: true })).toHaveCount(on ? 1 : 0);
    await expect(page.getByRole('textbox', { name: 'Deliverables, one per line', exact: true })).toHaveCount(on ? 1 : 0);
    await expect(page.getByLabel('Who sets it up', { exact: true })).toHaveCount(on ? 1 : 0);
    if (!on) {
      let saved: { parts: { quantity: number; cost: number; deliverables: string[]; setup: string; where: string; derives: string }[] } | undefined;
      await page.route('**/api/v0/erp/items/synthetic-review-item/parts', async (route) => { saved = route.request().postDataJSON(); return route.fulfill({ json: { ok: true } }); });
      await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).fill('2');
      await page.getByRole('button', { name: 'Save part', exact: true }).click();
      await expect.poll(() => saved?.parts[0]?.quantity).toBe(2);
      expect(saved!.parts[0]).toMatchObject({ cost: 20000, deliverables: ['Synthetic retained deliverable'], setup: 'Synthetic team', where: 'Synthetic folder', derives: 'Synthetic report' });
    } else await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.goto('/erp/catalog/synthetic-review-item'); await expect(page.getByRole('textbox', { name: 'Cost', exact: true })).toHaveCount(on ? 1 : 0);
    await expect(page.getByRole('region', { name: 'Billing plan', exact: true })).toHaveCount(on ? 1 : 0);
    const stored = await (await page.request.get(doc)).json(); expect(stored.document.reference.po).toBe('Synthetic PO'); expect(stored.document.validUntil).toBe('2026-11-18');
  }
  for (const [company, pack, kind] of [['one', 'Marketing & service agency', 'Service'], ['two', 'Dealer & installer', 'Product']]) {
    const ctx = await browser.newContext({ extraHTTPHeaders: { 'Cf-Access-Authenticated-User-Email': `admin@billing-${company}.example` }, reducedMotion: 'reduce' }), p = await ctx.newPage();
    await reset(p);
    await p.goto('/erp/settings'); await p.getByRole('button', { name: pack, exact: false }).click(); await p.getByRole('button', { name: 'Use this pack', exact: true }).click(); await p.getByRole('button', { name: 'Save settings', exact: true }).click(); await expect(p.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
    const setup = await (await p.request.get('/api/v0/erp/setup')).json(); expect(setup.pack).toBe(company === 'one' ? 'agency' : 'dealer'); expect(setup.fields.project).toBe(company === 'one');
    await p.goto(url); await p.locator('summary').filter({ hasText: 'More details' }).click(); await expect(p.getByLabel('Project', { exact: true })).toHaveCount(company === 'one' ? 1 : 0);
    await p.goto('/erp/catalog'); await expect(p.getByRole('radiogroup', { name: 'Show', exact: true })).toHaveAttribute('data-ready', '');
    await p.getByRole('button', { name: 'New item', exact: true }).click(); await expect(p.getByRole('button', { name: kind, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await p.goto('/erp/catalog'); await p.getByRole('button', { name: /^Synthetic Review Package(?: |$)/ }).click();
    await p.getByRole('button', { name: /^Synthetic Review Part(?: |$)/ }).click();
    await expect(p.getByRole('heading', { name: 'What it delivers', exact: true })).toHaveCount(company === 'one' ? 1 : 0);
    const out = process.env.PULSE_BILLING_SCREENSHOTS;
    if (company === 'two' && out) {
      await mkdir(out, { recursive: true });
      for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
        await p.setViewportSize({ width, height: 900 }); await p.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await expect.poll(() => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await p.screenshot({ path: join(out, `billing-dealer-part-${width}-${theme}.png`) });
      }
    }
    await ctx.close();
  }
  expect((await (await page.request.get('/api/v0/erp/setup')).json()).pack).toBe('agency');
});
test('composer setup fits both themes and widths', async ({ page }) => {
  await open(page);
  const out = process.env.PULSE_BILLING_SCREENSHOTS;
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (out) { await mkdir(out, { recursive: true }); await page.screenshot({ path: join(out, `billing-review-${width}-${theme}.png`) }); }
  }
});
