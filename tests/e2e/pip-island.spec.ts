import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { demoPayload } from '../../packages/companion/src/demo.js';

// RELEASE-2 (owner, 11 Oct 2026): "the character top Dynamic Island … is not working all the time when clicked or
// hovered". Pip's island must answer every time: a mouse resting on Pip shows today's summary, a click or a tap opens
// Pip's menu, a long-press too, and the keyboard reaches it. Each loop runs 50 times in a row on the production build,
// with real pointer input, and checks that what opened is on top (nothing covers it) — not just in the DOM.

const channel = '11111111-1111-4111-8111-111111111111';
const href = `/chats?channel=${channel}`;
const N = 50;

/** SHIP-4 (25 Oct): VISIBLE's Home panels (leadership's cards, "New in Pulse") reach Pip's corners, where Pip steps aside
 *  from their buttons or turns into the slim tab over their words, as designed, and fill the page with links. These specs
 *  test Pip, so they keep the Home they were written against: the panels are hidden before the page's own scripts run. */
const withoutHomePanels = (context: BrowserContext) => context.addInitScript(() => {
  const add = () => { if (!document.head) return false; const s = document.createElement('style'); s.textContent = '[data-lead-pulse], [data-whats-new] { display: none !important; }'; document.head.append(s); return true; };
  if (!add()) new MutationObserver((_, seen) => { if (add()) seen.disconnect(); }).observe(document, { childList: true, subtree: true });
});

async function wire(context: BrowserContext) {
  await withoutHomePanels(context);
  const at = () => new Date().toISOString();
  const settings = { dnd: false, quiet: false, start: '21:00', end: '08:00', timezone: 'UTC', types: {} };
  const cards = [{ id: channel, ids: [channel], kind: 'chat', eventType: 'chat.message', title: 'Synthetic colleague wrote in Leadership', body: 'Can we review the plan?', href, at: at(), readAt: null,
    active: true, state: 'open', group: 'update', unread: 1, channelId: channel, from: { id: '22222222-2222-4222-8222-222222222222', name: 'Synthetic colleague', photoAt: null },
    subject: { type: 'chat', id: channel, title: 'Leadership' }, open: { label: 'Open chat', href }, actions: [] }];
  await context.route('**/api/v0/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v0/', '');
    let data: unknown;
    if (path === 'companion') data = demoPayload('in', Date.now());
    else if (path === 'companion/updates') data = { person: { id: 'synthetic-admin', name: 'Synthetic Admin' }, settings, suppression: null, rows: [], counts: { chats: 1, inbox: 0, total: 1 }, cursor: at(), hasMore: false, page: null };
    else if (path === 'companion/notification-settings') data = { settings, webPushKey: null };
    else if (path === 'notices') data = { rows: cards, counts: { unread: 1, action: 0, mention: 0, update: 1 }, dnd: false, today: { due: 2, overdue: 0 } };
    else if (path === 'notices/read') data = { ok: true };
    else { await route.continue(); return; }
    await route.fulfill({ json: data });
  });
}

type Look = { pip: { x: number; y: number } | null; pipOnTop: string | null; tip: string | null; menu: string | null; menuFocus: boolean; pipFocused: boolean; islands: number };
/** What a person sees: Pip, the summary and the menu, each checked for being on top at several points. */
const look = (page: Page) => page.evaluate((): Look => {
  const islands = document.querySelectorAll('[data-island]');
  const island = islands[0] as HTMLElement | undefined;
  const pip = island?.querySelector<HTMLElement>('[data-pip]');
  const covered = (box: HTMLElement | null | undefined) => {
    if (!box) return 'missing';
    const before = box.style.pointerEvents; box.style.pointerEvents = 'auto';
    const r = box.getBoundingClientRect();
    const pts = [[r.left + r.width / 2, r.top + 10], [r.left + 10, r.top + r.height / 2], [r.right - 10, r.bottom - 10], [r.left + r.width / 2, r.top + r.height / 2]];
    const hit = pts.map(([x, y]) => document.elementFromPoint(x, y)).find((h) => !h || !box.contains(h));
    box.style.pointerEvents = before;
    if (r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1) return 'outside the window';
    return hit === undefined ? null : hit ? `covered by ${hit.tagName.toLowerCase()}.${String(hit.getAttribute('class') ?? '').split(' ')[0]}` : 'covered';
  };
  const r = pip?.getBoundingClientRect();
  const top = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  const tip = island?.querySelector<HTMLElement>('[role=tooltip]'), menu = island?.querySelector<HTMLElement>('[role=menu]');
  return {
    islands: islands.length, pip: r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null,
    pipOnTop: !pip ? 'missing' : top && pip.contains(top) ? null : `covered by ${top?.tagName.toLowerCase()}.${String(top?.getAttribute('class') ?? '').split(' ')[0]}`,
    // Owner workbench (21 Oct 2026): a floating Pip's menu is a ring of buttons around it; its own box is only their
    // anchor, so each button must be on top instead.
    tip: tip ? covered(tip) : 'missing',
    menu: !menu ? 'missing' : menu.getBoundingClientRect().width > 4 ? covered(menu) : [...menu.querySelectorAll<HTMLElement>('[role^=menuitem]')].map(covered).find((x) => x !== null) ?? null,
    menuFocus: !!menu?.contains(document.activeElement), pipFocused: document.activeElement === pip,
  };
});
const until = async (page: Page, ok: (l: Look) => boolean, ms = 1500) => { const end = Date.now() + ms; let l = await look(page); while (!ok(l) && Date.now() < end) { await page.waitForTimeout(25); l = await look(page); } return l; };

async function open(page: Page, path = '/dashboard') {
  await page.goto(path);
  // Hydrated: React has attached its handlers to Pip's button.
  await page.waitForFunction(() => { const b = document.querySelector('[data-island] [data-pip]'); return !!b && Object.keys(b).some((k) => k.startsWith('__reactProps')); });
  await page.waitForTimeout(300);
}

/** Hover → summary, click/tap → menu, and back to rest; `i` turns the way the menu is closed. */
async function round(page: Page, i: number, input: 'mouse' | 'touch', label: string, hover = i % 2 === 0) {
  const press = async (x: number, y: number) => input === 'touch' ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
  // "Away" is a spot in the page with nothing to press under it (a click there must not open a card or a link).
  const away = await page.evaluate(() => {
    const m = document.querySelector('main')!.getBoundingClientRect();
    // FLOAT: away from the page's edges, where the sidebar's panel (and its workspace switcher, which a press at
    // 12 px into the page once opened) can reach over the page.
    for (let y = m.top + Math.min(160, m.height / 4); y < Math.min(m.bottom, innerHeight - 90); y += 23) for (let x = m.left + Math.min(160, m.width / 4); x < m.right - 120; x += 37) {
      const e = document.elementFromPoint(x, y);
      if (e && !e.closest('a, button, input, select, textarea, label, summary, aside, nav, header, [role=button], [role=link], [role=tab], [role=menu], [role=dialog], [tabindex], [contenteditable], [data-island]')) return { x, y };
    }
    return { x: m.left + 4, y: m.top + 4 };
  });
  // Something may arrive meanwhile (the app's own notices too): the island shows it instead; it is dismissed first.
  if (await page.locator('[data-island][data-open]').count()) { await page.locator('[data-island]').getByRole('button', { name: 'Dismiss' }).click(); await page.waitForTimeout(800); }
  let l = await until(page, (x) => x.pip !== null && x.pipOnTop === null);
  expect(l.islands, `${label} #${i}: one island`).toBe(1);
  expect(l.pipOnTop, `${label} #${i}: Pip is on top`).toBeNull();
  if (input === 'mouse') {
    await page.mouse.move(away.x, away.y);
    l = await until(page, (x) => x.tip === 'missing');
    expect(l.tip, `${label} #${i}: the summary goes when the pointer leaves`).toBe('missing');
    // Without `hover` the pointer arrives and presses at once, from elsewhere on the page: the click that the redrawn
    // face used to swallow. With it, the pointer rests on Pip first and the summary must show.
    if (hover) {
      await page.mouse.move(l.pip!.x, l.pip!.y, { steps: 3 });
      l = await until(page, (x) => x.tip === null);
      expect(l.tip, `${label} #${i}: hover shows today's summary, on top`).toBeNull();
    }
  }
  await press(l.pip!.x, l.pip!.y);
  l = await until(page, (x) => x.menu === null);
  expect(l.menu, `${label} #${i}: ${input === 'touch' ? 'a tap' : 'a click'} opens Pip's menu, on top`).toBeNull();
  if (input === 'touch') expect(l.tip, `${label} #${i}: no hover-only summary on touch`).toBe('missing');
  const how = (['pip', 'escape', 'outside'] as const)[i % 3];
  if (how === 'pip') await press(l.pip!.x, l.pip!.y);
  else if (how === 'escape') await page.keyboard.press('Escape');
  else await press(away.x, away.y);
  l = await until(page, (x) => x.menu === 'missing');
  expect(l.menu, `${label} #${i}: the menu closes (${how})`).toBe('missing');
}

test.describe('Pip island on a computer', () => {
  test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'synthetic notices on the isolated test server');
  // 768: a narrow window with a mouse still gets the summary (it used to be cut off below 900 px).
  for (const width of [1440, 1024, 768]) {
    test(`hover shows the summary and a click opens the menu, ${N} times each in a row at ${width}`, async ({ page, context }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width, height: 900 });
      await context.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': 'admin@estateautopilots.com' });
      await wire(context);
      const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
      await open(page);
      for (let i = 0; i < N; i++) await round(page, i, 'mouse', `${width} hover and click`, true);
      for (let i = 0; i < N; i++) await round(page, i, 'mouse', `${width} straight click`, false);
      // A quick pass over Pip does not open the summary (hover intent), and a click straight away never shows it.
      await page.mouse.move(10, 400);
      const l = await look(page);
      await page.mouse.move(l.pip!.x, l.pip!.y); await page.mouse.move(10, 400, { steps: 2 });
      await page.waitForTimeout(400);
      expect((await look(page)).tip).toBe('missing');
      expect(errors).toEqual([]);
    });
  }

  test('after client-side navigation, with the bell panel open or just closed, and by keyboard', async ({ page, context }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await context.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': 'admin@estateautopilots.com' });
    await wire(context);
    await open(page);
    // Client-side navigation through the rail (the page is not reloaded), then Pip at once.
    await page.evaluate(() => { (window as unknown as { __stay: boolean }).__stay = true; });
    // Owner workbench (21 Oct 2026): the rail holds sections; a section's other pages are in the panel beside it.
    const rail = page.getByRole('navigation', { name: 'Main sections' });
    const steps: [string, string | null][] = [['Work', null], ['Chats', null], ['People', null], ['Home', 'My desk'], ['Money', null], ['Home', 'Dashboard'],
      ['Clients', null], ['People', 'HR desk'], ['People', 'Leadership'], ['Home', 'Dashboard']];
    for (const [i, [section, name]] of steps.entries()) {
      if (name) {
        await rail.getByRole('link', { name: section, exact: true }).hover();
        await page.getByRole('navigation', { name: `${section} pages`, exact: true }).getByRole('link', { name, exact: true }).click();
      } else await rail.getByRole('link', { name: section, exact: true }).click();
      await expect(rail.getByRole('link', { name: section, exact: true })).toHaveAttribute('aria-current', 'page');
      await round(page, i, 'mouse', `after navigating to ${name ?? section}`);
    }
    expect(await page.evaluate(() => (window as unknown as { __stay?: boolean }).__stay)).toBe(true);
    // The bell panel: Pip still opens its menu while it is open, and right after it closes.
    const bell = page.locator('header button[aria-haspopup="dialog"][aria-label^="Notifications"]');
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    for (let i = 0; i < 6; i++) {
      await bell.click();
      await expect(panel).toBeVisible();
      if (i % 2 === 0) {
        const l = await look(page);
        expect(l.pipOnTop, 'panel open: Pip is on top').toBeNull();
        await page.mouse.click(l.pip!.x, l.pip!.y);
        expect((await until(page, (x) => x.menu === null)).menu, 'panel open: a click on Pip opens its menu').toBeNull();
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
        continue;
      }
      if (i === 1) await page.keyboard.press('Escape'); else await panel.getByRole('button', { name: 'Close notifications' }).click();
      await expect(panel).toHaveCount(0);
      await round(page, i, 'mouse', 'right after the panel closed');
    }
    // Keyboard: Tab reaches Pip; Enter and Space open the menu with focus inside; Escape closes it and returns focus.
    await open(page);
    await page.locator('body').focus();
    for (let n = 0; n < 60 && !(await look(page)).pipFocused; n++) await page.keyboard.press('Tab');
    expect((await look(page)).pipFocused, 'Tab reaches Pip').toBe(true);
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press(i % 2 ? 'Space' : 'Enter');
      const l = await until(page, (x) => x.menu === null && x.menuFocus);
      expect(l.menu, `keyboard #${i}: the menu opens`).toBeNull();
      expect(l.menuFocus, `keyboard #${i}: focus moves into the menu`).toBe(true);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Escape');
      const back = await until(page, (x) => x.menu === 'missing' && x.pipFocused);
      expect(back.pipFocused, `keyboard #${i}: Escape returns focus to Pip`).toBe(true);
    }
  });

  test('reduced motion and an arrival opening do not stop Pip', async ({ browser }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'Cf-Access-Authenticated-User-Email': 'admin@estateautopilots.com' } });
    await wire(context);
    const page = await context.newPage();
    await open(page);
    for (let i = 0; i < 20; i++) await round(page, i, 'mouse', 'reduced motion');
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(700, 600);
      await page.evaluate((k) => window.dispatchEvent(new CustomEvent('pulse:arrival', { detail: { id: `arrival-${k}`, title: `Synthetic arrival ${k}`, href: '/me', kind: 'chat' } })), i);
      await expect(page.locator('[data-island][data-open]')).toHaveCount(1);
      // Settled back (dismissed), Pip answers straight away.
      await page.locator('[data-island]').getByRole('button', { name: 'Dismiss' }).click();
      await expect(page.locator('[data-island][data-open]')).toHaveCount(0);
      await round(page, i, 'mouse', 'right after an arrival');
    }
    await context.close();
  });
});

test.describe('Pip island on a phone', () => {
  test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'synthetic notices on the isolated test server');
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test(`a tap opens the menu ${N} times in a row; a long-press opens it too; never the hover summary`, async ({ page, context }) => {
    test.setTimeout(240_000);
    await context.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': 'admin@estateautopilots.com' });
    await wire(context);
    await open(page);
    for (let i = 0; i < N; i++) await round(page, i, 'touch', '390 tap');
    const cdp = await context.newCDPSession(page);
    for (let i = 0; i < 5; i++) {
      const l = await look(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: l.pip!.x, y: l.pip!.y }] });
      await page.waitForTimeout(900);
      expect((await look(page)).tip, 'no summary during a long-press').toBe('missing');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      expect((await until(page, (x) => x.menu === null)).menu, `long-press #${i} opens the menu`).toBeNull();
      await page.keyboard.press('Escape');
      await until(page, (x) => x.menu === 'missing');
    }
  });
});

// POLISH-2 (QA-E2E P1-4): Pip's island sat over the header's check-in chip on 3–7 of ~20 page views (fully at 390 px
// once). It measured its slot when the page loaded, before the day arrived and the chip appeared beside it, and never
// again. The chip now comes late (the day answer is slow) and changes width ("Check in" → "0:32"); the island must
// move with it every time.
test.describe('Pip island and the check-in chip', () => {
  test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'synthetic notices on the isolated test server');
  for (const [width, phone] of [[390, true], [1024, false], [1440, false]] as const) {
    test(`the island never covers the check-in chip at ${width}`, async ({ browser }) => {
      const context = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL, viewport: { width, height: phone ? 844 : 900 }, hasTouch: phone, isMobile: phone,
        extraHTTPHeaders: { 'Cf-Access-Authenticated-User-Email': 'admin@estateautopilots.com' } });
      await wire(context);
      // Pip put back in the top bar (its menu: "Put Pip in the top bar"); floating free by default, it keeps clear of the
      // top bar altogether.
      await context.addInitScript(() => localStorage.setItem('pulse.pip.dock', '1'));
      // The chip shows the signed-in person's own day only.
      const me = await (await context.request.get('/api/v0/me')).json() as { person: string; name: string };
      let state: 'out' | 'in' = 'out';
      // The day answer arrives late: the chip appears after the island has been placed.
      await context.route('**/api/v0/companion', async (route) => { await new Promise((r) => setTimeout(r, 1500));
        await route.fulfill({ json: { ...demoPayload(state, Date.now()), attendanceEnabled: true, person: { id: me.person, name: me.name, firstName: me.name.split(' ')[0] } } }); });
      const page = await context.newPage();
      await open(page);
      // At rest: an arrival opening the island across a phone's bar covers it for a few seconds by design.
      const overlap = () => page.evaluate(() => {
        if (document.querySelector('[data-island][data-open]')) return -1;
        const chip = document.querySelector('button[data-state][data-tone]')?.parentElement?.getBoundingClientRect();
        const pill = document.querySelector('[data-island] [data-pip]')?.getBoundingClientRect();
        if (!chip || !pill) return null;
        return Math.max(0, Math.min(chip.right, pill.right) - Math.max(chip.left, pill.left)) * Math.max(0, Math.min(chip.bottom, pill.bottom) - Math.max(chip.top, pill.top));
      });
      await expect.poll(overlap, { timeout: 10_000 }).not.toBeNull();
      await expect.poll(overlap, { timeout: 12_000, message: 'after the chip appeared' }).toBe(0);
      state = 'in';
      await page.evaluate(() => window.dispatchEvent(new Event('pulse:attendance')));
      await expect(page.locator('button[data-state][data-tone]:not([data-state="out"])').first()).toBeVisible({ timeout: 10_000 });
      await expect.poll(overlap, { timeout: 12_000, message: 'after the chip changed width' }).toBe(0);
      await context.close();
    });
  }
});
