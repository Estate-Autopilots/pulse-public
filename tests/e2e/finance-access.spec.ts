import { expect, test } from '@playwright/test';
import { join } from 'node:path';

test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'Finance access checks use only the isolated synthetic API');

for (const width of [390, 1440]) for (const theme of ['light', 'dark'] as const) {
  test(`Finance denial explains access and opens Roles: ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': 'finance-admin@example.test' });
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript(value => localStorage.setItem('pulse.theme', value), theme);
    await page.goto('/finance');
    const notice = page.getByRole('region', { name: 'Finance access required' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Leadership role');
    await expect(notice).toContainText('both Finance read and amount permissions');
    await expect(notice).toContainText('The Finance role covers ERP only');
    await expect(page.getByRole('navigation', { name: 'Finance sections' })).toHaveCount(0);
    await expect(page.locator('main table')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth + 1)).toBe(true);
    const roles = notice.getByRole('link', { name: 'Settings → Roles & permissions' });
    await expect(roles).toHaveAttribute('href', '/settings?tab=roles');
    await roles.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(roles).toBeFocused();
    const filename = `finance-access-${width}-${theme}.png`;
    await page.screenshot({ path: process.env.PULSE_FINANCE_EVIDENCE_DIR ? join(process.env.PULSE_FINANCE_EVIDENCE_DIR, filename) : testInfo.outputPath(filename), fullPage: true });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings\?tab=roles$/);
    const sections = page.getByRole('main').getByRole('navigation', { name: 'Sections', exact: true });
    await expect(sections).toBeVisible();
    const legacyRoles = sections.getByRole('link', { name: 'Roles & permissions', exact: true });
    // R2 moves Roles into Who can do what; keep coverage of the pre-R2 destination too.
    if (await legacyRoles.count()) {
      await expect(legacyRoles).toHaveAttribute('aria-current', 'page');
    } else {
      await expect(sections.getByRole('link', { name: 'Who can do what', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Roles & permissions', exact: true })).toHaveAttribute('aria-current', 'true');
    }
    await expect(page.getByRole('heading', { name: /^Organisation admins/ })).toBeVisible();
    await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Leadership', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^Leadership/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Leadership/ })).toBeVisible();
    if (!(await legacyRoles.count())) {
      await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Work rules', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^Leadership/ })).toBeHidden();
      await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Roles & permissions', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^Leadership/ })).toBeVisible();
    }
  });
}

for (const width of [390, 1440]) for (const identity of ['staff@northwind-on.example', 'hr@northwind-on.example']) {
  test(`Non-admin Roles destination preserves the boundary: ${identity} ${width}px`, async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': identity });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/finance');
    await page.getByRole('link', { name: 'Settings → Roles & permissions' }).click();
    await expect(page).toHaveURL(/\/settings\?tab=roles$/);
    await expect(page.getByText('Organisation admin access required', { exact: true })).toBeVisible();
    await expect(page.getByText(/Only organisation admins can open these settings/)).toBeVisible();
    await expect(page.locator('main table, main input, main button')).toHaveCount(0);
    await page.getByRole('link', { name: 'Back to Finance' }).click();
    await expect(page.getByRole('region', { name: 'Finance access required' })).toBeVisible();
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('A Finance service failure does not claim the viewer lacks permission', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': 'finance-outage@example.test' });
  await page.goto('/finance');
  // EST-1197 (R1): a service's own words are not Pulse's sentences, so the outage reads as the plain line with Try again.
  await expect(page.getByText('This didn’t load', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByText('Synthetic Finance service unavailable')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Finance access required' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings → Roles & permissions' })).toHaveCount(0);
});
