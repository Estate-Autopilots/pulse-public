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
    // SETTINGS-APPLE (13 Nov 2026): Settings is the list of areas beside the open section (on a phone the section is
    // pushed over the list), so the section chips are gone. The breadcrumb names the area and the section at every
    // width; on a computer the list beside it keeps the section marked.
    const crumbs = page.getByRole('navigation', { name: 'Where you are in Settings' });
    await expect(crumbs).toBeVisible();
    await expect(crumbs).toContainText('People & access'); // the area is a step, not a link (Settings › area › section)
    const area = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('region', { name: 'People & access', exact: true });
    const legacyRoles = area.getByRole('link', { name: 'Roles & permissions', exact: true });
    // R2 moves Roles into Who can do what; keep coverage of the pre-R2 destination too.
    if (await legacyRoles.count()) {
      await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Roles & permissions');
      if (width >= 760) await expect(legacyRoles).toHaveAttribute('aria-current', 'page');
    } else {
      await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Who can do what');
      if (width >= 760) await expect(area.getByRole('link', { name: 'Who can do what', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Roles & permissions', exact: true })).toHaveAttribute('aria-current', 'true');
    }
    // UX-PEOPLE: the tab per role is one matrix of people x what they can do; a role is a filter chip on it.
    const roleFilter = page.getByRole('navigation', { name: 'Filter by role' });
    await expect(page.getByRole('heading', { name: /^Everyone\s*\d/ })).toBeVisible();
    await roleFilter.getByRole('button', { name: /^Leadership/ }).click();
    await expect(page.getByRole('heading', { name: /^Leadership/ }).first()).toBeVisible();
    if (!(await legacyRoles.count())) {
      await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Work rules', exact: true }).click();
      await expect(roleFilter).toBeHidden();
      await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Roles & permissions', exact: true }).click();
      await expect(roleFilter).toBeVisible();
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
