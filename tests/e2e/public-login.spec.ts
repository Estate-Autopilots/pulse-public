import { expect, test } from '@playwright/test';

// Run against a temporary local web server with PULSE_PUBLIC_LOGIN_ENABLED=1.
// Never change the main Access-protected pulse-dev deployment to run these checks.
test.skip(!process.env.PULSE_PUBLIC_LOGIN_SMOKE, 'Requires the isolated public-login web server');

test('Public credentials reject forged Access identity', async ({ request }) => {
  for (const [path, status] of [
    ['/api/v0/me', 401],
    ['/api/v0/money', 401],
    ['/photo/00000000-0000-0000-0000-000000000000', 404],
  ] as const) {
    const response = await request.get(path, {
      headers: { 'cf-access-authenticated-user-email': 'admin@estateautopilots.com' },
    });
    expect(response.status()).toBe(status);
  }
});

test('Public sign-in rejects a foreign origin', async ({ request }) => {
  const response = await request.post('/api/v0/auth/sign-in', {
    headers: { origin: 'https://wrong.example' },
    data: { username: 'synthetic', password: 'wrong' },
  });
  expect(response.status()).toBe(403);
});

test('Public login and reset forms are available', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in to Pulse' })).toBeVisible();
  await expect(page.locator('input[name="username"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await page.getByRole('button', { name: 'Forgot your password?', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reset link', exact: true })).toBeVisible();
});

test('password fields show on request, work by touch and keyboard, and mask on submit', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL ?? process.env.PULSE_BASE_URL, viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto('/login');
    const loginPassword = page.getByLabel('Password', { exact: true });
    await expect(loginPassword).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(loginPassword).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide password' }).focus();
    await page.keyboard.press('Space');
    await expect(loginPassword).toHaveAttribute('type', 'password');

    await page.goto('/login/set-password');
    const password = page.getByLabel('New password', { exact: true });
    const again = page.getByLabel('New password again', { exact: true });
    await expect(password).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show password' }).first().tap();
    await expect(password).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Show password' }).tap();
    await expect(again).toHaveAttribute('type', 'text');
    await page.locator('form').evaluate((form: HTMLFormElement) => { form.noValidate = true; });
    await page.route('**/api/v0/auth/set-password', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Synthetic failure"}' }));
    await page.getByRole('button', { name: 'Set password and start' }).click();
    await expect(password).toHaveAttribute('type', 'password');
    await expect(again).toHaveAttribute('type', 'password');
    await expect(page.locator('[role="alert"][data-tone="error"]')).toHaveText('Synthetic failure');
  } finally {
    await context.close();
  }
});
