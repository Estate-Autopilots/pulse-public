import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
// EST-1237: an approved quotation is shared from a phone and converted once. The share sheet is the browser's own
// (navigator.share with a file), stubbed here so the check runs headless; the real phone check is recorded on the card.
// Synthetic API only (tests/e2e/fixtures/billing-review.mjs).
test.use({ extraHTTPHeaders: { 'Cf-Access-Authenticated-User-Email': 'admin@billing-one.example' }, reducedMotion: 'reduce' });
test.skip(!!process.env.PULSE_REAL_SMOKE, 'Synthetic API only');
const url = '/erp/documents/synthetic-issued', log = '/api/v0/erp/documents/synthetic-issued/test-log';
type Log = { marks: string[]; made: number; status: string };
type Probe = { __shares: { name: string; type: string }[]; __active: boolean[]; __opened: string[]; __cancel: boolean };
const read = async (page: Page): Promise<Log> => (await page.request.get(log)).json();
const probe = <K extends keyof Probe>(page: Page, key: K) => page.evaluate((k) => (window as unknown as Probe)[k], key);

async function open(page: Page, share: 'files' | 'cancel' | 'none') {
  await page.addInitScript((mode) => {
    const w = window as unknown as Probe;
    w.__shares = []; w.__active = []; w.__opened = []; w.__cancel = mode === 'cancel';
    window.open = ((u?: string | URL) => { w.__opened.push(String(u)); return null; }) as typeof window.open;
    if (mode === 'none') { Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true }); return; }
    Object.defineProperty(navigator, 'canShare', { value: (d?: ShareData) => !!d?.files?.length, configurable: true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: ShareData) => {
      const f = d.files![0]; w.__shares.push({ name: f.name, type: f.type }); w.__active.push(navigator.userActivation.isActive);
      if (w.__cancel) throw new DOMException('Share cancelled', 'AbortError');
    } });
  }, share);
  await expect(await page.request.post('/api/v0/erp/test-reset', { headers: { Origin: process.env.PLAYWRIGHT_TEST_BASE_URL! } })).toBeOK();
  await page.goto(url);
  await expect(page.getByRole('heading', { name: /SYN-Q-0001/ })).toBeVisible();
}
const send = (page: Page) => page.getByRole('button', { name: 'Send on WhatsApp', exact: true });
const markSent = (page: Page) => page.getByRole('button', { name: 'Mark sent', exact: true });

test('a cancelled share sheet sends nothing; a finished one still waits for an explicit Mark sent', async ({ page }) => {
  await open(page, 'cancel');
  await send(page).click();
  await expect.poll(() => probe(page, '__shares')).toEqual([{ name: 'SYN-Q-0001.pdf', type: 'application/pdf' }]);
  await expect(send(page)).toBeVisible();
  await expect(markSent(page)).toHaveCount(0);
  expect((await read(page)).marks).toEqual([]);

  await page.evaluate(() => { (window as unknown as Probe).__cancel = false; });
  await send(page).click();
  await expect.poll(async () => (await probe(page, '__shares')).length).toBe(2);
  await expect(markSent(page)).toBeVisible();
  expect((await read(page)).marks, 'sharing is not sending').toEqual([]);
  await markSent(page).click();
  await expect.poll(async () => (await read(page)).marks).toEqual(['sent']);
});

test('without file sharing the PDF downloads with instructions, and WhatsApp opens only on a tap', async ({ page }) => {
  await open(page, 'none');
  const download = page.waitForEvent('download');
  await send(page).click();
  expect((await download).suggestedFilename()).toBe('SYN-Q-0001.pdf');
  const panel = page.getByRole('region', { name: 'Share it yourself' });
  await expect(panel.getByText('The PDF is downloaded.')).toBeVisible();
  expect(await probe(page, '__opened')).toEqual([]);
  expect((await read(page)).marks).toEqual([]);
  const out = process.env.PULSE_BILLING_SCREENSHOTS;
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (out) { await mkdir(out, { recursive: true }); await page.screenshot({ path: join(out, `quote-share-manual-${width}-${theme}.png`) }); }
  }
  await panel.getByRole('button', { name: 'Open WhatsApp', exact: true }).click();
  await expect.poll(() => probe(page, '__opened')).toHaveLength(1);
  const opened = new URL((await probe(page, '__opened'))[0]);
  expect(opened.origin + opened.pathname).toBe('https://wa.me/919999900001');
  expect(opened.searchParams.get('text')).toContain('https://pulse.example.com/accept/synthetic');
  expect((await read(page)).marks, 'opening WhatsApp is not sending either').toEqual([]);
});

// EST-2101: a one-page PDF, so the preview draws (data-drawn) once the page holds the file.
function tinyPdf() {
  const objects = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>'];
  let out = '%PDF-1.4\n'; const at: number[] = [];
  objects.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj${o}endobj\n`; });
  const xref = out.length;
  return out + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`
    + `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
}

test('with the PDF 6 s away, the tap shares the copy the page already holds, inside the tap (EST-2101)', async ({ page }) => {
  // The real-OS probe on EST-1966: Chrome and Safari refused a share that waited ~6 s for the PDF after the tap.
  const asked: string[] = [];
  await page.route(/\/api\/v0\/erp\/documents\/synthetic-issued\/pdf(\?|$)/, async (route) => {
    asked.push(route.request().url());
    await new Promise((done) => setTimeout(done, 6000));
    await route.fulfill({ body: tinyPdf(), contentType: 'application/pdf' });
  });
  await open(page, 'files');
  await expect(page.locator('[data-drawn="1"]')).toBeVisible({ timeout: 15_000 });
  const before = asked.length;
  await send(page).click();
  await expect.poll(() => probe(page, '__shares'), { timeout: 1500 }).toEqual([{ name: 'SYN-Q-0001.pdf', type: 'application/pdf' }]);
  expect(await probe(page, '__active'), 'shared while the tap still counts').toEqual([true]);
  expect(asked.length, 'no PDF request after the tap').toBe(before);
  await expect(markSent(page)).toBeVisible();
  expect((await read(page)).marks, 'sharing is not sending').toEqual([]);
});

test('a conversion runs once, even when the next step is tapped again from the menu', async ({ page }) => {
  await open(page, 'files');
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Customer accepted', exact: true }).click();
  const make = page.getByRole('button', { name: 'Make proforma', exact: true });
  await expect(make).toBeVisible();
  await make.click();
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Make tax invoice', exact: true }).click();
  await page.waitForURL('**/erp/documents/synthetic-review');
  expect((await read(page)).made).toBe(1);
});
