// One Chromium instance, one context at a time (no test workers). Also usable as QA's route adapter example.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { routeGoogle } from './google-harness.mjs';
const require = createRequire(new URL('../../../tests/e2e/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const scratch = process.env.PULSE_HARNESS_SCRATCH, m = JSON.parse(readFileSync(scratch + '/manifest.json'));
const credentials = JSON.parse(readFileSync(m.credentialsFile));
assert.equal(statSync(m.credentialsFile).mode & 0o777, 0o600);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
await routeGoogle(context, m.googleOrigin);
const page = await context.newPage();
const select = async (identity, session) => { const r = await fetch(m.googleOrigin + '/session', { method: 'POST', body: JSON.stringify({ identity, session }) }); assert.equal(r.status, 200); };
const go = async (mode, next) => { const r = await page.goto(m.origin + '/api/v0/auth/google/start?' + new URLSearchParams({ mode, ...(next ? { next } : {}) })); assert.ok(r?.ok(), `${mode}: HTTP ${r?.status()} at ${new URL(page.url()).pathname}`); };
const me = () => context.request.get(m.origin + '/api/v0/me');
try {
 const branding = await context.request.get(m.origin + '/api/v0/auth/branding'); assert.equal(branding.status(), 200); assert.equal((await branding.json()).google, true);
 await select('linked', false); await go('silent', m.links.task);
 assert.equal(new URL(page.url()).searchParams.get('google'), 'silent_failed', 'quiet fallback at ' + new URL(page.url()).pathname);
 assert.equal((await me()).status(), 401);
 // A real password form creates the browser session; its real Account link crosses Google and comes back.
 await page.goto(m.origin + '/login?out=1');
 await page.getByRole('textbox', { name: 'Username or @handle', exact: true }).fill(m.people.unlinked.username);
 await page.getByLabel('Password', { exact: true }).fill(credentials.password);
 await page.getByRole('button', { name: 'Sign in', exact: true }).click();
 await page.waitForURL(url => !url.pathname.startsWith('/login'));
 await select('unlinked', false); await page.goto(m.origin + '/account');
 await page.getByRole('tab', { name: 'Google', exact: true }).click();
 await page.getByRole('link', { name: 'Link Google', exact: true }).click();
 await page.getByText('Google account linked. You can now use Continue with Google on the sign-in page.', { exact: true }).waitFor();
 assert.ok((await context.request.get(m.origin + '/api/v0/auth/account')).ok());
 let r = await context.request.post(m.origin + '/api/v0/auth/sign-out', { headers: { origin: m.origin }, data: {} }); assert.ok(r.ok());
 await go('signin', m.links.task);
 assert.equal(new URL(page.url()).pathname, m.links.task);
 assert.equal((await me()).status(), 200);
 const cookie = (await context.cookies()).find(c => c.name === 'pulse_session');
 assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Lax');
 assert.ok(!(await context.cookies()).some(c => c.name === 'pulse_oidc'));
 assert.ok(!/code=|token=/.test(page.url()));
 // Sign-out + quiet success, rejected identities and revocation all use the same real proxy.
 await context.request.post(m.origin + '/api/v0/auth/sign-out', { headers: { origin: m.origin }, data: {} });
 await go('silent', m.links.client); assert.equal(new URL(page.url()).pathname, m.links.client);
 for (const [identity, reason] of [['wrong-domain', 'domain_not_allowed'], ['unverified', 'provider_error'], ['other-org', 'not_linked'], ['disabled', 'account_disabled']]) {
  await select(identity, true); await go('signin'); assert.equal(new URL(page.url()).searchParams.get('google'), reason, identity);
 }
 // A password session can revoke the link and prevent subsequent Google sign-in.
 await context.request.post(m.origin + '/api/v0/auth/sign-out', { headers: { origin: m.origin }, data: {} });
 await page.goto(m.origin + '/login?out=1');
 await page.getByRole('textbox', { name: 'Username or @handle', exact: true }).fill(m.people.unlinked.username);
 await page.getByLabel('Password', { exact: true }).fill(credentials.password);
 await page.getByRole('button', { name: 'Sign in', exact: true }).click();
 await page.waitForURL(url => !url.pathname.startsWith('/login'));
 r = await context.request.post(m.origin + '/api/v0/auth/google/unlink', { headers: { origin: m.origin }, data: {} }); assert.ok(r.ok());
 await select('unlinked', true); await go('signin'); assert.equal(new URL(page.url()).searchParams.get('google'), 'not_linked');
 console.log(`Google harness PASS @ ${m.sha}: browser link + sign-in, Secure cookies, quiet fallback/success, refused identities, unlink`);
} finally { await context.close(); await browser.close(); }
