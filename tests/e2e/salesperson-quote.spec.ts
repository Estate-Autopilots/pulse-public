import { expect, test } from '@playwright/test';
import { join } from 'node:path';

test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'Synthetic quotation contract tests use the isolated server');
const id = '12500000-0000-4000-8000-000000000001';
const quote = { id, name: 'Synthetic Client', status: 'draft', validUntil: '2026-11-17',
  lines: [{ name: 'Synthetic design package', qty: 2, rate: 123456, gstRate: 18, total: 291356 }],
  taxable: 246912, tax: 44444, total: 291356, ownerApprovalNeeded: true, canOpenErp: false };
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': 'admin@northwind-on.example' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`Flagged read-only quotation at ${width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const methods: string[] = [];
    await page.route(`**/api/v0/quotes/${id}`, (r) => { methods.push(r.request().method()); return r.fulfill({ json: quote }); });
    await page.goto(`/quotes/${id}`);
    const view = page.getByRole('region', { name: 'Quotation', exact: true });
    await expect(view.getByText('Owner approval needed', { exact: true })).toBeVisible();
    await expect(view.getByText('Synthetic design package')).toBeVisible();
    await expect(view.getByText('₹1,234.56', { exact: true })).toBeVisible();
    await expect(view.getByText('₹2,469.12', { exact: true })).toBeVisible();
    await expect(view.getByText('₹444.44', { exact: true })).toBeVisible();
    await expect(view.getByText('₹2,913.56', { exact: true })).toHaveCount(2);
    await expect(view.getByText('18%', { exact: true })).toBeVisible();
    await expect(view.getByText('Valid until 17 Nov 2026', { exact: true }).last()).toBeVisible();
    await expect(view.getByRole('link', { name: 'Open in ERP' })).toHaveCount(0);
    await expect(view.locator('input, textarea, select')).toHaveCount(0);
    expect(methods).toEqual(['GET']);
    await page.evaluate((t) => document.documentElement.dataset.theme = t, theme);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth + 1)).toBe(true);
    await view.screenshot({ path: join(process.env.PAPERCLIP_SCRATCH_DIR ?? 'test-results', `quotation-${theme}-${width}.png`) });
  });
}

test('Unflagged quotation exposes only the permitted ERP link', async ({ page }) => {
  await page.route(`**/api/v0/quotes/${id}`, (r) => r.fulfill({ json: { ...quote, name: 'a lead received 18 Oct', ownerApprovalNeeded: false, canOpenErp: true } }));
  await page.goto(`/quotes/${id}`);
  await expect(page.getByRole('link', { name: 'Open in ERP' })).toHaveAttribute('href', `/erp/documents/${id}`);
  await expect(page.getByText('Owner approval needed', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Quotation', exact: true }).getByText('a lead received 18 Oct', { exact: true }).last()).toBeVisible();
});

test('404 uses the same private state for missing and another salesperson\'s quotation', async ({ page }) => {
  await page.route(`**/api/v0/quotes/${id}`, (r) => r.fulfill({ status: 404, json: { error: 'Private upstream detail', ...quote } }));
  await page.goto(`/quotes/${id}`);
  await expect(page.getByText("This quotation isn't yours or no longer exists.")).toBeVisible();
  for (const text of ['Synthetic Client', 'Private upstream detail', '₹2,913.56']) await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open in ERP' })).toHaveCount(0);
});

test('Loading, error retry, empty and offline states stay honest', async ({ page, context }) => {
  let answer!: () => void; const gate = new Promise<void>((resolve) => answer = resolve);
  let failing = true;
  await page.route(`**/api/v0/quotes/${id}`, async (r) => {
    if (failing) { await gate; await r.fulfill({ status: 500, json: { error: 'Private database error' } }); }
    else await r.fulfill({ json: { ...quote, lines: [] } });
  });
  await page.goto(`/quotes/${id}`);
  await expect(page.getByLabel('Loading quotation')).toBeVisible(); answer();
  await expect(page.getByText("Quotation couldn't load", { exact: true })).toBeVisible();
  await expect(page.getByText('Private database error')).toHaveCount(0);
  await context.setOffline(true); await expect(page.getByRole('button', { name: 'Try again' })).toBeDisabled();
  failing = false; await context.setOffline(false);
  await expect(page.getByText('No items yet', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText("You're offline. This quotation may have changed. Reconnect to refresh.")).toBeVisible();
  await expect(page.getByText('₹2,913.56', { exact: true })).toBeVisible();
});

for (const [variant, approval] of [[1, null], [2, null], [3, 'Approved by owner'], [4, null]] as const) {
  test(`Document attribution and approval gate: variant ${variant}`, async ({ page }) => {
    await page.goto(`/erp/documents/12500000-0000-4000-8000-00000000000${variant}`);
    const attribution = page.getByRole('region', { name: 'Quotation approval' });
    if (variant === 4) { await expect(attribution).toHaveCount(0); return; }
    await expect(attribution.getByText('Salesperson: Synthetic Salesperson · drafted by an agent key')).toBeVisible();
    if (approval) await expect(attribution.getByText(approval, { exact: true })).toBeVisible();
    else await expect(attribution.getByText('Owner approval needed', { exact: true })).toHaveCount(0);
    if (variant === 1) await expect(page.getByRole('button', { name: 'Only leadership can approve' })).toBeDisabled();
    if (variant === 2) await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  });
}

test('Leadership can approve a flagged quotation through the existing action', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': 'quote-leadership@example.test' });
  await page.goto(`/erp/documents/${id}`);
  await expect(page.getByText("Waiting for the owner's approval", { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Quotation approval' }).getByText('Owner approval needed', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve the new price', exact: true })).toBeEnabled();
});
