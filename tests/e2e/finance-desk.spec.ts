import { expect, test } from '@playwright/test';

test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'Accountant fixtures use only the isolated test server');

// CA-ACCESS (owner, 8 Nov 2026): the CA's place in Finance. On a phone and a computer: the month, its close steps, the
// bills To verify with one bill's panel (its numbers, Verified and Ask), the downloads, and nothing of staff or founders.
test('A CA sees the month to check, Verified and Ask, and nothing of staff or founders', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': 'accountant@example.test' });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/finance/desk?pilot=synthetic');
    await expect(page.getByRole('heading', { name: 'Check the books', exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: /^Month close/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^To verify/ })).toHaveAttribute('aria-selected', 'true');
    if (width < 760) {
      await expect(page.getByRole('button', { name: 'Verified', exact: true }).first()).toBeVisible();
      await page.getByRole('button', { name: /Synthetic Software/ }).click();
    } else {
      // The party cell is a button named "Open <party>" (the row opens its panel).
      await expect(page.getByRole('button', { name: 'Open Synthetic Software', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Open Synthetic Software', exact: true }).click();
    }
    const panel = page.getByRole('complementary', { name: 'Synthetic Software: details' });
    await expect(panel.getByText('Vendor GSTIN')).toBeVisible();
    await expect(panel.getByText('Our GSTIN on the bill')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/finance-desk/accountant-panel-${width}.png` });
    await panel.getByRole('button', { name: 'Close' }).click();
    // FIX-PEOPLE-MONEY C3: the downloads are one menu in the month bar, at the top.
    await page.getByRole('button', { name: /^Download/ }).click();
    await expect(page.getByRole('menuitem', { name: /GST register/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Tally register CSV/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Your CA/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Founder 9 pm brief' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Chats', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Approve.*send/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `test-results/finance-desk/accountant-${width}.png` });
  }
  await page.goto('/finance/desk?view=registers&pilot=synthetic');
  await expect(page.getByRole('heading', { name: 'Purchase register', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Synthetic Software', exact: true }).first()).toBeVisible();
  await page.goto('/hr');
  await expect(page).toHaveURL(/\/finance\/desk$/);
  await expect(page.getByRole('heading', { name: 'Check the books', exact: true })).toBeVisible();
});
