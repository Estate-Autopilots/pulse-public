// J10 "Money in" (TOP-JOURNEYS): the browser journey on a running Pulse (pulse-dev by default), on a phone viewport:
//  1. Finance adds an expense with a receipt photo (the "Take photo" input) → the entry is listed and is in the totals
//     (the Entries tile and the live model's costs for its month, GET /api/v0/finance/live → model.manual);
//  2. the quick-add line "₹5,000 Facebook ads 14 Apr from HDFC" → what Pulse understood → the form filled in → saved;
//  3. a "Found in WhatsApp" payment screenshot → Confirm as entry → saved, the card leaves the list.
// Every entry it made is deleted again at the end (with a reason; the history keeps it), which also puts the screenshot
// back among the suggestions. Records a video.
//   PULSE_BASE=http://127.0.0.1:3200 PULSE_AS=user-668d21b6@estateautopilots.com PULSE_JOURNEY_DIR=~/ea-research/ux/journeys/J10 \
//   PLAYWRIGHT=<path to playwright/index.js> node services/api/test/fin-entry-journey.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? 'playwright');
const sharp = require('sharp');
const base = process.env.PULSE_BASE ?? 'http://127.0.0.1:3200', as = process.env.PULSE_AS ?? 'user-668d21b6@estateautopilots.com';
const dir = process.env.PULSE_JOURNEY_DIR ?? join(tmpdir(), 'j10'); await mkdir(dir, { recursive: true });
const headers = { 'cf-access-authenticated-user-email': as };
const api = async (path, body) => { const r = await fetch(`${base}/api/v0/${path}`, body === undefined ? { headers } : { method: 'POST', headers: { ...headers, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path}: ${r.status} ${d.error ?? ''}`); return d; };
const moneyOut = async () => (await api('finance/live')).model?.manual?.moneyOut ?? 0;
const receipt = join(dir, 'receipt.jpg');
await writeFile(receipt, await sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 246, g: 244, b: 238 } } })
 .composite([{ input: Buffer.from('<svg width="600" height="900"><text x="40" y="120" font-size="48" font-family="sans-serif">CAB RECEIPT</text><text x="40" y="220" font-size="64" font-family="sans-serif">Rs 1,234.00</text><text x="40" y="320" font-size="32" font-family="sans-serif">J10 journey (synthetic)</text></svg>'), top: 0, left: 0 }]).jpeg().toBuffer());

const made = [], results = [], errors = [], pageErrors = [];
const step = (name) => { results.push(name); console.log('✓', name); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, extraHTTPHeaders: headers, recordVideo: { dir, size: { width: 390, height: 844 } } });
const page = await ctx.newPage(); page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
const ready = async () => { await page.waitForSelector('form[aria-label="Quick add"]', { timeout: 120000 }); await page.waitForTimeout(800); };
const saved = () => page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/v0\/finance\/entries$/.test(new URL(r.url()).pathname), { timeout: 30000 });
let ok = false;
try {
 const before = await moneyOut();
 await page.goto(`${base}/finance?tab=entries`, { waitUntil: 'load', timeout: 180000 }); await ready();
 await page.screenshot({ path: join(dir, '1-entries.png') });
 // 1. Expense with a receipt photo, as on the phone.
 await page.getByRole('button', { name: 'Add entry' }).first().click();
 await page.getByRole('dialog').getByText('Amount (₹, with GST)').waitFor();
 await page.getByLabel('Amount (₹, with GST)').fill('1234');
 await page.getByLabel('Category').fill('Travel');
 await page.getByLabel('Vendor / paid to').fill('J10 cab (journey test)');
 await page.getByLabel('Paid from').fill('Company card');
 await page.locator('input[type=file][capture]').setInputFiles(receipt);
 await page.getByRole('dialog').locator('img').first().waitFor();
 await page.screenshot({ path: join(dir, '2-expense-with-photo.png') });
 let wait = saved(); await page.getByRole('button', { name: 'Save entry' }).click(); let e = await (await wait).json(); made.push(e.id);
 assert.equal(e.amountMinor, 123400); assert.equal(e.files.length, 1, 'the receipt photo is attached');
 await page.getByText('J10 cab (journey test)').first().waitFor();
 assert.equal(Math.round((await moneyOut()) - before), 1234, 'the expense is in the live totals');
 await page.screenshot({ path: join(dir, '3-in-the-list.png') });
 step('expense with a receipt photo → listed and in the totals');
 // 2. The quick-add line.
 const line = page.getByLabel('Quick add in one line');
 await line.fill('₹5,000 Facebook ads 14 Apr from HDFC');
 await page.locator('[aria-live="polite"]').getByText('HDFC current').waitFor();
 await page.screenshot({ path: join(dir, '4-quick-understood.png') });
 await page.getByRole('button', { name: 'Review' }).click();
 assert.equal(await page.getByLabel('Amount (₹, with GST)').inputValue(), '5000');
 assert.equal(await page.getByLabel('Paid from').inputValue(), 'HDFC current');
 assert.equal(await page.getByLabel('Category').inputValue(), 'Ad spend');
 wait = saved(); await page.getByRole('button', { name: 'Save entry' }).click(); e = await (await wait).json(); made.push(e.id);
 assert.equal(e.date.slice(5), '04-14'); assert.equal(e.amountMinor, 500000);
 assert.equal(Math.round((await moneyOut()) - before), 6234);
 step('quick-add line → form filled in → saved and counted');
 // 3. A payment screenshot from WhatsApp.
 await page.goto(`${base}/finance?tab=entries&entriesPage=Found+in+WhatsApp`, { waitUntil: 'load' }); await ready();
 const card = page.locator('article').filter({ has: page.getByRole('button', { name: 'Confirm as entry' }) }).first();
 await card.waitFor({ timeout: 60000 });
 await page.screenshot({ path: join(dir, '5-found-in-whatsapp.png') });
 await card.getByRole('button', { name: 'Confirm as entry' }).click();
 await page.getByRole('dialog').getByText('Found in WhatsApp').first().waitFor();
 await page.screenshot({ path: join(dir, '6-confirm.png') });
 wait = saved(); await page.getByRole('button', { name: /Save entry|Send for approval/ }).click(); e = await (await wait).json(); made.push(e.id);
 assert.equal(e.source, 'whatsapp');
 await page.waitForTimeout(1200);
 await page.screenshot({ path: join(dir, '7-confirmed.png') });
 step('WhatsApp payment screenshot → confirm → entry');
 ok = true;
} catch (x) { errors.push(String(x?.message ?? x).slice(0, 400)); await page.screenshot({ path: join(dir, 'failure.png') }).catch(() => {}); }
finally {
 for (const id of made) await api(`finance/entries/${id}/delete`, { reason: 'J10 journey test entry' }).catch((x) => errors.push(String(x)));
 await ctx.close(); await browser.close();
 const video = (await readdir(dir)).find((f) => f.endsWith('.webm') && !f.startsWith('J10'));
 if (video) await rename(join(dir, video), join(dir, `J10-money-in-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.webm`));
 await writeFile(join(dir, 'result.json'), JSON.stringify({ ok, steps: results, errors, pageErrors, base, at: new Date().toISOString() }, null, 1));
 console.log(JSON.stringify({ ok, steps: results.length, errors, pageErrors }));
 process.exit(ok && !errors.length ? 0 : 1);
}
