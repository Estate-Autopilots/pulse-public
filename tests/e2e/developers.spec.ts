import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const token = 'psvc_00000000-0000-4000-8000-000000000001_' + 'a'.repeat(43);
const spec = { openapi: '3.1.0', info: { version: '1.0.0' }, paths: {
  '/api/v1/tasks': { get: { summary: 'List synthetic tasks', security: [{ bearer: ['tasks.read'] }], parameters: [{ name: 'limit', in: 'query' }] }, post: { summary: 'Create synthetic task', security: [{ bearer: ['tasks.write'] }] } },
  '/api/v1/catalog/items': { $ref: './service.yaml#/paths/example' }, '/api/v1/operator/keys': { get: {} },
} };
test('slow first-write reference survives initial pageshow and clears private data on a cached restore', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/openapi.json', async route => {
    await delayed;
    await route.fulfill({ json: { ...spec, paths: { '/api/v1/tasks': { post: spec.paths['/api/v1/tasks'].post } } } });
  });
  const loading = page.waitForRequest('**/api/v1/openapi.json');
  await page.goto('/developers', { waitUntil: 'domcontentloaded' });
  await loading;
  await expect(page.getByLabel('Reference loading')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })));
  await expect(page.getByRole('status')).toContainText('Loading the live reference');
  release();
  await expect(page.getByRole('status')).toContainText('Reference ready');
  await expect(page.getByLabel('Idempotency key', { exact: true })).toHaveValue(/^[0-9a-f-]{36}$/);
  await page.getByLabel('API key', { exact: true }).fill(token);
  await page.getByLabel('Request body (JSON, optional)').fill('{"title":"Synthetic task"}');
  await page.getByLabel('I intend to send this write with the pasted key.').check();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })));
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue(token);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Request body (JSON, optional)')).toHaveValue('');
  await expect(page.getByLabel('Idempotency key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('I intend to send this write with the pasted key.')).not.toBeChecked();
  await expect(page.getByRole('status')).toContainText('Private inputs and response cleared');
});
test('public reference, cookie-free try-it, private lifecycle, keyboard, themes and phone width', async ({ page, context }, testInfo) => {
  await context.addCookies([{ name: 'pulse_session', value: 'synthetic-browser-session', url: testInfo.project.use.baseURL as string || process.env.PLAYWRIGHT_TEST_BASE_URL! }]);
  const calls: { headers: Record<string, string>; body: string | null }[] = [];
  await page.route('**/api/v1/openapi.json', route => route.fulfill({ json: spec }));
  await page.route('**/api/v1/tasks', async route => { calls.push({ headers: await route.request().allHeaders(), body: route.request().postData() }); await route.fulfill({ json: { synthetic: 'private-result' }, headers: { 'x-request-id': 'synthetic-request-id', 'ratelimit-remaining': '9' } }); });
  await page.goto('/developers');
  await expect(page.getByRole('heading', { name: 'Build with Pulse.' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Paste an API key');
  await expect(page.getByLabel('Operation', { exact: true }).locator('option')).toHaveCount(3);
  await page.getByRole('button', { name: 'Send GET request' }).click();
  await expect(page.getByRole('status')).toContainText('missing or malformed'); expect(calls).toHaveLength(0);
  await page.getByLabel('API key', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Send GET request' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('API response')).toContainText('synthetic-request-id');
  expect(calls[0].headers.authorization).toBe('Bearer ' + token); expect(calls[0].headers.cookie).toBeUndefined();
  expect(calls[0].headers['x-pulse-session']).toBeUndefined();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }) )).not.toContain(token);
  await page.getByLabel('Operation', { exact: true }).selectOption('1');
  await expect(page.getByLabel('API response')).toHaveCount(0);
  await page.getByLabel('Request body (JSON, optional)').fill('{"title":"Synthetic task"}');
  await page.getByLabel('I intend to send this write with the pasted key.').check();
  await page.getByRole('button', { name: 'Send POST request' }).click();
  await expect(page.getByRole('status')).toContainText('succeeded'); expect(calls[1].headers['idempotency-key']).toBeTruthy(); expect(calls[1].headers.cookie).toBeUndefined();
  await page.getByRole('button', { name: 'Clear private data' }).click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue(''); await expect(page.getByLabel('API response')).toHaveCount(0);
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => getComputedStyle(document.body).overflowY)).not.toBe('hidden');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`developers-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.getByLabel('API key', { exact: true }).fill(token);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await page.getByLabel('Operation', { exact: true }).selectOption('0'); await page.getByLabel('API key', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Send GET request' }).click(); await expect(page.getByLabel('API response')).toContainText('private-result');
  await page.goto('/login'); await page.goBack();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue(''); await expect(page.getByLabel('API response')).toHaveCount(0);
});
test('reference disconnected, empty and expired-key states are explicit', async ({ page }) => {
  await page.route('**/api/v1/openapi.json', route => route.fulfill({ status: 503, json: {} }));
  await page.goto('/developers'); await expect(page.getByRole('status')).toContainText('disconnected');
  await page.route('**/api/v1/openapi.json', route => route.fulfill({ json: { openapi: '3.1.0', paths: {} } }));
  await page.getByRole('button', { name: 'Reload reference' }).click(); await expect(page.getByRole('status')).toContainText('No operations');
  await page.route('**/api/v1/openapi.json', route => route.fulfill({ json: spec }));
  await page.route('**/api/v1/tasks', route => route.fulfill({ status: 401, json: { title: 'Unauthorized' } }));
  await page.getByRole('button', { name: 'Reload reference' }).click(); await expect(page.getByRole('status')).toContainText('Paste an API key');
  await page.getByLabel('API key', { exact: true }).fill(token); await page.getByRole('button', { name: 'Send GET request' }).click();
  await expect(page.getByRole('status')).toContainText('expired'); await expect(page.getByLabel('API response')).toContainText('HTTP 401');
});

test('CLI download is built into the Next artifact and matches the reviewed source', async ({ page, request }) => {
  const response = await request.get('/developers/pulse.mjs');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('text/javascript; charset=utf-8');
  expect(response.headers()['content-disposition']).toBe('attachment; filename="pulse.mjs"');
  expect(await response.text()).toBe(await readFile(resolve(__dirname, '../../packages/pulse-cli/pulse.mjs'), 'utf8'));
  await page.route('**/api/v1/openapi.json', route => route.fulfill({ json: spec }));
  await page.goto('/developers');
  await expect(page.getByRole('link', { name: 'Download the Pulse CLI' })).toHaveAttribute('href', '/developers/pulse.mjs');
});
