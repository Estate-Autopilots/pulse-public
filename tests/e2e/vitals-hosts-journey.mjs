// VITALS-HOSTS (owner, 4 Nov 2026: "move Pulse to vitalsos.ai"): one person's journey across a platform host family,
// rehearsed on *.localhost names (Chromium resolves them to this machine), so it runs before any DNS exists:
//   - api., mcp. and id. send a stray visit to app.; app. signs in and its cookies are host-only (id. does not see them);
//   - an MCP app finds the family's one issuer from mcp.'s 401 (RFC 9728), registers there (DCR), sends the person to
//     id.'s consent screen, which asks them to sign in on id. first; the answer carries `iss` = id.; the token works on
//     mcp.'s /mcp; the token is revoked at the end. Phone (390 px) and desktop screenshots of each screen.
//
//   WEB_PORT=<lane web> FAMILY=vitals.localhost JOURNEY_USER=… JOURNEY_PASSWORD=… [SHOTS=<dir>] node tests/e2e/vitals-hosts-journey.mjs
//
// The web and API must both run with PULSE_HOST_FAMILIES naming app./api./mcp./id.<FAMILY> and PULSE_PUBLIC_LOGIN_ENABLED=1
// (and PULSE_DEV_ORIGIN=*.<FAMILY> under next dev). Synthetic account only; never prints the password or a token.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const core = process.env.PLAYWRIGHT_CORE ?? 'playwright-core';
const { chromium, request } = await import(core);
const port = process.env.WEB_PORT, family = process.env.FAMILY ?? 'vitals.localhost';
const [user, password] = ['JOURNEY_USER', 'JOURNEY_PASSWORD'].map((k) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; });
if (!port) throw new Error('WEB_PORT is not set');
const at = (role) => `http://${role}.${family}:${port}`;
const [APP, API, MCP, ID] = ['app', 'api', 'mcp', 'id'].map(at);
const shots = process.env.SHOTS;
const checks = [];
const ok = (cond, what) => { assert.ok(cond, what); checks.push(what); };
const CALLBACK = 'http://127.0.0.1:9/vitals-hosts-callback';   // never reached: the browser's visit is caught below

const browser = await chromium.launch({ headless: true });
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  // The app's return address is never reached: each context answers it itself and remembers what came back.
  const returned = [];
  for (const ctx of [desktop, phone]) await ctx.route(`${CALLBACK}**`, (route) => { returned.push(new URL(route.request().url())); return route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }); });
  const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false }); };
  const signIn = async (page) => {
    // Wait for the page's script (a form sent before it loads would go out as a GET with the password in the address).
    await page.waitForFunction(() => !!document.querySelector('form') && Object.keys(document.querySelector('form')).some((k) => k.startsWith('__react')), null, { timeout: 120000 });
    await page.locator('input[name="username"]').fill(user);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 90000 });
    const later = page.getByRole('button', { name: 'Later' });
    if (await later.isVisible({ timeout: 3000 }).catch(() => false)) await later.click();
  };

  // 1. Stray visits to api., mcp. and id. end on app.'s sign-in page; nothing there is a dead end.
  for (const [ctx, size] of [[phone, 'phone'], [desktop, 'desktop']]) {
    const page = await ctx.newPage();
    for (const host of [API, MCP, ID]) {
      await page.goto(`${host}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 120000 });
      ok(new URL(page.url()).origin === APP, `${size}: ${new URL(host).hostname}/dashboard lands on app.`);
    }
    await page.waitForSelector('input[name="username"]', { timeout: 120000 });
    await shot(page, `1-app-login-${size}`);
    await page.close();
  }

  // 2. Sign in on app.; every cookie is host-only and id. does not see them.
  const page = await desktop.newPage();
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle', timeout: 120000 });
  await signIn(page);
  const me = await page.evaluate(async () => (await fetch('/api/v0/me', { cache: 'no-store' })).status);
  ok(me === 200, 'signed in on app.');
  await shot(page, '2-app-signed-in-desktop');
  const cookies = await desktop.cookies();
  ok(cookies.length > 0 && cookies.every((c) => c.domain === `app.${family}`), `every cookie is host-only on app. (${cookies.map((c) => c.name).join(', ')})`);
  ok((await desktop.cookies(ID)).length === 0 && (await desktop.cookies(MCP)).length === 0, 'id. and mcp. see no app. cookie');

  // 3. An MCP app discovers the family from mcp.'s 401 challenge.
  const http = await request.newContext();   // the MCP app: no browser cookies, only its bearer token
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitals-hosts-journey', version: '1' } } };
  const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const unsigned = await http.post(`${MCP}/mcp`, { data: init, headers: mcpHeaders, failOnStatusCode: false });
  ok(unsigned.status() === 401, 'unsigned /mcp on mcp. is 401');
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(unsigned.headers()['www-authenticate'] ?? '')?.[1];
  ok(metadataUrl === `${MCP}/.well-known/oauth-protected-resource/mcp`, 'the challenge names mcp.\'s own metadata');
  const prm = await (await http.get(metadataUrl)).json();
  ok(prm.resource === `${MCP}/mcp` && prm.authorization_servers?.[0] === ID, 'mcp. names its resource and the family issuer id.');
  const as = await (await http.get(`${ID}/.well-known/oauth-authorization-server`)).json();
  ok(as.issuer === ID && as.authorization_endpoint === `${ID}/oauth/mcp/authorize` && as.authorization_response_iss_parameter_supported === true, 'id. publishes itself as issuer');

  // 4. Register (DCR) at the issuer and send the person to id.'s consent screen.
  const reg = await http.post(as.registration_endpoint, { data: { client_name: 'Vitals hosts check (synthetic)', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }, failOnStatusCode: false });
  ok(reg.status() === 201, 'the app registers at id.');
  const { client_id } = await reg.json();
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(12).toString('hex');
  const authorize = new URL(as.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id, redirect_uri: CALLBACK, scope: 'people.read search.read', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) authorize.searchParams.set(k, v);

  // id. has its own (host-only) session: the phone first sees id.'s sign-in page, then the consent screen.
  const phonePage = await phone.newPage();
  await phonePage.goto(authorize.href, { waitUntil: 'networkidle', timeout: 120000 });
  ok(new URL(phonePage.url()).origin === ID && new URL(phonePage.url()).pathname === '/login', 'consent on id. asks to sign in on id. first');
  await shot(phonePage, '3-id-login-phone');
  await page.goto(authorize.href, { waitUntil: 'networkidle', timeout: 120000 });
  ok(new URL(page.url()).pathname === '/login', 'desktop: signed in on app. is not signed in on id.');
  await shot(page, '3-id-login-desktop');
  await signIn(page);
  ok(new URL(page.url()).origin === ID && new URL(page.url()).pathname === '/oauth/mcp/authorize', 'after signing in on id. the consent screen opens');
  await page.getByRole('button', { name: 'Allow' }).waitFor({ timeout: 30000 });
  await shot(page, '4-id-consent-desktop');
  await signIn(await (async () => { await phonePage.goto(`${ID}/login?next=${encodeURIComponent(authorize.pathname + authorize.search)}`, { waitUntil: 'networkidle' }); return phonePage; })());
  await phonePage.getByRole('button', { name: 'Allow' }).waitFor({ timeout: 30000 });
  await shot(phonePage, '4-id-consent-phone');
  const box = await phonePage.getByRole('button', { name: 'Allow' }).boundingBox();
  ok(box && box.x >= 0 && box.x + box.width <= 390 && box.height >= 44, 'phone: Allow fits the screen and is a 44 px target');
  await phonePage.getByRole('button', { name: 'Cancel' }).click();
  await phonePage.waitForURL((u) => u.href.startsWith(CALLBACK), { timeout: 30000 });
  ok(returned.at(-1)?.searchParams.get('error') === 'access_denied' && returned.at(-1)?.searchParams.get('iss') === ID, 'phone: Cancel returns to the app, refused, naming id.');

  // 5. Allow: the answer goes back to the app with `iss` = id. (RFC 9207).
  await page.getByRole('button', { name: 'Allow' }).click();
  await page.waitForURL((u) => u.href.startsWith(CALLBACK), { timeout: 30000 });
  const back = returned.at(-1);
  ok(back && back.searchParams.get('state') === state && !!back.searchParams.get('code'), 'the app gets a code for its state');
  ok(back.searchParams.get('iss') === ID, 'the answer names id. as issuer');

  // 6. The token works on mcp.; then it is revoked.
  const tokenAnswer = await http.post(as.token_endpoint, { form: { grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: CALLBACK, client_id, code_verifier: verifier }, failOnStatusCode: false });
  ok(tokenAnswer.status() === 200, 'id. exchanges the code');
  const tokens = await tokenAnswer.json();
  const signed = await http.post(`${MCP}/mcp`, { data: init, headers: { ...mcpHeaders, authorization: `Bearer ${tokens.access_token}` }, failOnStatusCode: false });
  ok(signed.status() === 200, 'the token opens /mcp on mcp.');
  const list = await http.post(`${MCP}/mcp`, { data: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers: { ...mcpHeaders, authorization: `Bearer ${tokens.access_token}` }, failOnStatusCode: false });
  const listed = await list.text();
  ok(list.status() === 200 && /whoami/.test(listed), 'mcp. lists its tools');
  const revoke = await http.post(as.revocation_endpoint, { form: { token: tokens.refresh_token, client_id }, failOnStatusCode: false });
  ok(revoke.status() === 200, 'the connection is revoked at id.');
  const after = await http.post(`${MCP}/mcp`, { data: init, headers: { ...mcpHeaders, authorization: `Bearer ${tokens.access_token}` }, failOnStatusCode: false });
  ok(after.status() === 401, 'after revoking, the token no longer opens /mcp');

  // 7. Cross-host requests are refused: app.'s session cannot be used from id.'s page, nor id.'s POSTs from app.
  const cross = await page.evaluate(async (app) => { try { const r = await fetch(`${app}/api/v0/me`, { credentials: 'include' }); return r.status; } catch { return 'blocked'; } }, APP);
  ok(cross === 'blocked' || cross === 401, `id.'s page cannot use app.'s session (${cross})`);
  await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
  const forged = await desktop.request.post(`${APP}/api/v0/auth/sign-out`, { headers: { origin: ID }, data: {}, failOnStatusCode: false });
  ok(forged.status() === 403, `app. refuses a POST that comes from id. (HTTP ${forged.status()})`);
  const own = await desktop.request.post(`${APP}/api/v0/auth/sign-out`, { headers: { origin: APP }, data: {}, failOnStatusCode: false });
  ok(own.status() < 400, `app. accepts its own POST (signs out: HTTP ${own.status()})`);
  await http.dispose();
  console.log(JSON.stringify({ ok: true, checks }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, checks, error: String(error?.message ?? error).slice(0, 400) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
