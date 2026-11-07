// POLISH-1 (owner's phone test of Pulse 1.1.0, 11 Oct 2026): the header under the status bar exactly once, the
// notification question after sign-in, the bell on a phone, a check-out forgotten yesterday, and office arrival.
// Synthetic fixtures and a stand-in native bridge; screenshots in test-results/polish1/.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { demoPayload } from '../../packages/companion/src/demo.js';

test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'Synthetic fixtures use the isolated test server');
const admin = { 'Cf-Access-Authenticated-User-Email': 'admin@estateautopilots.com' };
const PHONES = [{ width: 360, height: 780 }, { width: 390, height: 844 }];
const APP_UA = 'Mozilla/5.0 (Linux; Android 13; Redmi Note 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 PulseShell/1.1.2';
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/polish1/${name}.png` });

/** What the phone reports as its system bars: env(safe-area-inset-*) through Chromium's own override. */
async function insets(page: Page, top: number, bottom: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { top, bottom, left: 0, right: 0 } } as never);
}
/** Capacitor's injected copy of the window's insets (as the 1.1.0/1.1.1 shell does on every Android version). */
const injected = (context: BrowserContext, top: number, bottom: number) => context.addInitScript(([t, b]) => {
  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.setProperty('--safe-area-inset-top', `${t}px`);
    document.documentElement.style.setProperty('--safe-area-inset-bottom', `${b}px`);
  });
}, [top, bottom]);

type Bridge = { info?: Record<string, unknown>; permissions?: Record<string, string>; presence?: Record<string, unknown>; after?: Record<string, unknown> };
/** A stand-in for the Pulse phone app's bridge; calls are recorded on window.__shellCalls. */
async function bridge(context: BrowserContext, b: Bridge) {
  await context.addInitScript((b: Bridge) => {
    const calls: [string, unknown][] = []; (window as unknown as { __shellCalls: typeof calls }).__shellCalls = calls;
    let info = { platform: 'android', version: '1.1.2', build: 1001002, enrolled: true, deviceId: 'synthetic-phone', personId: 'synthetic-admin', notifications: false, pushReady: false, pushActive: false, ...(b.info ?? {}) };
    let presence = b.presence ?? { enabled: false, offices: [], sites: [] };
    const answer = (name: string, arg: unknown) => {
      if (name === 'info' || name === 'status') return info;
      if (name === 'checkPermissions') return b.permissions ?? {};
      if (name === 'requestNotifications') { if (b.after) info = { ...info, ...b.after }; return { state: info.notifications ? 'granted' : 'denied' }; }
      if (name === 'presencePreferences') return presence;
      if (name === 'requestPermissions') { const wanted = (arg as { permissions: string[] }).permissions; if (wanted.includes('background')) presence = { ...presence, arrival: { location: true, background: true } }; return { location: 'granted', background: wanted.includes('background') ? 'granted' : 'prompt' }; }
      return {};
    };
    const plugin = new Proxy({}, { get: (_t, name: string) => async (arg?: unknown) => { calls.push([name, arg]); return answer(name, arg); } });
    (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { PulseShell: plugin } };
  }, b);
}
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __shellCalls: [string, unknown][] }).__shellCalls.map((c) => c[0]));

test.describe('the header sits directly under the status bar', () => {
  for (const size of PHONES) for (const theme of ['light', 'dark'] as const) {
    test(`in the app (edge to edge) and in a phone browser, ${size.width} ${theme}`, async ({ browser }) => {
      // Edge to edge (Android 15+, and every Android with shell 1.1.2): the page reaches under a 24 px status bar and a
      // 48 px 3-button navigation bar; Capacitor injects the same insets. The header pads by them once.
      const context = await browser.newContext({ viewport: size, colorScheme: theme, isMobile: true, hasTouch: true, userAgent: APP_UA, extraHTTPHeaders: admin });
      await context.addInitScript((t) => { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.notify.asked', '1'); localStorage.setItem('pulse.notify.later', new Date().toISOString().slice(0, 10)); }, theme);
      await injected(context, 24, 48);
      const page = await context.newPage(); await insets(page, 24, 48);
      await page.goto('/dashboard');
      const bar = page.locator('header[class*="topBar"]').first();
      await expect(bar).toBeVisible();
      const geometry = await bar.evaluate((el) => ({ top: el.getBoundingClientRect().top, padding: parseFloat(getComputedStyle(el).paddingTop), height: el.getBoundingClientRect().height }));
      expect(geometry.top).toBe(0);
      expect(geometry.padding, 'the status bar counted once').toBe(24);
      const nav = await page.locator('nav[aria-label="Mobile navigation"]').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
      expect(nav, 'the 3-button bar counted once').toBe(48);
      await shot(page, `edges-app-${size.width}-${theme}`);
      await context.close();
    });
    test(`under an older shell that already made room (Android 14 and older, 1.1.0), ${size.width} ${theme}`, async ({ browser }) => {
      // Android placed the page below the status bar: env() is 0, but the 1.1.0 shell still injects the full inset.
      // That injected copy made the empty band on the owner's Redmi; it must not count.
      const context = await browser.newContext({ viewport: size, colorScheme: theme, isMobile: true, hasTouch: true, userAgent: APP_UA.replace('1.1.2', '1.1.0'), extraHTTPHeaders: admin });
      await context.addInitScript((t) => { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.notify.asked', '1'); localStorage.setItem('pulse.notify.later', new Date().toISOString().slice(0, 10)); }, theme);
      await injected(context, 29, 48);
      const page = await context.newPage();
      await page.goto('/dashboard');
      const bar = page.locator('header[class*="topBar"]').first();
      await expect(bar).toBeVisible();
      expect(await bar.evaluate((el) => parseFloat(getComputedStyle(el).paddingTop)), 'no band above the header').toBe(0);
      expect(await page.locator('nav[aria-label="Mobile navigation"]').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))).toBe(0);
      await shot(page, `edges-legacy-${size.width}-${theme}`);
      await context.close();
    });
  }
});

test.describe('notifications after sign-in in the phone app', () => {
  for (const size of PHONES) for (const theme of ['light', 'dark'] as const) {
    test(`Pulse explains first, then Android asks; on "Allow" nothing else shows, ${size.width} ${theme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: size, colorScheme: theme, isMobile: true, hasTouch: true, userAgent: APP_UA, extraHTTPHeaders: admin });
      await context.addInitScript((t) => localStorage.setItem('pulse.theme', t), theme);
      await bridge(context, { info: { notificationsAsk: 'prompt' }, after: { notifications: true, notificationsAsk: 'granted' } });
      const page = await context.newPage();
      await page.goto('/dashboard');
      const sheet = page.getByRole('dialog', { name: 'Let Pulse tell you when something needs you' });
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText('Approvals, chats and check-in reminders');
      expect(await calls(page)).not.toContain('requestNotifications');
      await shot(page, `notify-explain-${size.width}-${theme}`);
      await sheet.getByRole('button', { name: 'Allow notifications' }).click();
      await expect(sheet).toHaveCount(0);
      expect(await calls(page)).toContain('requestNotifications');
      await expect(page.getByRole('region', { name: 'Notifications are off' })).toHaveCount(0);
      await context.close();
    });
    test(`refused: a calm banner whose "Open settings" opens the app's notification settings, ${size.width} ${theme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: size, colorScheme: theme, isMobile: true, hasTouch: true, userAgent: APP_UA, extraHTTPHeaders: admin });
      await context.addInitScript((t) => localStorage.setItem('pulse.theme', t), theme);
      await bridge(context, { info: { notificationsAsk: 'denied' } });
      const page = await context.newPage();
      await page.goto('/dashboard');
      const banner = page.getByRole('region', { name: 'Notifications are off' });
      await expect(banner).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      // In the page's flow, under the header: it covers nothing.
      const [b, header] = await Promise.all([banner.boundingBox(), page.locator('header[class*="topBar"]').first().boundingBox()]);
      expect(b!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
      await shot(page, `notify-banner-${size.width}-${theme}`);
      // POLISH-2 (QA-E2E P1-10): after two refusals Android never asks again; the banner says so and opens Settings.
      await expect(banner).toContainText('won’t ask again');
      await banner.getByRole('button', { name: 'Open settings' }).click();
      await expect.poll(() => calls(page)).toContain('openNotificationSettings');
      await banner.getByRole('button', { name: 'Hide until tomorrow' }).click();
      await expect(banner).toHaveCount(0);
      await context.close();
    });
  }
  test('the 1.1.0 shell (no notificationsAsk) still gets the explanation when Android has never asked', async ({ browser }) => {
    const context = await browser.newContext({ viewport: PHONES[1], isMobile: true, hasTouch: true, userAgent: APP_UA.replace('1.1.2', '1.1.0'), extraHTTPHeaders: admin });
    await bridge(context, { info: { version: '1.1.0' }, permissions: { notifications: 'prompt' } });
    const page = await context.newPage();
    await page.goto('/dashboard');
    await expect(page.getByRole('dialog', { name: 'Let Pulse tell you when something needs you' })).toBeVisible();
    // Android back (Escape through the shell) is "Not now": the calm banner remains.
    expect(await page.evaluate(() => (window as unknown as { __pulseBack: () => boolean }).__pulseBack())).toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Notifications are off' })).toBeVisible();
    await context.close();
  });
});

test('the bell opens the notification panel on a phone, never the mail', async ({ browser }) => {
  for (const size of PHONES) {
    const context = await browser.newContext({ viewport: size, isMobile: true, hasTouch: true, userAgent: APP_UA, extraHTTPHeaders: admin });
    await context.addInitScript(() => { localStorage.setItem('pulse.notify.asked', '1'); localStorage.setItem('pulse.notify.later', new Date().toISOString().slice(0, 10)); });
    const page = await context.newPage();
    await page.goto('/dashboard');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(page.locator('#pulse-notices')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/dashboard');
    await page.waitForTimeout(600); // the sheet's rise has finished before the picture
    await expect(page.locator('#pulse-notices').getByRole('link', { name: 'All notifications' })).toHaveAttribute('href', '/notifications');
    await shot(page, `bell-panel-${size.width}`);
    await context.close();
  }
});

test.describe('a check-out forgotten yesterday', () => {
  for (const size of [{ width: 1440, height: 900 }, ...PHONES]) for (const theme of ['light', 'dark'] as const) {
    test(`the chip says so plainly and sends the time through the correction flow, ${size.width} ${theme}`, async ({ browser, request }) => {
      const self = await (await request.get('/api/v0/hr/self', { headers: admin })).json(); const person = self.person.id;
      const context = await browser.newContext({ viewport: size, colorScheme: theme, extraHTTPHeaders: admin });
      await context.addInitScript((t) => localStorage.setItem('pulse.theme', t), theme);
      // 04:25 in India on the 11th; checked in at 17:46 on the 10th and never out (the owner's phone, 11 Oct).
      const now = Date.parse('2026-10-10T22:55:00Z');
      const day = { ...demoPayload('in', now), demo: false, attendanceEnabled: true, person: { id: person, name: 'Synthetic Admin', firstName: 'Synthetic' }, today: '2026-10-11', utcOffsetMinutes: 330,
        now: new Date(now).toISOString(), shift: { start: '10:00', end: '19:00', graceMinutes: 15, onTimeBy: '10:15', workingDay: true, mode: 'office' }, state: 'in',
        entry: { id: 'synthetic-open-entry', date: '2026-10-10', in: '2026-10-10T12:16:00.000Z', out: null, mode: 'office', late: 0, onBreak: false, breakStartedAt: null, closedBreakSeconds: 0 } };
      let sent: Record<string, unknown> | null = null;
      await context.route('**/api/v0/companion', (route) => route.fulfill({ json: sent ? { ...day, entry: { ...day.entry, correctionPending: true } } : day }));
      await context.route('**/api/v0/hr/regularisations', async (route) => { sent = route.request().postDataJSON(); await route.fulfill({ json: { id: 'synthetic-correction', status: 'pending' } }); });
      const page = await context.newPage();
      await page.clock.setFixedTime(now);
      await page.goto('/dashboard');
      const chip = page.getByRole('button', { name: /Still checked in since yesterday 17:46\. Check out at the right time\?/ });
      await expect(chip).toBeVisible();
      await expect(chip).toContainText(size.width < 900 ? 'Check out?' : 'Since yesterday 17:46');
      await chip.click();
      const menu = page.getByRole('dialog', { name: 'Today’s attendance' });
      await expect(menu).toContainText('Still checked in since yesterday 17:46.');
      await expect(menu.getByLabel('I left at')).toHaveValue('19:00');
      await shot(page, `forgotten-${size.width}-${theme}`);
      await menu.getByRole('button', { name: 'Check out at 19:00' }).click();
      await expect.poll(() => sent).toMatchObject({ kind: 'missed_punch', date: '2026-10-10', entryId: 'synthetic-open-entry', outTime: '19:00' });
      await expect(page.getByRole('button', { name: /You sent the time you left/ })).toBeVisible();
      await context.close();
    });
  }
});

test('office arrival: two steps, Pulse explains "Allow all the time" with HR’s setting, declining keeps Wi-Fi', async ({ browser }) => {
  for (const theme of ['light', 'dark'] as const) for (const size of PHONES) {
    const context = await browser.newContext({ viewport: size, colorScheme: theme, isMobile: true, hasTouch: true, userAgent: APP_UA, extraHTTPHeaders: admin });
    await context.addInitScript((t) => localStorage.setItem('pulse.theme', t), theme);
    const office = { id: 'synthetic-office', name: 'Synthetic Studio', lat: 12.9, lng: 77.6, radius: 150, wifi: [] };
    await bridge(context, { info: { notifications: true, notificationsAsk: 'granted' }, presence: { enabled: true, auto: false, offices: [office], sites: [], arrival: { location: true, background: false } } });
    const page = await context.newPage();
    await page.goto('/dashboard');
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: 'Notice your arrival with Pulse closed' })).toBeVisible();
    await expect(sheet).toContainText('Synthetic Studio');
    await expect(sheet).toContainText('HR’s setting: Pulse asks “Check in?”');
    await expect(sheet).toContainText('never where you are');
    await expect(sheet).toContainText('choose “Allow all the time”');
    await shot(page, `arrival-step2-${size.width}-${theme}`);
    await sheet.getByRole('button', { name: 'Choose “Allow all the time”' }).click();
    await expect(sheet.getByRole('status')).toContainText('Pulse will notice when you reach Synthetic Studio');
    await expect(sheet.getByRole('heading', { name: 'Office arrival is on' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toHaveCount(0);
    await page.reload();
    await page.waitForTimeout(800);
    await expect(page.getByRole('dialog', { name: 'Notice your arrival with Pulse closed' }), 'asked once per phone').toHaveCount(0);
    await context.close();
  }
});

test.describe('chats on a phone: the open chat has its own header, and Android back returns to the list', () => {
  const at = (m: number) => new Date(Date.now() - m * 60000).toISOString();
  const group = { id: '33333333-3333-4333-8333-333333333333', name: 'Synthetic Leadership', kind: 'team', description: 'Your team', address: null, unread: 1, members: 6, lastAt: at(3), preview: 'Plan for Monday is in the doc', previewAuthor: 'Synthetic Rila' };
  const direct = { id: '44444444-4444-4444-8444-444444444444', name: 'Synthetic Rila', kind: 'direct', description: '', address: null, unread: 0, members: 2, lastAt: at(9), peerId: 'synthetic-rila', preview: 'See you at 10' };
  const msg = (id: string, channelId: string, authorId: string, name: string, body: string, m: number) => ({ id, channelId, authorId, name, username: null, body, parentId: null, createdAt: at(m), editedAt: null, removed: false, replies: 0, attachments: [], mentions: [], reactions: [], kind: 'text' });
  for (const size of PHONES) for (const theme of ['light', 'dark'] as const) {
    test(`${size.width} ${theme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: size, colorScheme: theme, isMobile: true, hasTouch: true, userAgent: APP_UA, extraHTTPHeaders: admin });
      await context.addInitScript((t) => localStorage.setItem('pulse.theme', t), theme);
      await bridge(context, { info: { notifications: true, notificationsAsk: 'granted' } });
      await context.route('**/api/v0/chats/events', (route) => route.abort());
      await context.route('**/api/v0/chats', (route) => route.fulfill({ json: { channels: [group, direct], viewer: 'synthetic-admin', canModerate: false, retentionDays: 365,
        people: [{ id: 'synthetic-admin', name: 'Synthetic Admin', username: 'admin' }, { id: 'synthetic-rila', name: 'Synthetic Rila', username: 'rila', team: 'Leadership' }] } }));
      await context.route(/\/api\/v0\/chats\/[0-9a-f-]+\/messages/, (route) => { const id = new URL(route.request().url()).pathname.split('/')[4];
        return route.fulfill({ json: { messages: [msg(`${id}-1`, id, 'synthetic-rila', 'Synthetic Rila', 'Plan for Monday is in the doc', 30), msg(`${id}-2`, id, 'synthetic-admin', 'Synthetic Admin', 'Thanks, reading it now', 3)], hasMore: false,
          members: [{ id: 'synthetic-admin', name: 'Synthetic Admin', username: 'admin' }, { id: 'synthetic-rila', name: 'Synthetic Rila', username: 'rila' }], formerMembers: [], receipts: { readThrough: null, deliveredThrough: null }, root: null } }); });
      await context.route(/\/api\/v0\/chats\/[0-9a-f-]+\/read/, (route) => route.fulfill({ json: { ok: true } }));
      await context.route(/\/api\/v0\/presence/, (route) => route.request().method() === 'GET' ? route.fulfill({ json: { people: { 'synthetic-rila': { state: 'office', text: 'Editing the launch reel', emoji: '🎬' } }, me: null } }) : route.fulfill({ json: { ok: true } }));
      const page = await context.newPage();
      await page.goto('/chats');
      await page.getByRole('button', { name: /Synthetic Leadership/ }).first().click();
      await expect(page).toHaveURL(new RegExp(`channel=${group.id}`));
      const back = page.getByRole('button', { name: 'Back to chats' });
      await expect(back).toBeVisible();
      const who = page.getByRole('button', { name: 'Synthetic Leadership: details and members' });
      await expect(who).toBeVisible();
      await expect(who).toContainText('6 members');
      // CHAT-SHELL v2 (22 Oct 2026): the quieter header's Details became the side panel's toggle.
      await expect(page.getByRole('button', { name: 'Show the side panel', exact: true })).toBeVisible();
      // The header sits in the top bar: nothing of the page title "Chats" above the conversation.
      const [bar, head] = await Promise.all([page.locator('header[class*="topBar"]').first().boundingBox(), who.boundingBox()]);
      expect(head!.y).toBeLessThan(bar!.y + bar!.height);
      await expect(page.getByRole('log', { name: 'Messages' })).toContainText('Thanks, reading it now');
      await page.waitForTimeout(300);
      await shot(page, `chat-header-${size.width}-${theme}`);
      // Android back (the shell asks the page first): back to the list, not out of Chats.
      expect(await page.evaluate(() => (window as unknown as { __pulseBack: () => boolean }).__pulseBack())).toBe(true);
      await expect(page).not.toHaveURL(/channel=/);
      await expect(page.getByRole('button', { name: /Synthetic Rila/ }).first()).toBeVisible();
      // A direct chat: the person's photo with their presence, and their status as the subtitle.
      await page.getByRole('button', { name: /Synthetic Rila/ }).first().click();
      const person = page.getByRole('button', { name: 'Synthetic Rila: details and members' });
      await expect(person).toBeVisible();
      await expect(person).toContainText('In the office');
      await shot(page, `chat-direct-${size.width}-${theme}`);
      expect(await page.evaluate(() => (window as unknown as { __pulseBack: () => boolean }).__pulseBack())).toBe(true);
      await expect(page).not.toHaveURL(/channel=/);
      await context.close();
    });
  }
});
