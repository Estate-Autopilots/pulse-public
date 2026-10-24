import { expect, test } from '@playwright/test';

test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'The live finance fixture is synthetic and served only by the isolated test server');

const leadership = { 'Cf-Access-Authenticated-User-Email': 'admin@estateautopilots.com' };

test('Finance opens on a short, sourced brief and every tab leads with live, uncertified figures', async ({ page }) => {
  await page.setExtraHTTPHeaders(leadership);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/finance?tab=overview');
    await expect(page.getByRole('heading', { name: 'What the founders should know' })).toBeVisible();
    const items = page.locator('article').filter({ hasText: /confidence/ });
    expect(await items.count()).toBeGreaterThanOrEqual(1);
    await expect(page.getByText('Uncertified until the CA certifies the month')).toBeVisible();
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `test-results/finance-live/overview-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [tab, text] of [['revenue', 'Due, no payment in bank lines'], ['reconcile', 'Invoices matched to bank credits'], ['timeline', 'Month by month'], ['budget', 'Plan vs actual'], ['forecast', 'Six-month cash projection'], ['subscriptions', 'Renewals in the next 30 days'], ['ledger', 'Live sources']] as const) {
    await page.goto(`/finance?tab=${tab}`);
    await expect(page.getByText(text).first()).toBeVisible();
    await page.screenshot({ path: `test-results/finance-live/${tab}-1440.png` });
  }
  await page.goto('/finance?tab=ledger&financeSource=What+is+missing');
  await expect(page.getByText(/Who: /).first()).toBeVisible();
});

test('An Accountant never sees the uncertified live finance views', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': 'accountant@example.test' });
  await page.goto('/finance?tab=overview');
  await expect(page).toHaveURL(/\/finance\/desk$/);
  await expect(page.getByRole('heading', { name: 'What the founders should know' })).toHaveCount(0);
});
