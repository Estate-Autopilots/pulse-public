import { expect, test } from '@playwright/test';
import { demoPayload } from '../../packages/companion/src/demo.js';
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'Synthetic native bridge and HTTP fixtures only');
const identity = { 'Cf-Access-Authenticated-User-Email': 'designer-a@estateautopilots.com' };

async function nativeFixture(page: import('@playwright/test').Page, person: string, unavailable = false) {
  await page.addInitScript(({ person, unavailable }) => {
    const basic = { platform: 'android', version: '1.1.1', build: 1001001, enrolled: true, deviceId: 'synthetic-phone', personId: person, notifications: false, pushReady: false, pushActive: false };
    const plugin = new Proxy({}, { get: (_target, name) => async () => name === 'info' || name === 'status' ? basic : name === 'presencePreferences' ? { enabled: false, offices: [], sites: [] } : {} });
    const surfaces = {
      refresh: async () => {},
      takeAction: async () => {
        if (unavailable) throw Error('Cold credential unavailable');
        if (sessionStorage.getItem('synthetic-surface-consumed')) return {};
        sessionStorage.setItem('synthetic-surface-consumed', '1');
        return { action: 'check-in', personId: person };
      },
      ribbon: async (choice?: { enabled: boolean }) => {
        if (choice) localStorage.setItem('synthetic-ribbon', String(choice.enabled));
        return { enabled: localStorage.getItem('synthetic-ribbon') === 'true', permission: false };
      },
    };
    (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { PulseShell: plugin, PulseAttendance: surfaces } };
  }, { person, unavailable });
}

test('cold widget confirmation uses durable shared queue and lost-response retry ID, with notifications denied', async ({ page, request }) => {
  await page.setExtraHTTPHeaders(identity); await page.setViewportSize({ width: 390, height: 844 });
  const self = await (await request.get('/api/v0/hr/self', { headers: identity })).json(); const person = self.person.id;
  await nativeFixture(page, person);
  const day = { ...demoPayload('out'), demo: false, presence: { autoCheckIn: false, offices: [], sites: [] } };
  await page.route('**/api/v0/companion', route => route.fulfill({ json: { ...day, person: { ...day.person, id: person }, now: new Date().toISOString() } }));
  let connected = false; const ids: string[] = [];
  await page.route('**/api/v0/attendance/check-in', async route => {
    const body = route.request().postDataJSON(); expect(body.expectedPersonId).toBe(person); ids.push(body.queueId);
    if (!connected) await route.abort('failed'); else await route.fulfill({ json: { id: 'synthetic-widget-receipt', replayed: true } });
  });
  await page.goto('/me');
  const prompt = page.getByRole('group', { name: 'Confirm attendance shortcut' });
  await expect(prompt).toBeVisible(); expect(ids).toHaveLength(0);
  await page.screenshot({ path: 'test-results/r21/cold-confirmation-390.png' });
  await prompt.getByRole('button', { name: 'Confirm check-in', exact: true }).click();
  await expect(prompt).not.toBeVisible();
  await page.getByText('Saved attendance · 1 waiting').click();
  await expect(page.getByRole('region', { name: 'Today', exact: true })).toContainText('Queued — waiting for server confirmation');
  await page.reload();
  await expect(page.getByText('Saved attendance · 1 waiting')).toBeVisible();
  // After the reload My desk and the header's check-in chip (PRESENCE-ONBOARD) each retry the saved check-in on their
  // own. Let those offline attempts settle before reconnecting, so the click below is the retry that delivers it rather
  // than racing the chip's (as in mobile-reliability.spec.ts).
  let seen = -1;
  await expect.poll(() => { const settled = ids.length === seen && ids.length >= 2; seen = ids.length; return settled; }, { intervals: [800], timeout: 15000 }).toBe(true);
  await expect(page.getByRole('button', { name: 'Retry saved attendance' })).toBeEnabled();
  connected = true;
  await expect(prompt).not.toBeVisible();
  await page.getByRole('button', { name: 'Retry saved attendance' }).click();
  // Owner workbench (21 Oct 2026): an accepted tap leaves the saved-attendance log, which shows only what still needs the
  // person; the server's receipt stays with the tap in this browser's queue.
  await expect(page.getByText(/^Saved attendance · /)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Today', exact: true })).not.toContainText('Queued — waiting for server confirmation');
  expect(await page.evaluate(() => Object.values(localStorage).some((v) => v.includes('synthetic-widget-receipt')))).toBe(true);
  expect(new Set(ids).size).toBe(1);
});

test('unavailable cold credential offers ordinary manual attendance without pretending the shortcut succeeded', async ({ page, request }) => {
  await page.setExtraHTTPHeaders(identity);
  const self = await (await request.get('/api/v0/hr/self', { headers: identity })).json(); await nativeFixture(page, self.person.id, true);
  await page.goto('/me'); await expect(page.getByRole('button', { name: 'Check in', exact: true })).toBeEnabled();
  await expect(page.getByRole('group', { name: 'Confirm attendance shortcut' })).not.toBeVisible();
});

test('optional ribbon defaults off, permission denial retains manual link, and dismissal choice survives refresh', async ({ page, request }) => {
  await page.setExtraHTTPHeaders(identity); await page.setViewportSize({ width: 360, height: 780 });
  const self = await (await request.get('/api/v0/hr/self', { headers: identity })).json(); await nativeFixture(page, self.person.id);
  await page.goto('/settings?tab=devices');
  const card = page.getByRole('article', { name: 'Attendance shortcuts' });
  await expect(card).toBeVisible(); const checkbox = card.getByRole('checkbox'); await expect(checkbox).not.toBeChecked();
  await checkbox.check(); await expect(page.getByText('Manual attendance still works on My desk.', { exact: false })).toBeVisible();
  await checkbox.uncheck(); await page.reload(); await expect(checkbox).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/r21/settings-denied-360.png' });
});
