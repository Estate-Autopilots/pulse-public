import { expect, test } from '@playwright/test';

// FINANCE-UI (10 Oct 2026) on the wholly synthetic finance fixture: five sections, an Overview that fits one window,
// a one-sentence brief with details in a drawer, tables that sort, filter, export and open a drawer, phone cards,
// queues with one action per row, and a CA desk that still shows an Accountant only the desk.
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'The finance fixtures are synthetic and served only by the isolated test server');

const leadership = { 'Cf-Access-Authenticated-User-Email': 'admin@estateautopilots.com' };
const wide = () => document.scrollingElement!.scrollWidth <= innerWidth + 1;

test('Overview: five sections, six tiles, four charts and a short brief; only the page scrolls', async ({ page }) => {
  await page.setExtraHTTPHeaders(leadership);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/finance');
  const sections = page.getByRole('navigation', { name: 'Finance sections' }).getByRole('link');
  // COMP-B (13 Oct 2026) added People cost between Cash and the CA desk; FIN-ENTRY added Entries; READY (23 Oct) puts the
  // Cash book first (an organisation with synced books, like this one, still opens on Overview).
  // UX-SIMPLE (28 Oct 2026): five sections in the row; Entries, People cost and the CA desk are in More.
  await expect(sections).toHaveText(['Cash book', 'Overview', 'Money in', 'Money out', 'Cash']);
  await page.getByRole('button', { name: 'More in Finance' }).click();
  await expect(page.getByRole('menu', { name: 'More in Finance' }).getByRole('menuitem')).toHaveText(['Entries', 'People cost', 'CA desk']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: 'Data sources' })).toBeVisible();
  for (const label of ['Revenue · Sep 2026', 'Collected · Sep 2025', 'Overdue', 'Costs · Jul 2026', 'Net burn a month', 'Cash in bank']) await expect(page.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByText('Statement needed', { exact: true })).toBeVisible();
  for (const name of ['Revenue vs costs', 'Collections ageing', 'Top clients', 'Cost categories', 'What the founders should know']) await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Revenue and costs by month' })).toBeVisible();
  // Each brief item is one sentence with one bold figure, a confidence chip and Details; no paragraphs on the page.
  const items = page.getByRole('list', { name: 'Finance brief' }).getByRole('article');
  const n = await items.count();
  expect(n).toBeGreaterThanOrEqual(5);
  expect(n).toBeLessThanOrEqual(7);
  for (let i = 0; i < n; i++) {
    await expect(items.nth(i).locator('b')).toHaveCount(1);
    await expect(items.nth(i).getByText(/confidence$/)).toBeVisible();
    await expect(items.nth(i).getByRole('button', { name: 'Details' })).toBeVisible();
  }
  await expect(page.getByText('Best month Feb 2026', { exact: false })).toHaveCount(0);
  // Owner workbench (22 Oct 2026): Finance is one calm scrolling page, no longer fitted to the window. Nothing pages,
  // and only the page scrolls: no section scrolls inside itself.
  await expect(page.locator('main [data-pager]')).toHaveCount(0);
  const inner = await page.locator('main section').evaluateAll((els) => els.filter((e) => { const o = getComputedStyle(e).overflowY; return (o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 1; }).length);
  expect(inner).toBe(0);
  // Details opens the paragraph, its source and a link to the view in the side drawer.
  await items.nth(1).getByRole('button', { name: 'Details' }).click();
  const drawer = page.getByRole('dialog', { name: 'Overdue collections' });
  await expect(drawer.getByText(/no matching payment appears in the bank lines/)).toBeVisible();
  await expect(drawer.getByRole('link', { name: 'Open Collections →' })).toHaveAttribute('href', '/finance?tab=revenue');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  expect(await page.evaluate(wide)).toBe(true);
});

test('Each section opens its first view; views stay one row on a phone; old links still open', async ({ page }) => {
  await page.setExtraHTTPHeaders(leadership);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [section, views] of [['Money in', ['Collections', 'Revenue', 'Clients']], ['Money out', ['Vendors & renewals', 'Ad spend', 'Budget', 'People value']], ['Cash', ['Reconcile', 'Forecast', 'Timeline', 'Month close']]] as const) {
      await page.goto('/finance');
      await page.getByRole('navigation', { name: 'Finance sections' }).getByRole('link', { name: section, exact: true }).click();
      const row = page.getByRole('navigation', { name: `${section} views` });
      await expect(row.getByRole('link')).toHaveText([...views]);
      await expect(row.getByRole('link', { name: views[0] })).toHaveAttribute('aria-current', 'true');
      const box = await row.boundingBox();
      expect(box!.height).toBeLessThan(48);
      expect(await page.evaluate(wide)).toBe(true);
    }
  }
  await page.goto('/finance?tab=ca');
  await expect(page).toHaveURL(/\/finance\/desk$/);
});

test('Collections: sort, filter, search, drawer and CSV on a computer; cards with "Show all" on a phone', async ({ page }) => {
  await page.setExtraHTTPHeaders(leadership);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/finance?tab=revenue');
  await expect(page.getByText('Due, no payment in bank lines')).toBeVisible();
  const table = page.getByRole('table', { name: 'Sales invoices' });
  const amount = table.getByRole('columnheader', { name: 'Amount' });
  await amount.getByRole('button').click();
  await expect(amount).toHaveAttribute('aria-sort', 'descending');
  await amount.getByRole('button').click();
  await expect(amount).toHaveAttribute('aria-sort', 'ascending');
  await page.getByRole('button', { name: /^Paid/ }).click();
  await expect(page.getByText(/^18 of 127 rows/)).toBeVisible();
  await expect(table.getByRole('cell', { name: 'No payment in bank lines' })).toHaveCount(0);
  await page.getByRole('button', { name: /^All/ }).click();
  await page.getByRole('searchbox', { name: 'Search Sales invoices' }).fill('INV-00003007');
  await expect(page.getByText(/^1 of 127 rows/)).toBeVisible();
  await table.getByRole('row').nth(1).click();
  const drawer = page.getByRole('dialog', { name: /INV-00003007/ });
  await expect(drawer.getByText('Taxable (ex-GST)')).toBeVisible();
  await page.keyboard.press('Escape');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^pulse-invoices-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await (await download.createReadStream()).toArray();
  const text = Buffer.concat(csv).toString('utf8');
  expect(text.split('\r\n')[0]).toBe('﻿Client,Invoice,Issued,Due,Overdue,Amount,Status');
  expect(text).toContain('INV-00003007');
  // Phones: one card per row, the first eight, then "Show all".
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/finance?tab=revenue');
  await expect(page.getByRole('button', { name: 'Show all 127' })).toBeVisible();
  const rows = page.getByRole('table', { name: 'Sales invoices' }).locator('tbody tr');
  await expect(rows.filter({ visible: true })).toHaveCount(8);
  expect(await page.evaluate(wide)).toBe(true);
  await page.getByRole('button', { name: 'Show all 127' }).click();
  await expect(rows.filter({ visible: true })).toHaveCount(127);
});

test('Reconcile is a queue with one action per row and says what is missing and who supplies it', async ({ page }) => {
  await page.setExtraHTTPHeaders(leadership);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/finance?tab=reconcile');
  await expect(page.getByText('Upload Axis statements after 5 Oct 2025 — Kazuk')).toBeVisible();
  const table = page.getByRole('table', { name: 'Invoice and bank matches' });
  const review = table.getByRole('button', { name: /^Review:/ });
  expect(await review.count()).toBeGreaterThan(0);
  for (const row of await table.locator('tbody tr').all()) await expect(row.getByRole('button')).toHaveCount(1);
  await review.first().click();
  await expect(page.getByRole('dialog').getByText('Why it matches')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Exceptions' }).click();
  await expect(page).toHaveURL(/reconcilePage=Exceptions/);
  await expect(page.getByRole('table', { name: 'Exceptions to clear' })).toBeVisible();
  await page.goto('/finance?tab=reconcile&reconcileView=Review+queues');
  await expect(page.getByRole('tab', { name: 'Certified queue' })).toHaveAttribute('aria-selected', 'true');
});

test('CA desk: founders see the sections and founder registers; an Accountant sees the desk alone', async ({ page }) => {
  await page.setExtraHTTPHeaders(leadership);
  await page.goto('/finance/desk?pilot=synthetic');
  await expect(page.getByRole('navigation', { name: 'Finance sections' }).getByRole('link', { name: 'CA desk' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: /^Founder 9 pm brief/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accountant access' })).toBeVisible();
  await page.getByRole('link', { name: /^Sales invoices/ }).click();
  await expect(page.getByText('No fixture entries in this register.')).toBeVisible();
  await page.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': 'accountant@example.test' });
  await page.goto('/finance/desk?pilot=synthetic');
  await expect(page.getByRole('navigation', { name: 'Finance sections' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Founder/ })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: '₹118' }).first()).toBeVisible();
});
