import { expect, test } from '@playwright/test';

// UX-PEOPLE (owner, 5 Nov 2026): People → Access is ONE matrix of people × what they can do, with role templates,
// bulk changes and "what can this person do". Synthetic admin on the mock API; nothing real is read or changed.
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'Uses the isolated synthetic API');
const admin = { 'Cf-Access-Authenticated-User-Email': 'access-admin@example.test' };
const quiet = () => { try { localStorage.setItem('pulse.unify.later', String(Date.now())); } catch { /* private window */ } };

for (const width of [390, 1440]) for (const theme of ['light', 'dark'] as const) {
  test(`Access matrix: one page, readable, no sideways scroll: ${width}px ${theme}`, async ({ page }) => {
    await page.setExtraHTTPHeaders(admin);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* private window */ } }, theme);
    await page.addInitScript(quiet);
    await page.goto('/people/access');
    await expect(page.getByRole('heading', { name: 'Access', exact: true })).toBeVisible();
    // One h1 on the page: the shell's breadcrumb.
    expect(await page.locator('h1').count()).toBe(1);
    await expect(page.getByLabel('Access at a glance')).toBeVisible();
    const roleFilter = page.getByRole('navigation', { name: 'Filter by role' });
    await expect(roleFilter.getByRole('button', { name: /^Everyone/ })).toHaveAttribute('aria-pressed', 'true');
    // The grant that does nothing is the first thing to do.
    await expect(page.getByRole('button', { name: /Gita Menon holds a grant that does nothing/ })).toBeVisible();
    if (width >= 1024) await expect(page.getByRole('table')).toBeVisible();
    else await expect(page.getByRole('table')).toBeHidden();
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth + 1)).toBe(true);
    // A role is a filter, not a tab.
    await roleFilter.getByRole('button', { name: /^HR/ }).click();
    await expect(page.getByRole('heading', { name: /^HR/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'What can Hema Rao do?' }).filter({ visible: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'What can Esha Nair do?' }).filter({ visible: true })).toHaveCount(0);
    await roleFilter.getByRole('button', { name: /^Everyone/ }).click();
    // What can this person do.
    await page.getByRole('button', { name: 'What can Esha Nair do?' }).filter({ visible: true }).click();
    await expect(page.getByRole('heading', { name: /^What Esha can do/ })).toBeVisible();
    await expect(page.getByRole('group', { name: "Esha Nair's roles" }).getByRole('button', { name: 'Manager' })).toHaveAttribute('aria-pressed', 'false');
    // Keyboard: the close button takes focus and Enter closes the person view.
    const close = page.getByRole('button', { name: 'Close and show the role templates' });
    // It takes focus when the person opens; at 1440 the table stays in view beside the drawer.
    await expect(close).toBeFocused();
    if (width >= 1024) await expect(page.getByRole('table')).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: /^Role templates/ })).toBeVisible();
    // Escape closes it too.
    await page.getByRole('button', { name: 'What can Esha Nair do?' }).filter({ visible: true }).click();
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(close).toBeHidden();
  });
}

test('Bulk: choose people, give a role, confirm the list of changes', async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(quiet);
  const posts: unknown[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/settings/roles')) posts.push(r.postDataJSON()); });
  await page.goto('/people/access');
  for (const name of ['Esha Nair', 'Gita Menon', 'Farid Khan']) await page.getByRole('checkbox', { name: `Choose ${name}` }).filter({ visible: true }).check();
  const bar = page.getByRole('region', { name: 'Change the people chosen' });
  await expect(bar).toContainText('3 chosen');
  await bar.getByLabel('Give a role').selectOption('manager');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Esha Nair');
  // Gita has no team (the mock company says Team): left as she is, with the reason.
  await expect(dialog).toContainText('Gita Menon: needs a team first');
  await dialog.getByRole('button', { name: 'Give for 2' }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts).toContainEqual({ personId: 'syn-ed1', role: 'manager', action: 'grant' });
});
