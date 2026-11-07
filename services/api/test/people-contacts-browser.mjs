// PEOPLE-CONTACTS in the browser: the real API (this process) and the built web app (`next start`, NEXT_DIST_DIR) on a
// disposable synthetic tenant (tests/core/test_people_contacts.py::test_people_contacts_in_the_browser). Flows: the
// photo cropper (a JPEG marked "turn clockwise" lands upright), My info and bank details (IFSC fills the bank), HR's
// check and logged reveal, Account access with a one-time sign-in link used in a fresh browser, a new contact type
// with its own field, a contact's profile with a note, and Onboard team's bank filter. Every flow is reported by name;
// PULSE_PEOPLE_SCREENSHOTS=<dir> keeps a screenshot of each screen (1440 light, 390 dark) and of any failure.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/app.js';
import { testMail } from '../dist/auth-mail.js';
const R = JSON.parse(process.env.TEST_ROLES);
const keyFile = join(process.env.TEST_KEY_DIR, 'document-master.key');
await writeFile(keyFile, `browser-2026-10 ${randomBytes(32).toString('base64')}\n`, { mode: 0o600 }); await chmod(keyFile, 0o600);
process.env.PULSE_DOCUMENT_KEY_FILE = keyFile; process.env.PULSE_IFSC_LOOKUP = 'off';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
const shots = process.env.PULSE_PEOPLE_SCREENSHOTS; if (shots) await mkdir(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
  env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next' }, stdio: 'ignore' });
let browser; const results = []; let checks = 0; const errors = [];
const ok = (condition, msg) => { checks++; assert.ok(condition, msg); };
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }); await page.waitForTimeout(400); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await ready(page); };
const posted = (page, path) => { const w = page.waitForResponse((r) => r.url().includes(`/api/v0/${path}`) && r.request().method() === 'POST', { timeout: 30000 }); w.catch(() => null); return w; };
const pages = [];
async function as(role, width = 1440, theme = 'light') {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, extraHTTPHeaders: { 'cf-access-authenticated-user-email': `${role}@people.example` } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch {} }, theme);
  const page = await ctx.newPage(); pages.push(page);
  page.on('pageerror', (e) => errors.push(`${role} ${e.message.slice(0, 200)}`));
  return page;
}
async function shot(page, name) { if (shots) { await page.waitForTimeout(450); await page.screenshot({ path: `${shots}/${name}.png` }); } }   // after drawers finish sliding in
async function flow(name, run) {
  const started = Date.now();
  try { await run(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (e) {
    const error = String(e?.message ?? e).split('\n').slice(0, 6).join(' | ').slice(0, 900);
    results.push({ name, ok: false, error }); console.log(`FAIL ${name}: ${error}`);
    if (shots) for (const [i, p] of pages.entries()) if (!p.isClosed()) await p.screenshot({ path: `${shots}/fail-${name}-${i}.png` }).catch(() => null);
  }
  for (const p of pages.splice(0)) await p.context().close().catch(() => null);
}

try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch {} await delay(200); if (i === 599) throw new Error('next start did not answer'); }
  browser = await chromium.launch();

  await flow('photo-crop', async () => {
    for (const [width, theme] of [[390, 'dark'], [1440, 'light']]) {
      const page = await as('person', width, theme); await go(page, `/people/${R.person}`);
      await page.getByRole('button', { name: /photo$/ }).first().click();
      await page.getByRole('menuitem', { name: /Upload a photo|Choose from gallery/ }).click().catch(() => null);
      // A 600 × 400 JPEG, red on the left and blue on the right, marked "turn clockwise" (EXIF 6): upright, red is on top.
      await page.evaluate(async () => {
        const c = document.createElement('canvas'); c.width = 600; c.height = 400; const g = c.getContext('2d');
        g.fillStyle = '#e02020'; g.fillRect(0, 0, 300, 400); g.fillStyle = '#2040e0'; g.fillRect(300, 0, 300, 400);
        const jpeg = new Uint8Array(await (await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.95))).arrayBuffer());
        const app1 = [0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
        const out = new Uint8Array(jpeg.length + app1.length); out.set(jpeg.subarray(0, 2)); out.set(app1, 2); out.set(jpeg.subarray(2), 2 + app1.length);
        const input = [...document.querySelectorAll('input[type=file]:not([capture])')].at(-1);
        const dt = new DataTransfer(); dt.items.add(new File([out], 'turned.jpg', { type: 'image/jpeg' })); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('button', { name: 'Use photo' })).toBeEnabled({ timeout: 20000 });
      await page.waitForTimeout(700);
      // The picture is drawn upright: 400 wide and 600 tall.
      const size = await page.evaluate(() => { const c = document.querySelector('[data-crop-picture]'); return c ? [c.parentElement.style.width, c.parentElement.style.height] : null; });
      ok(size && size[0] === '400px' && size[1] === '600px', `the EXIF-turned photo is upright: ${size}`);
      const stage = dialog.getByRole('application'); const box = await stage.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 120, { steps: 8 }); await page.mouse.up();
      await dialog.getByLabel('Zoom', { exact: true }).fill('180');
      await page.waitForTimeout(500); await shot(page, `crop-${width}-${theme}`);
      const saving = posted(page, `people/${R.person}/photo`); await dialog.getByRole('button', { name: 'Use photo' }).click();
      ok((await saving).ok(), 'the cropped photo is saved');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.waitForTimeout(800);
      // The saved image: square, sharp, and red at the top (the clockwise turn was applied, the drag moved it down).
      const top = await page.evaluate(async (id) => { const img = new Image(); img.src = `/photo/${id}?v=${Date.now()}`; await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const [r, , b] = g.getImageData(img.naturalWidth / 2, 4, 1, 1).data; return { w: img.naturalWidth, h: img.naturalHeight, r, b }; }, R.person);
      ok(top.w === top.h && top.w >= 256, `a square saved image: ${JSON.stringify(top)}`); ok(top.r > 150 && top.b < 120, `red on top (upright): ${JSON.stringify(top)}`);
      await shot(page, `profile-${width}-${theme}`);
    }
  });

  await flow('my-info-bank', async () => {
    const page = await as('person'); await go(page, `/people/${R.person}?tab=info`);
    await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
    await shot(page, 'my-info-1440-light');
    await page.getByRole('button', { name: 'Add bank details' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add bank details' });
    await drawer.getByLabel('IFSC').fill('hdfc0001234');
    await expect(drawer.getByLabel('Bank', { exact: true })).toHaveValue('HDFC Bank', { timeout: 10000 });
    await drawer.getByLabel('Account number', { exact: true }).fill('000123456789'); await drawer.getByLabel('Account number again').fill('000123456789');
    await drawer.getByLabel(/UPI ID/).fill('synthetic.person@okhdfcbank');
    await shot(page, 'bank-form-1440-light');
    const saving = posted(page, `onboarding/${R.person}/bank`); await drawer.getByRole('button', { name: 'Save bank details' }).click(); ok((await saving).ok(), 'bank details saved');
    await expect(page.getByText('Waiting for HR’s check')).toBeVisible(); await expect(page.getByText('•••• •••• 6789')).toBeVisible();
    // The closing drawer still holds what was typed for a moment; the page must not, once it has gone.
    await expect(drawer).toBeHidden({ timeout: 10000 });
    // The page refreshes after saving; the full number may linger for a moment (3 of 4 GitHub runs on 19 Oct). It must
    // be gone within 10 s, and a number that stays still fails.
    await expect.poll(async () => (await page.content()).includes('000123456789'), { timeout: 10000,
      message: 'the full number is not on the page after saving' }).toBe(false);
    await shot(page, 'my-info-bank-1440-light');
    const phone = await as('person', 390, 'dark'); await go(phone, `/people/${R.person}?tab=info`); await shot(phone, 'my-info-390-dark');
  });

  await flow('hr-check-and-reveal', async () => {
    const page = await as('hr'); await go(page, `/people/${R.person}?tab=info`);
    // The click starts a write followed by router.refresh(); do not spend the badge's visibility budget on the
    // pending API request. Assert the write too, so a failed confirmation cannot look like a slow refresh.
    const confirming = posted(page, `people/${R.person}/bank/confirm`);
    await page.getByRole('button', { name: 'Mark as checked' }).click();
    ok((await confirming).ok(), 'HR confirms the bank details');
    await expect(page.getByText('Checked by HR').first()).toBeVisible({ timeout: 20000 });
    const reveal = posted(page, `people/${R.person}/bank/reveal`); await page.getByRole('button', { name: 'Show the full number' }).click(); ok((await reveal).ok(), 'HR opens the number');
    await expect(page.getByText('000123456789')).toBeVisible(); await expect(page.getByText(/hides in \d+s/)).toBeVisible();
    await shot(page, 'hr-bank-checked-1440-light');
    const leader = await as('leadership'); await go(leader, `/people/${R.person}?tab=info`);
    await expect(leader.getByText(/Bank details are visible to/)).toBeVisible(); ok(!(await leader.content()).includes('6789'), 'leadership sees no bank details at all');
  });

  await flow('account-access', async () => {
    const page = await as('hr'); await go(page, `/people/${R.person}`);
    await page.getByRole('button', { name: 'Account access', exact: true }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Account access', exact: true });
    await expect(drawer.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible({ timeout: 20000 });
    await shot(page, 'account-access-1440-light');
    const before = testMail.length;
    await drawer.getByRole('button', { name: 'Send one-time sign-in link', exact: true }).click();
    await drawer.getByRole('button', { name: 'Confirm send sign-in link', exact: true }).click();
    await expect(drawer.getByRole('status').filter({ hasText: 'Sign-in link sent' })).toBeVisible();
    ok(testMail.length === before + 1 && testMail.at(-1).title === 'Sign in to Pulse', 'one sign-in e-mail, to the sink');
    const link = testMail.at(-1).body.match(/https?:\/\/\S+/)[0];
    const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' }); const p2 = await fresh.newPage(); pages.push(p2);
    await p2.goto(link.replace(/^https?:\/\/[^/]+/, base), { waitUntil: 'load' }); await expect(p2.getByRole('heading', { name: 'Sign in to Pulse' })).toBeVisible();
    // Removed as the page comes alive (hydration); under the full suite's load that can trail the server-drawn heading.
    await expect.poll(() => p2.url(), { timeout: 5000 }).not.toContain('#');
    ok(!p2.url().includes('#'), 'the page takes the token out of the address bar at once');
    await shot(p2, 'signin-link-390-dark');
    // This server runs in Access mode (identities by header), where any signed-out request is refused at the proxy;
    // redeeming is covered by the API runner and the proxy's cookie by app/lib/api-proxy.test.mjs.
    const phone = await as('hr', 390, 'dark'); await go(phone, `/people/${R.person}`); await phone.getByRole('button', { name: 'Account access', exact: true }).first().click();
    await expect(phone.getByRole('dialog', { name: 'Account access' }).getByRole('heading', { name: 'Devices' })).toBeVisible({ timeout: 20000 });
    await expect(phone.getByRole('dialog', { name: 'Account access' }).getByRole('button', { name: /^Sign out / }).first()).toBeVisible();
    await shot(phone, 'account-access-390-dark');
  });

  await flow('contact-types', async () => {
    const page = await as('admin'); await go(page, '/settings?tab=organisation&section=Contact%20%26%20client%20types');
    await page.getByRole('button', { name: 'Add contact type' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a contact type' });
    await dialog.getByLabel('Name', { exact: true }).fill('Architect'); await dialog.getByLabel(/^Plural/).fill('Architects');
    await dialog.getByLabel(/What it means/).fill('Designs the projects we market.');
    await dialog.getByRole('button', { name: 'Add a field' }).click(); await dialog.getByLabel('Field name').fill('COA number');
    await shot(page, 'type-editor-1440-light');
    const saving = posted(page, 'settings/types'); await dialog.getByRole('button', { name: 'Add type' }).click(); ok((await saving).ok(), 'the type is saved');
    await expect(page.getByText('Architect', { exact: true }).first()).toBeVisible(); await expect(page.getByText('COA number')).toBeVisible();
    await shot(page, 'types-1440-light');
    await go(page, '/contacts'); await expect(page.getByRole('link', { name: /^Architects/ })).toBeVisible(); await shot(page, 'contacts-1440-light');
  });

  await flow('contact-profile', async () => {
    const page = await as('admin'); await go(page, `/contacts/${R.contact}`);
    await expect(page.getByRole('heading', { name: /Synthetic Rao/ })).toBeVisible();
    await page.getByLabel('New note').fill('Synthetic: prefers WhatsApp in the mornings.');
    const saving = posted(page, `contacts/${R.contact}/notes`); await page.getByRole('button', { name: 'Add note', exact: true }).click(); ok((await saving).ok(), 'a note is added');
    await expect(page.getByText('prefers WhatsApp in the mornings')).toBeVisible();
    await shot(page, 'contact-1440-light');
    for (const tab of ['Files', 'Notes & timeline', 'Money']) { await page.getByRole('navigation', { name: 'Sections', exact: true }).getByRole('link', { name: new RegExp(`^${tab}`) }).click(); await ready(page); }
    await shot(page, 'contact-money-1440-light');
    const phone = await as('person', 390, 'dark'); await go(phone, `/contacts/${R.contact}`); await expect(phone.getByText('prefers WhatsApp in the mornings')).toBeVisible(); await shot(phone, 'contact-390-dark');
  });

  await flow('org-logo-crop', async () => {
    const page = await as('admin'); await go(page, '/settings?tab=organisation');
    // A wide PNG with a transparent margin: the cropper opens (wide by default for a logo) and keeps transparency.
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 900; c.height = 300; const g = c.getContext('2d');
      g.fillStyle = '#123456'; g.fillRect(100, 80, 700, 140); g.fillStyle = '#ffffff'; g.font = 'bold 72px sans-serif'; g.fillText('SYNTHETIC', 160, 180);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      const input = document.querySelector('input[aria-label="Upload the logo, light background"]');
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'logo.png', { type: 'image/png' })); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('radio', { name: 'Wide' })).toHaveAttribute('aria-checked', 'true', { timeout: 20000 });
    await page.waitForTimeout(600); await shot(page, 'logo-crop-1440-light');
    const saving = page.waitForResponse((r) => r.url().endsWith('/api/v0/settings/brand') && r.request().method() === 'POST' && r.request().postDataJSON()?.kind === 'logo');
    const png = page.waitForResponse((r) => r.url().endsWith('/api/v0/settings/brand') && r.request().method() === 'POST' && r.request().postDataJSON()?.kind === 'logo-png');
    await dialog.getByRole('button', { name: 'Use logo' }).click(); ok((await saving).ok(), 'the cropped logo is saved'); ok((await png).ok(), 'and its e-mail PNG');
    const brand = await (await page.request.get(base + '/api/v0/brand')).json(); ok(brand.logo && brand.logoPng, 'the logo and its e-mail PNG are set');
  });

  await flow('wizard-bank', async () => {
    const page = await as('lead', 390, 'dark'); await go(page, '/welcome?step=bank');
    await page.getByLabel('IFSC').fill('SBIN0001234'); await expect(page.getByLabel('Bank', { exact: true })).toHaveValue('State Bank of India', { timeout: 10000 });
    await page.getByLabel('Account number', { exact: true }).fill('12345678901'); await page.getByLabel('Account number again').fill('12345678901');
    await shot(page, 'wizard-bank-390-dark');
    const saving = posted(page, `onboarding/${R.lead}/bank`); await page.getByRole('button', { name: 'Save and continue' }).click(); ok((await saving).ok(), 'the wizard saves bank details');
  });

  await flow('onboard-bank', async () => {
    const page = await as('hr'); await go(page, '/hr?tab=onboard');
    await page.getByRole('button', { name: /^Bank details/ }).click();
    await expect(page.getByText('No bank details').first()).toBeVisible();
    await shot(page, 'onboard-bank-1440-light');
  });
} finally {
  await browser?.close(); server.kill('SIGTERM'); await app.close(); await pool.end();
}
const failed = results.filter((r) => !r.ok);
await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, results, failed, errors }, null, 1));
console.log(`${results.length - failed.length}/${results.length} flows passed${errors.length ? `; page errors: ${errors.join(' | ')}` : ''}`);
process.exit(failed.length || errors.length ? 1 : 0);
