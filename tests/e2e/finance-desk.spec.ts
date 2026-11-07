import { expect, test } from '@playwright/test';

test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'Accountant fixtures use only the isolated test server');

test('Accountant has a readable Finance desk and cannot navigate to staff or founder surfaces', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': 'accountant@example.test' });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/finance/desk?pilot=synthetic');
    await expect(page.getByRole('heading', { name: 'Finance desk', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Synthetic Software', exact: true })).toBeVisible();
    const gstinPresent = page.getByRole('cell', { name: 'No', exact: true });
    await gstinPresent.scrollIntoViewIfNeeded();
    await expect(gstinPresent).toBeVisible();
    await page.getByLabel('Register columns; scroll across for more').evaluate(el => el.scrollLeft = 0);
    const header = await page.getByRole('columnheader', { name: 'Vendor GSTIN', exact: true }).boundingBox();
    expect(header!.height).toBeLessThan(80); // Headers remain readable, rather than stacking every letter.
    await expect(page.getByRole('link', { name: 'Tally register CSV' })).toBeVisible();
    await expect(page.getByRole('link', { name: '2026-09-01_Synthetic-Software_118_SYN-1.pdf' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Founder 9 pm brief' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Accountant access' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Chats', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Approve.*send/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `test-results/finance-desk/accountant-${width}.png` });
  }
  await page.goto('/hr');
  await expect(page).toHaveURL(/\/finance\/desk$/);
  await expect(page.getByRole('heading', { name: 'Finance desk', exact: true })).toBeVisible();
});
