import { expect, test } from '@playwright/test';

test.describe('dashboard stale and failed sync label', () => {
  test.describe.configure({ mode: 'default' });
  test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'Uses the isolated synthetic API fixture');
  for (const width of [390, 1440]) for (const theme of ['light', 'dark'] as const) {
    test(`${width}px ${theme}: full phone warning and single-row desktop header`, async ({ browser }, testInfo) => {
      test.setTimeout(60_000);
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme,
        extraHTTPHeaders: { 'Cf-Access-Authenticated-User-Email': 'admin@estateautopilots.com' },
      });
      try {
        await context.addInitScript((value) => localStorage.setItem('pulse.theme', value), theme);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        // The freshness label remains on the deeper overview after Max moves to the calm home.
        await page.goto('/dashboard?mode=max&tab=overview&week=2025-W05');
        // The shell also measures a detached header clone; exercise only the live page.
        const header = page.locator('#main-content [data-page-header]');
        const title = header.getByRole('heading', { name: 'Dashboard', exact: true });
        const freshness = header.locator('button[title*="Last successful sync"]');
        const label = freshness.locator('span').nth(1);
        const warning = /^Synced \d+ days ago · last run failed · Data is stale · over 24 hours since sync$/;
        await expect(title).toBeVisible();
        await expect(label).toHaveText(warning);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => {
          const button = document.querySelector('#main-content button[title*="Last successful sync"]');
          return button && Object.keys(button).some((key) => key.startsWith('__reactProps'));
        });
        const geometry = await header.evaluate((el) => {
          const box = (node: Element) => {
            const r = node.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
          };
          const button = el.querySelector<HTMLButtonElement>('button[title*="Last successful sync"]')!;
          const text = button.children[1] as HTMLElement;
          return { viewport: innerWidth, scroll: document.scrollingElement!.scrollWidth,
            header: box(el), title: box(el.querySelector('h2')!), context: box(button.parentElement!),
            button: box(button), label: box(text), labelScroll: text.scrollWidth, labelClient: text.clientWidth,
            labelScrollHeight: text.scrollHeight, labelClientHeight: text.clientHeight,
            wrap: getComputedStyle(el).flexWrap, buttonWhiteSpace: getComputedStyle(button).whiteSpace };
        });
        console.log(JSON.stringify({ width, theme, ...geometry }));
        await testInfo.attach('header-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        expect(geometry.scroll).toBeLessThanOrEqual(width);
        if (width === 390) {
          await expect(freshness).toBeVisible();
          await expect(header.getByText('All company accounts', { exact: true })).toBeVisible();
          for (const box of [geometry.header, geometry.title, geometry.context, geometry.button, geometry.label]) {
            expect(box.left).toBeGreaterThanOrEqual(0);
            expect(box.right).toBeLessThanOrEqual(width);
            expect(box.top).toBeGreaterThanOrEqual(0);
            expect(box.bottom).toBeLessThanOrEqual(844);
          }
          expect(geometry.labelScroll).toBeLessThanOrEqual(geometry.labelClient);
          expect(geometry.labelScrollHeight).toBeLessThanOrEqual(geometry.labelClientHeight);
          expect(geometry.label.top).toBeGreaterThanOrEqual(geometry.button.top);
          expect(geometry.label.bottom).toBeLessThanOrEqual(geometry.button.bottom);
          expect(geometry.button.height).toBeGreaterThanOrEqual(32);
          const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === '/dashboard' && r.request().headers()['rsc'] === '1');
          await freshness.click();
          expect((await refreshed).ok()).toBe(true);
          await expect(label).toHaveText(warning);
        } else {
          expect(geometry.wrap).toBe('nowrap');
          // Owner workbench (21 Oct 2026): the header lives in the page (a large title over one quiet context line, its
          // actions on the right), no longer squeezed into the 48 px top bar: still one row, about 53 px tall.
          expect(geometry.header.height).toBeLessThanOrEqual(geometry.title.height + geometry.context.height + 4);
          expect(geometry.buttonWhiteSpace).toBe('nowrap');
          const actions = await header.locator('[data-hscroll]').boundingBox();
          expect(actions).not.toBeNull();
          for (const box of [geometry.title, geometry.context, { top: actions!.y, bottom: actions!.y + actions!.height }]) {
            expect(box.top).toBeGreaterThanOrEqual(geometry.header.top);
            expect(box.bottom).toBeLessThanOrEqual(geometry.header.bottom);
          }
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
