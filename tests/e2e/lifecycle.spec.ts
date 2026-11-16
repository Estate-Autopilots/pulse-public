import { expect, test } from '@playwright/test';

// LIFECYCLE (11 Oct 2026) on the wholly synthetic fixture (tests/e2e/fixtures/lifecycle.mjs, served by the mock API):
// People moves with HR's one-click review, the leaving checklist, value against cost, role seats and staffing gaps for
// leadership, and My Pulse with kudos and corrections. Every page fits a phone without sideways scrolling.
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'The lifecycle fixtures are synthetic and served only by the isolated test server');

const admin = { 'Cf-Access-Authenticated-User-Email': 'admin@estateautopilots.com' };
const staff = { 'Cf-Access-Authenticated-User-Email': 'staff@example.test' };
const fits = () => document.scrollingElement!.scrollWidth <= innerWidth + 1;

test('People moves: possibly left with its evidence, one click to mark as left, and the checklist it opens', async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await page.goto('/hr?tab=moves');
  const review = page.getByRole('region', { name: 'Possibly left: confirm' });
  await expect(review.getByText('Resignation mail to HR, 21 Sep 2026 (last working day 30 Sep 2026)')).toBeVisible();
  // "Still here" asks why before anything is kept.
  const kabir = review.locator('[data-review="lc-kabir"]');
  await expect(kabir.getByText('Strong evidence')).toBeVisible();
  await kabir.getByRole('button', { name: 'Still here' }).click();
  await expect(kabir.getByRole('button', { name: 'Keep as current' })).toBeDisabled();
  await kabir.getByRole('button', { name: 'Cancel' }).click();
  await kabir.getByRole('button', { name: 'Mark as left on 30 Sep, resigned' }).click();
  await expect(kabir.getByText('Alumni from 30 Sep')).toBeVisible();
  await kabir.getByRole('link', { name: 'Open the leaving checklist' }).click();
  await expect(page).toHaveURL(/\/hr\/moves\/lc-case-leave$/);
  await expect(page.getByRole('heading', { name: 'Leaving: Ishaan Bose' })).toBeVisible();
  // The checklist: steps already done in the data, settlement inputs to confirm, Workspace as an admin's ticks only.
  await expect(page.locator('[data-step="work"]')).toContainText('Done by Leela Nair');
  const settle = page.locator('[data-step="settlement"]');
  await expect(settle.getByRole('spinbutton', { name: 'Leave to encash (days)' })).toHaveValue('4.5');
  await settle.getByRole('button', { name: 'Confirm settlement inputs' }).click();
  await expect(page.getByText('Final settlement inputs: done').first()).toBeVisible();
  const workspace = page.locator('[data-step="workspace"]');
  await expect(workspace.getByText('Pulse never changes Workspace itself.', { exact: false })).toBeVisible();
  await expect(workspace.getByRole('checkbox', { name: /Suspend ishaan@example\.test/ })).toBeChecked();
  await expect(page.locator('[data-step="alumni"]').getByText('Available from the last working day. Before it, they are on notice.')).toBeVisible();
});

test('Value against cost: bands with their method, never a ranking; seats compare holders by tenure month', async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await page.goto('/leadership?tab=people&view=value');
  const board = page.locator('[data-value-board]');
  await expect(board.getByText('Median value ÷ cost')).toBeVisible();
  // Rows come in name order (Ahoro, Asha, Dev…), not by value.
  const names = await board.locator('tbody td[data-label="Person"] b').allTextContents();
  expect(names.slice(0, 3)).toEqual(['Ahoro Menon', 'Asha Rao', 'Dev Malhotra']);
  await board.getByRole('link', { name: /^Below/ }).click();
  await expect(board.locator('tbody tr')).toHaveCount(2);
  await board.getByRole('button', { name: 'How it is worked out' }).click();
  await expect(page.getByRole('dialog', { name: 'Value against cost' }).getByText('Strong at 1.25× the median or more', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/leadership?tab=people&view=seats&seat=lc-seat-gd');
  const compare = page.locator('[data-seat-compare]');
  await expect(compare.locator('[data-holder="lc-rhea"]').getByText('Too early to judge')).toBeVisible();
  await expect(compare.locator('[data-holder="lc-ishaan"]').getByText('Holds it now')).toBeVisible();
  await expect(compare.getByText('compared over their first 8 months', { exact: false })).toBeVisible();
  await page.goto('/leadership?tab=people&view=staffing');
  await expect(page.getByRole('region', { name: 'Seats nobody holds now' }).getByText('last held by Omi Kireteso', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Open work nobody holds' }).getByText(/^In their domain: Static design/)).toBeVisible();
});

test('My Pulse: the person’s own home, thanks to a colleague and a correction sent to HR', async ({ page }) => {
  await page.setExtraHTTPHeaders(staff);
  await page.goto('/me');
  const home = page.locator('[data-my-pulse]');
  await expect(home.getByRole('heading', { level: 2, name: /^Good (morning|afternoon|evening), / })).toBeVisible();
  // UX-5A: today, due today and waiting for you on top, then the week, then tiles; what Pulse knows moved to the profile.
  // Owner workbench (21 Oct 2026): due today and waiting for you are one card ("Due today"), above the week.
  for (const name of ['Due today', 'My week', 'Recognition', 'My growth', 'My money']) await expect(home.getByRole('region', { name })).toBeVisible();
  expect((await home.getByRole('region', { name: 'Due today' }).boundingBox())!.y).toBeLessThan((await home.getByRole('region', { name: 'My week' }).boundingBox())!.y);
  await expect(home.getByRole('region', { name: 'What Pulse knows about me' })).toHaveCount(0);
  await expect(home.getByText('Stayed late to fix the Skyline export', { exact: false })).toBeVisible();
  await home.getByRole('button', { name: 'Thank a colleague' }).click();
  const thanks = page.getByRole('dialog', { name: 'Thank a colleague' });
  await thanks.getByRole('button', { name: /^Who:/ }).click();
  await thanks.getByRole('combobox', { name: 'Who' }).fill('Meera');
  await thanks.getByRole('option', { name: /^Meera Iyer/ }).click();
  await thanks.getByRole('textbox', { name: 'What for' }).fill('Covered the Sunday shoot');
  await thanks.getByRole('button', { name: 'Send thanks' }).click();
  await expect(page.getByText('Thanks sent to Meera').first()).toBeVisible();
  // "Not right?" on what Pulse knows is on the profile now (My info): services/api/test/ux5a-runner.mjs sends one to HR.
  // Nobody's cost is ever on this page.
  await expect(home.getByText(/cost/i)).toHaveCount(0);
});

test('every lifecycle page fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [who, path] of [[admin, '/hr?tab=moves'], [admin, '/hr/moves/lc-case-leave'], [admin, '/hr/moves/lc-case-join'], [admin, '/leadership?tab=people&view=value'],
    [admin, '/leadership?tab=people&view=seats&seat=lc-seat-gd'], [admin, '/leadership?tab=people&view=staffing'], [staff, '/me']] as const) {
    await page.setExtraHTTPHeaders(who);
    await page.goto(path);
    await expect(page.locator('main h2').first()).toBeVisible();
    expect(await page.evaluate(fits), `${path} fits 390 px`).toBe(true);
  }
});
