import { expect, test } from '@playwright/test';
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'Isolated synthetic browser adapters only');
const identity = { 'Cf-Access-Authenticated-User-Email': 'designer-a@estateautopilots.com' };

test('phone and tablet checklist keeps manual check-in available without OS permissions', async ({ page }) => {
  for (const width of [360, 390, 768, 1024]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 }); await page.setExtraHTTPHeaders(identity);
    await page.addInitScript(t => localStorage.setItem('pulse.theme', t), theme);
    await page.goto('/settings?tab=devices&section=Connection%20%26%20setup');
    const checklist = page.getByRole('article', { name: 'Connection and setup checklist' });
    await expect(checklist).toBeVisible();
    await expect(checklist).toContainText('Force quit'); await expect(checklist).toContainText('three hours');
    await expect(checklist.getByRole('link', { name: 'Open My desk · manual check-in' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `test-results/r16/checklist-${width}-${theme}.png` });
  }
});

test('lost response remains queued across page restart and retries the same ID, showing the receipt', async ({ page, request }) => {
  await page.setExtraHTTPHeaders(identity); await page.setViewportSize({ width: 390, height: 844 });
  const self = await (await request.get('/api/v0/hr/self', { headers: identity })).json();
  const owner = self.person.id;
  await page.route('**/api/v0/companion', route => route.fulfill({ json: { person: { id: owner, firstName: 'Synthetic', name: 'Synthetic Designer' }, now: new Date().toISOString(), today: '2026-10-09', clock: '12:00', timezone: 'Asia/Kolkata', utcOffsetMinutes: 330, shift: { start: '09:00', end: '18:00', mode: 'office', workingDay: true, graceMinutes: 10, onTimeBy: '09:10' }, state: 'out', entry: null, shiftStartsAt: new Date().toISOString(), shiftEndsAt: new Date().toISOString(), nextShift: null, streak: { onTime: 0, firstCheckIn: false }, waiting: null, presence: { autoCheckIn: false, offices: [], sites: [] } } }));
  let ready = false; const ids: string[] = [];
  await page.route('**/api/v0/attendance/check-in', async route => {
    const body = route.request().postDataJSON(); ids.push(body.queueId);
    expect(body.expectedPersonId).toBe(owner);
    if (!ready) await route.abort('failed'); else await route.fulfill({ json: { id: 'synthetic-server-receipt', replayed: true } });
  });
  await page.goto('/me');
  const today = page.getByRole('region', { name: 'Today', exact: true });
  const checkin = today.getByRole('button', { name: 'Check in', exact: true });
  await expect(checkin).toBeEnabled(); await checkin.click();
  await today.getByText('Saved attendance · 1 waiting').click();
  await expect(today).toContainText('Queued — waiting for server confirmation');
  await expect(today).not.toContainText('Accepted by Pulse'); await expect(checkin).toBeDisabled();
  await page.reload();
  await expect(today.getByText('Saved attendance · 1 waiting')).toBeVisible();
  // Foreground recovery starts automatically after reload, in My desk and in the header's check-in chip
  // (PRESENCE-ONBOARD: two recoveries share the queue and its lock). Let both offline attempts finish
  // before reconnecting, so this assertion exercises an explicit retry rather than racing it.
  await expect.poll(() => ids.length).toBeGreaterThanOrEqual(3);
  await expect(today.getByRole('button', { name: 'Retry saved attendance' })).toBeEnabled();
  ready = true;
  await today.getByRole('button', { name: 'Retry saved attendance' }).click();
  // Owner workbench (21 Oct 2026): an accepted tap leaves the saved-attendance log, which shows only what still needs the
  // person; the server's receipt stays with the tap in this browser's queue.
  await expect(today.getByText(/^Saved attendance · /)).toHaveCount(0);
  await expect(today).not.toContainText('Queued — waiting for server confirmation');
  expect(await page.evaluate(() => Object.values(localStorage).some((v) => v.includes('synthetic-server-receipt')))).toBe(true);
  expect(new Set(ids).size).toBe(1);
  await page.screenshot({ path: 'test-results/r16/accepted-phone.png' });
});
