// QA-E2E browser journeys: the production web build (next start, NEXT_DIST_DIR=.next-build) against the real API on a
// disposable synthetic agency, with two and three people side by side, so what A does is timed until B sees it.
// Desktop 1440 and phone 390, light and dark. Public sign-in mode (PULSE_PUBLIC_LOGIN_ENABLED=1), as on phones.
// Run by tests/core/test_qa_e2e.py with PULSE_AUTH_BROWSER=1; screenshots in $PULSE_QA_E2E_OUT/shots.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { Persona, Recorder, delay, randomUUID, startStack, tick } from './lib/harness.mjs';

const { chromium, expect } = await import(new URL('../node_modules/@playwright/test/index.mjs', import.meta.url).href);
const seed = JSON.parse(process.env.TEST_SEED);
const OUT = process.env.PULSE_QA_E2E_OUT ?? 'qa-e2e-browser';
const SHOTS = `${OUT}/shots`; mkdirSync(SHOTS, { recursive: true });
const rec = new Recorder(OUT, 'QA-E2E browser journeys');
const byToken = () => new Map(Object.values(P).filter((p) => p.token).map((p) => [p.token, p.key]));
const stack = await startStack({ observe: (r) => { if (!r.session && !r.device) return; const who = byToken().get(r.session) ?? (r.device ? 'device' : 'other'); rec.request({ persona: `${who}:server`, ...r, session: undefined }); } });
const free = () => new Promise((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const port = await free();
const base = `http://127.0.0.1:${port}`;
const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: new URL('../../../apps/web/', import.meta.url).pathname, stdio: 'ignore',
  env: { ...process.env, PULSE_API_URL: stack.base, NODE_ENV: 'production', PULSE_PUBLIC_LOGIN_ENABLED: '1', PULSE_PUBLIC_URL: base },
});
const h = { rec, stack, password: seed.password };
const names = { kabir: 'Kabir Shah', ahoro: 'Ahoro Rao', meera: 'Meera Iyer', neha: 'Neha Jivop', rila: 'Rila Kapoor', dev: 'Dev Panab', sana: 'Sana Khan', ishaan: 'Ishaan Vivim', tara: 'Tara Nair', vikram: 'Vikram Seduh', zoya: 'Zoya Sheikh', rifob: 'Rifob Desai' };
const P = Object.fromEntries(Object.entries(seed.personas).map(([k, v]) => [k, new Persona(h, k, { ...v, name: names[k] })]));
let browser; const errors = []; const chips = [];
const VIEW = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

/** A person's own browser: a window size, a theme, the session cookie of their API sign-in (or a UI sign-in). */
async function open(p, kind, theme) {
  const phone = kind === 'phone';
  const ctx = await browser.newContext({ viewport: VIEW[kind], colorScheme: theme, deviceScaleFactor: phone ? 3 : 1, hasTouch: phone, isMobile: phone, baseURL: base });
  if (p.token) await ctx.addCookies([{ name: 'pulse_session', value: p.token, url: base }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push({ who: p.key, kind, message: e.message }));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push({ who: p.key, kind, console: m.text().slice(0, 200) }); });
  // Pip's island is decided by the browser poll: keep it, but no OS notification prompts.
  await ctx.grantPermissions([]);
  return { ctx, page, p, kind, theme };
}
const shot = async (s, name) => { try { await s.page.screenshot({ path: `${SHOTS}/${name}-${s.kind}-${s.theme}.png` }); } catch { /* closed */ } };
async function go(s, path) {
  const t0 = performance.now();
  // An image or other peripheral resource can hold `load` after the page is usable.
  // Wait for the document and its content instead; a failed or still-busy page remains a failure.
  const response = await s.page.goto(base + path, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw Error(`${path} returned HTTP ${response?.status() ?? 'no response'}`);
  const main = s.page.locator('main');
  await expect(main).toBeVisible({ timeout: 60000 });
  await expect(main).toHaveText(/\S/, { useInnerText: true, timeout: 60000 });
  await expect(s.page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 60000 });
  const ms = performance.now() - t0; rec.request({ persona: s.p.key + ':' + s.kind, method: 'PAGE', route: path.split('?')[0], path, status: response.status(), ms: Math.round(ms) });
  return ms;
}
const fitsNow = (s) => s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
// CHAT-SHELL: / opens the chat on a computer and /chats its last conversation, so a page can still replace its document
// right after it loaded: measure again on the settled page.
const fits = (s) => fitsNow(s).catch(async () => { await s.page.waitForLoadState('domcontentloaded'); await delay(500); return fitsNow(s); });
async function visible(locator, ms = 20000) { try { await expect(locator.first()).toBeVisible({ timeout: ms }); return true; } catch { return false; } }
/** Time until a locator shows, from t0 (performance.now()). */
async function until(locator, t0, ms = 20000) { return (await visible(locator, ms)) ? performance.now() - t0 : null; }
const log = (page) => page.locator('[role="log"]');
/** Send what is in the composer: Enter on a computer; on a phone Enter is a new line (as in WhatsApp), so tap Send. */
async function send(s, box, text) {
  await box.fill(text); const t0 = performance.now();
  if (s.kind === 'phone') {
    const button = s.page.getByRole('button', { name: 'Send', exact: true });
    try { await button.click(); } catch (error) {
      // Recorder's short failure line cuts off Playwright's interceptor; keep it and the hit target in hosted logs.
      const layout = await button.evaluate((el) => {
        const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const content = document.querySelector('[data-island-content]');
        return { button: r.toJSON(), hit: hit ? `${hit.tagName}.${hit.getAttribute('class') ?? ''}` : null,
          hitIsland: !!hit?.closest('[data-island]'), focus: document.activeElement?.tagName,
          arrival: !!document.querySelector('[data-island][data-open]'), contentVisibility: content ? getComputedStyle(content).visibility : null };
      }).catch(() => null);
      console.error('PHONE_SEND_DIAG', JSON.stringify({ interceptors: [...new Set(String(error).split('\n').filter((line) => line.includes('intercepts pointer events')).map((line) => line.trim()))], layout }));
      throw error;
    }
  } else await box.press('Enter');
  return t0;
}
/** The bell's unread number (0 when it has none). */
// QA-1024 (5f7dc670, R014): the bell names its number "N need you" (ATT's urgent and needs-you), or "N unread" when the
// server sends no needs-you count.
const bellCount = async (page) => Number(((await page.getByRole('button', { name: /^Notifications/ }).first().getAttribute('aria-label').catch(() => '')) ?? '').match(/(\d+) (?:unread|needs? you)/)?.[1] ?? 0);
/** ATT (ef5221e4): two or more same-day cards of one family fold into a stack ("2 tasks for you"); open every stack in
 *  the panel so each card and its buttons can be found. */
async function openStacks(panel) {
  await panel.locator('li[data-card], li[data-stack]').first().waitFor({ timeout: 10000 }).catch(() => {});
  for (const toggle of await panel.locator('li[data-stack] button[aria-expanded="false"]').all()) await toggle.click().catch(() => {});
}
/** The bell's count once the 2.5-second poll has nothing more to add. */
async function settledBell(page) {
  let a = await bellCount(page);
  for (let i = 0; i < 5; i++) { await delay(3000); const b = await bellCount(page); if (b === a) return a; a = b; }
  return a;
}
/** Time until the bell counts more than `before`, from t0. */
async function bellRises(page, before, t0, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await bellCount(page)) > before) return performance.now() - t0; await delay(100); }
  return null;
}
/** Is the newest message fully above the composer (not hidden under it)? With the list's and composer's geometry. */
const lastVisible = (page) => page.evaluate(() => {
  const logEl = document.querySelector('[role="log"]'); const items = [...document.querySelectorAll('[role="log"] article')]; const last = items.at(-1);
  const box = document.querySelector('textarea[aria-label^="Message"], [role="textbox"][aria-label^="Message"]');
  let bar = box; while (bar && bar.parentElement && bar.parentElement !== document.body && bar.getBoundingClientRect().height < 50) bar = bar.parentElement;
  if (!last || !box || !logEl) return null;
  const a = last.getBoundingClientRect(), b = bar.getBoundingClientRect(), l = logEl.getBoundingClientRect();
  return { lastBottom: Math.round(a.bottom), composerTop: Math.round(b.top), logBottom: Math.round(l.bottom), scrollTop: Math.round(logEl.scrollTop), scrollHeight: logEl.scrollHeight, clientHeight: logEl.clientHeight,
    gapToEnd: Math.round(logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight), visible: a.bottom <= b.top + 1 };
});
/** The public sign-in page, including choosing one's own password after an HR-issued one. */
async function uiSignIn(s) {
  const page = s.page, t0 = performance.now();
  await page.goto(base + '/login', { waitUntil: 'load' });
  await page.getByLabel('Username').fill(s.p.username);
  await page.getByLabel('Password', { exact: true }).fill(s.p.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/login\?change=1|\/dashboard|\/me|\/$/, { timeout: 30000 });
  if (page.url().includes('change=1')) {
    rec.check(true, `${s.p.key}: an HR-issued password leads to "choose your password"`);
    await shot(s, 'b0-choose-password');
    const next = `Synthetic-${s.p.key}-web-2026!`;
    await page.getByLabel('Current password').fill(s.p.password);
    await page.getByLabel('New password', { exact: true }).fill(next);
    await page.getByLabel('New password again').fill(next);
    await page.getByRole('button', { name: /Set password and continue/ }).click();
    await page.waitForURL(/\/dashboard|\/me|\/$/, { timeout: 30000 }); s.p.password = next;
  }
  rec.timing(`${s.p.key}: sign-in on the web (${s.kind})`, performance.now() - t0);
  const cookies = await s.ctx.cookies(); s.p.token = cookies.find((c) => c.name === 'pulse_session')?.value ?? s.p.token;   // Secure cookie: not listed for an http URL filter
  rec.check(!!s.p.token, `${s.p.key}: signed in through the page (session cookie set)`);
}

/** The desktop app's panel (apps/desktop/dist: panel.js and the shared companion core) in Chromium at the panel's
 *  size. The Tauri bridge is replaced by a thin stand-in whose companion_request forwards to the real API with a
 *  laptop paired like the desktop app pairs (device token), so every tap changes real attendance. Then the update
 *  check: the channel the panel asks for, and what the production web route serves to the desktop and to the phone. */
async function desktopPanel() {
  const { readFile } = await import('node:fs/promises'); const { createServer: http } = await import('node:http'); const { resolve, extname } = await import('node:path');
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { sep } = await import('node:path');
  // dist = src + the shared companion core, built outside the checkout (a CI checkout must hold no build output).
  const root = await mkdtemp(resolve(tmpdir(), 'pulse-desktop-dist-')) + sep;
  process.env.PULSE_DESKTOP_DIST = root;
  try { await import(new URL('../../../apps/desktop/build.mjs', import.meta.url).href); } finally { delete process.env.PULSE_DESKTOP_DIST; }
  const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = http(async (req, res) => {
    try { const p = new URL(req.url, 'http://x').pathname, f = resolve(root, p === '/' ? 'index.html' : '.' + p); if (!f.startsWith(root)) throw Error('scope'); res.setHeader('content-type', types[extname(f)] ?? 'text/plain'); res.end(await readFile(f)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dev = P.dev; const laptop = await dev.pair('windows', 'QA laptop');
  if (!laptop) { server.close(); await rm(root, { recursive: true, force: true }); return; }
  const ctx = await browser.newContext({ viewport: { width: 380, height: 720 }, colorScheme: 'light', deviceScaleFactor: 2 });
  await ctx.exposeFunction('__qaRequest', async (path, body) => {
    const r = await dev.call(body == null ? 'GET' : 'POST', `/api/v0/${path}`, body ?? undefined, { device: true });
    return r.status >= 400 ? { error: JSON.stringify({ status: r.status, message: r.data?.error ?? 'error' }) } : { data: r.data };
  });
  await ctx.addInitScript(() => {
    const calls = []; window.__calls = calls;
    window.__TAURI__ = { core: { invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      switch (cmd) {
        case 'app_info': return { version: '1.0.1', platform: 'windows', shortcut: 'Ctrl+Alt+P', launch: {} };
        case 'autostart_get': return false;
        case 'companion_session': return { signedIn: true, base: 'https://pulse.estateautopilots.com/api/native/v0', personName: 'Dev Panab', deviceId: 'qa-laptop' };
        case 'companion_ping_state': return { snapshot: null, pingIssue: null };
        case 'companion_request': { const r = await window.__qaRequest(args.path, args.body); if (r.error) throw r.error; return r.data; }
        case 'update_check': return null;
        default: return null;
      }
    } } };
  });
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push({ who: 'dev', kind: 'desktop-panel', message: e.message }));
  const s = { page, ctx, p: dev, kind: 'panel', theme: 'light' };
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  rec.check(await visible(page.locator('.pc')), 'the desktop panel renders with the real day');
  const ready = await visible(page.getByRole('button', { name: /^(Take a break|Break|Check out)$/ }).first(), 20000);
  rec.check(ready, 'the panel settles on the checked-in day with its actions', (await page.locator('#app').innerText()).slice(0, 200));
  const state = async () => (await dev.dget('/api/v0/companion')).data.state;
  rec.note('how', 'the panel’s first view for a person checked in (WFH) since the morning', (await page.locator('#app').innerText()).slice(0, 300));
  await shot(s, 'd1-panel-in');
  for (const [button, expected] of [[/^(Take a break|Break)$/, 'break'], [/^(Back|I’m back|End break)$/, 'in'], [/^Check out$/, 'done']]) {
    const b = page.getByRole('button', { name: button }).first();
    if (!(await visible(b, 10000))) { rec.check(false, `the panel offers ${button}`, (await page.locator('#app').innerText()).slice(0, 300)); break; }
    const t0 = performance.now(); await b.click();
    let now = null; for (let i = 0; i < 20 && now !== expected; i++) { await delay(250); now = await state(); }
    rec.check(now === expected, `panel ${button} → the server says ${expected}`, now);
    rec.timing(`desktop panel ${String(button)} → server state ${expected}`, performance.now() - t0);
    await shot(s, `d2-panel-${expected}`);
  }
  const calls = await page.evaluate(() => window.__calls);
  const checks = calls.filter(([c]) => c === 'update_check');
  rec.check(checks.length > 0 && checks.every(([, a]) => a?.channel === 'test'), 'the panel checks for updates on the test channel', checks.slice(0, 2));
  const acts = calls.filter(([c, a]) => c === 'companion_request' && /^attendance\//.test(a?.path ?? '')).map(([, a]) => ({ path: a.path, via: a.body?.via, trigger: a.body?.trigger }));
  rec.note('how', 'what the desktop panel sends for each tap', acts);
  await ctx.close(); server.close(); await rm(root, { recursive: true, force: true });
  // Which manifest each app gets from the production web route (the same GitHub releases the apps read).
  for (const [who, agent] of [['desktop', 'tauri-plugin-updater/2.13.2'], ['phone', 'PulseShell/1.1.2 (android)']]) {
    const r = await fetch(`${base}/api/app-updates/test/latest.json`, { headers: { 'user-agent': agent } }).catch(() => null);
    const body = r && r.status === 200 ? await r.json() : null;
    rec.note('how', `update manifest served to the ${who} (${agent})`, r ? { status: r.status, version: body?.version, platforms: body?.platforms ? Object.keys(body.platforms) : body?.files?.map((f) => f.platform) } : 'unreachable');
  }
}

try {
  for (let i = 0; i < 240; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 239) throw Error('web did not start'); }
  browser = await chromium.launch({ headless: true });

  // ---------------------------------------------------------------------------------- 1. sign-in on the page
  rec.section('sign-in');
  const kabir = await open(P.kabir, 'desktop', 'light'); await uiSignIn(kabir);
  await shot(kabir, 'b1-first-page');
  const ahoro = await open(P.ahoro, 'phone', 'dark'); await uiSignIn(ahoro);
  await shot(ahoro, 'b1-first-page');
  for (const k of ['sana', 'meera', 'ishaan', 'vikram', 'neha', 'rila', 'dev']) await P[k].signIn();

  // ------------------------------------------------------------- 2. a DM between a computer and a phone, live
  rec.section('live chat: computer ↔ phone');
  const dm = (await P.kabir.post('/api/v0/chats/direct', { personId: P.ahoro.id })).data.id;
  await go(kabir, `/chats?channel=${dm}`); await go(ahoro, `/chats?channel=${dm}`);
  const kBox = kabir.page.getByRole('textbox', { name: /^Message Ahoro Rao/ }), aBox = ahoro.page.getByRole('textbox', { name: /^Message Kabir Shah/ });
  rec.check(await visible(kBox) && await visible(aBox), 'both have the conversation open with a composer');
  const lat = [];
  for (let i = 1; i <= 3; i++) {
    const text = `Live ${i}: rough cut is up (${randomUUID().slice(0, 4)})`;
    const t0 = await send(kabir, kBox, text);
    const mine = await until(log(kabir.page).getByText(text), t0, 5000);
    const theirs = await until(log(ahoro.page).getByText(text), t0, 20000);
    rec.check(theirs !== null, `message ${i} appears on the phone without a reload`, { mine, theirs });
    if (mine !== null) rec.timing(`computer: own bubble on screen (${i})`, mine);
    if (theirs !== null) { rec.timing(`computer → phone: message on the other screen (${i})`, theirs); lat.push(theirs); }
    await delay(400);
    const pos = await lastVisible(ahoro.page);
    rec.check(pos?.visible, `on the phone the new message ${i} is not hidden under the composer`, pos);
  }
  // Read ticks: the phone has the chat open, so Kabir's last message turns "Read".
  const t1 = performance.now();
  const read = await until(log(kabir.page).locator('article').last().locator('[aria-label="Read"]'), t1, 15000);
  // POLISH-2 (QA-E2E P1-3): the read receipt raises a chat event, so the sender's screen turns "Read" live every time.
  rec.check(read !== null, 'the sender’s tick turns "Read" live once the phone shows the message', null);
  if (read !== null) rec.timing('read tick after the phone shows the message', read);
  await shot(kabir, 'b2-dm'); await shot(ahoro, 'b2-dm');
  // The phone answers; the computer gets it live.
  const reply = `From the phone ${randomUUID().slice(0, 4)}`;
  const t2 = await send(ahoro, aBox, reply);
  const back = await until(log(kabir.page).getByText(reply), t2, 20000);
  rec.check(back !== null, 'the phone reply appears on the computer live');
  if (back !== null) rec.timing('phone → computer: message on the other screen', back);
  rec.check(await fits(ahoro), 'the phone chat fits 390 px without sideways scroll');

  // EST-2182: an arrival must leave Send reachable after the keyboard is dismissed, too. A pointer resting on
  // the old overlapping bubble kept its hover-paused timer alive forever. Exercise that reach in both phone themes.
  const lightPhone = await open(P.ahoro, 'phone', 'light');
  await go(lightPhone, `/chats?channel=${dm}`);
  for (const phone of [ahoro, lightPhone]) {
    const box = phone.page.getByRole('textbox', { name: /^Message Kabir Shah/ });
    const message = `After arrival (${phone.theme}) ${randomUUID().slice(0, 4)}`;
    await box.fill(message);
    await phone.page.evaluate((theme) => window.dispatchEvent(new CustomEvent('pulse:arrival', { detail: {
      id: `send-clearance-${crypto.randomUUID()}`, title: `Synthetic arrival while replying (${theme})`, href: '/chats', kind: 'chat',
    } })), phone.theme);
    const island = phone.page.locator('[data-island]'), content = phone.page.locator('[data-island-content]');
    await expect(island).toHaveAttribute('data-open', '');
    await log(phone.page).locator('article').last().click(); // normal message tap dismisses composer focus
    // The real queue may still be showing an older arrival; measure the injected item while its actions exist.
    await expect(content.getByRole('button', { name: `Synthetic arrival while replying (${phone.theme})`, exact: true })).toBeVisible({ timeout: 20000 });
    await expect(box).toHaveValue(message);
    const button = phone.page.getByRole('button', { name: 'Send', exact: true });
    const target = await button.boundingBox();
    await phone.page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    const geometry = await button.evaluate((el) => {
      const r = el.getBoundingClientRect(), c = document.querySelector('[data-island-content]');
      const composer = document.querySelector('[data-chat-composer]').getBoundingClientRect(), bubble = c.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const actions = [...c.querySelectorAll('button,a')].map((action) => {
        const a = action.getBoundingClientRect(), h = document.elementFromPoint(a.x + a.width / 2, a.y + a.height / 2);
        return { label: action.getAttribute('aria-label') ?? action.textContent, reachable: !!h && action.contains(h) };
      });
      return { send: r.toJSON(), bubble: bubble.toJSON(), composerTop: composer.top, focus: document.activeElement?.tagName,
        theme: document.documentElement.dataset.theme, sendReachable: !!hit && el.contains(hit), actions,
        bubbleClear: bubble.bottom <= composer.top && bubble.top >= 56 && bubble.left >= 0 && bubble.right <= innerWidth };
    });
    rec.note('how', `phone ${phone.theme}: arrival/Send geometry after blur and pointer reach`, geometry);
    rec.check(geometry.theme === phone.theme && geometry.focus !== 'TEXTAREA' && geometry.sendReachable && geometry.bubbleClear,
      `phone ${phone.theme}: a visible arrival clears Send after composer blur`, geometry);
    rec.check(geometry.actions.length >= 2 && geometry.actions.every((a) => a.reachable), `phone ${phone.theme}: arrival actions remain reachable`, geometry.actions);
    await shot(phone, 'b2-arrival-send-clear');
    const t = performance.now(); await button.click();
    rec.check(await until(log(kabir.page).getByText(message), t, 20000) !== null, `phone ${phone.theme}: normal Send during an arrival reaches desktop`);
    // Sending restores composer focus; blur normally again and exercise a real arrival action.
    await log(phone.page).locator('article').last().click();
    await content.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(island).not.toHaveAttribute('data-open', '');
  }
  await lightPhone.ctx.close();

  // ---------------------------------------------- 3. three people in the pod: a mention reaches Pip and the bell
  rec.section('pod chat: mention → island and bell');
  const sana = await open(P.sana, 'desktop', 'dark');
  await go(sana, '/tasks');
  const pod = (await P.kabir.get('/api/v0/chats')).data.channels.find((c) => c.kind === 'pod' && c.name === 'Pod 1').id;
  await go(kabir, `/chats?channel=${pod}`);
  const bell = sana.page.getByRole('button', { name: /^Notifications/ });
  const before = await settledBell(sana.page);
  const box = kabir.page.getByRole('textbox', { name: /^Message Pod 1/ });
  await box.fill(`@${P.sana.username} `); await box.press('End');
  await box.pressSequentially('can you check the drone permit today?'); const t3 = performance.now(); await box.press('Enter');
  const island = await until(sana.page.locator('[aria-label*="mentioned you"], [aria-label*="Kabir"]').filter({ hasText: /Kabir|mentioned/ }), t3, 25000);
  const counted = await bellRises(sana.page, before, t3);
  rec.check(counted !== null, "Sana's bell counts the mention without a reload", { before, after: await bellCount(sana.page) });
  if (island !== null) rec.timing('mention → Pip island on the mentioned person’s screen', island); else rec.note('P2', 'a mention did not show on Pip’s island within 25 s (bell only)', null);
  if (counted !== null) rec.timing('mention → bell count on the mentioned person’s screen', counted);
  await shot(sana, 'b3-island');
  await bell.click();
  const panel = sana.page.getByRole('dialog', { name: 'Notifications' });
  rec.check(await visible(panel.getByText(/Kabir mentioned you in Pod 1/)), 'the panel shows "Kabir mentioned you in Pod 1"');
  await shot(sana, 'b3-panel');
  // Reply straight from the card.
  const card = panel.locator('li[data-card]').filter({ hasText: /mentioned you/ }).first();
  const replyBtn = card.getByRole('button', { name: 'Reply' });
  if (await visible(replyBtn, 5000)) {
    await replyBtn.click();
    const field = card.getByRole('textbox').first(); const text = `On it (${randomUUID().slice(0, 4)})`;
    await field.fill(text); const t4 = performance.now(); await field.press('Enter');
    const there = await until(log(kabir.page).getByText(text), t4, 20000);
    rec.check(there !== null, 'a reply typed in the notification card lands in the pod chat for the others');
    if (there !== null) rec.timing('reply from the panel → on the sender’s screen', there);
  } else rec.note('P2', 'no Reply on the mention card', await card.innerText().catch(() => null));
  await sana.page.keyboard.press('Escape');

  // ---------------------------------------- 4. an ask across pods, answered from the panel, seen by the asker
  rec.section('tasks: ask across pods via the panel');
  const meera = await open(P.meera, 'desktop', 'light');
  await go(meera, '/tasks');
  const made = await P.meera.post('/api/v0/work/tasks', { title: `Share the 9:16 reel (${randomUUID().slice(0, 4)})`, assigneeId: P.kabir.id, note: 'For the Lakeview ads' });
  rec.check(!!made.data?.asked, 'Meera giving Kabir (another pod) a task makes an ask', made.data);
  await go(kabir, '/tasks');
  const kBell = kabir.page.getByRole('button', { name: /^Notifications/ });
  const kBefore = await settledBell(kabir.page);
  const made2 = await P.meera.post('/api/v0/work/tasks', { title: `Send the logo files (${randomUUID().slice(0, 4)})`, assigneeId: P.kabir.id }); const t5 = performance.now();
  rec.check(!!made2.data?.asked, 'a second ask while Kabir watches', made2.data);
  const askSeen = await bellRises(kabir.page, kBefore, t5, 20000);
  // ATT (0860): a family pings a person at most its daily limit (tasks_assigned: 6); past it a notification is quiet:
  // it waits in the panel and the bell's number does not count it. The seeded world has already given Kabir work today.
  const quietAsk = askSeen === null && ((await P.kabir.get('/api/v0/notices')).data?.rows ?? []).some((n) => n.quiet && String(n.title).includes('Send the logo files'));
  rec.check(askSeen !== null || quietAsk, "the asked person's bell counts the new ask without a reload (or ATT keeps it quiet)", { before: kBefore, after: await bellCount(kabir.page), quietAsk });
  if (askSeen !== null) rec.timing('ask → bell count on the asked person’s screen', askSeen);
  await kBell.click();
  const kPanel = kabir.page.getByRole('dialog', { name: 'Notifications' });
  await openStacks(kPanel);
  const askCard = kPanel.locator('li[data-card]').filter({ hasText: /Share the 9:16 reel/ }).first();
  rec.check(await visible(askCard), 'the ask is in the panel');
  await shot(kabir, 'b4-ask-card');
  const take = askCard.getByRole('button', { name: /Accept|Take it|Yes/ });
  if (await visible(take, 5000)) {
    await take.click(); await delay(1500);
    const t6 = performance.now();
    await meera.page.getByRole('button', { name: /^Notifications/ }).click();
    const answered = await until(meera.page.getByRole('dialog', { name: 'Notifications' }).getByText(/Kabir|accepted|took/), t6, 20000);
    rec.check(answered !== null, "the asker's panel shows the answer");
    await shot(meera, 'b4-answer');
  } else rec.check(false, 'the ask card has an Accept button', await askCard.innerText().catch(() => null));
  await kabir.page.keyboard.press('Escape');

  // ---------------------------------------------------------- 5. attendance on a phone; the head sees it
  rec.section('attendance: phone check-in and a leave request');
  const ishaan = await open(P.ishaan, 'phone', 'light');
  await go(ishaan, '/me');
  await shot(ishaan, 'b5-my-desk');
  const checkIn = ishaan.page.getByRole('button', { name: /^Check in$/ }).first();
  if (await visible(checkIn, 15000)) {
    const t7 = performance.now(); await checkIn.click();
    const chip = await until(ishaan.page.getByText(/Checked in|Check out/).first(), t7, 15000);
    rec.check(chip !== null, 'tapping Check in on the phone shows the checked-in state');
    if (chip !== null) rec.timing('phone: Check in tap → checked-in state on screen', chip);
    await shot(ishaan, 'b5-checked-in');
  } else rec.check(false, 'My desk on the phone offers Check in', await ishaan.page.locator('main').innerText().catch(() => null));
  const vikram = await open(P.vikram, 'desktop', 'dark');
  await go(vikram, '/hr');
  rec.note('how', "the pod head's HR view after Ishaan checks in", (await vikram.page.locator('main').innerText().catch(() => '')).slice(0, 300));
  await shot(vikram, 'b5-head-hr');
  // Leave through the form on the phone; the head approves in the panel; the phone is told.
  const apply = ishaan.page.getByRole('button', { name: 'Apply for leave' }).first();
  if (await visible(apply, 10000)) {
    await apply.click();
    const dlg = ishaan.page.getByRole('dialog', { name: 'Apply for leave' });
    const day = (n) => new Date(Date.now() + 330 * 60e3 + n * 86400e3).toISOString().slice(0, 10);
    await dlg.getByLabel(/^From/).fill(day(10)).catch(() => {});
    await dlg.getByLabel(/^To/).fill(day(10)).catch(() => {});
    await dlg.getByLabel(/Reason/).fill('Synthetic family event').catch(() => {});
    await shot(ishaan, 'b6-leave-form');
    const vBefore = await settledBell(vikram.page);
    await dlg.getByRole('button', { name: /Send request/ }).click();
    rec.check(await visible(ishaan.page.getByText(/Leave request sent for approval/)), 'the phone confirms the leave request');
    const t8 = performance.now();
    const headSees = await bellRises(vikram.page, vBefore, t8, 25000);
    if (headSees !== null) rec.timing('leave request → head’s bell', headSees);
    await vikram.page.getByRole('button', { name: /^Notifications/ }).click();
    await openStacks(vikram.page.getByRole('dialog', { name: 'Notifications' }));
    const lc = vikram.page.getByRole('dialog', { name: 'Notifications' }).locator('li[data-card]').filter({ hasText: /Ishaan|leave/i }).first();
    rec.check(await visible(lc), "the head's panel shows Ishaan's leave");
    await shot(vikram, 'b6-head-panel');
    const approve = lc.getByRole('button', { name: /Approve/ });
    if (await visible(approve, 5000)) {
      const iBefore = await settledBell(ishaan.page);
      await approve.click(); const t9 = performance.now();
      const told = await bellRises(ishaan.page, iBefore, t9, 25000);
      rec.check(told !== null, 'the phone is told about the decision without a reload');
      if (told !== null) rec.timing('approval → requester’s bell', told);
    } else rec.check(false, 'the leave card has Approve', await lc.innerText().catch(() => null));
  } else rec.check(false, 'My desk on the phone offers Apply for leave');

  // ------------------------------- 6. the desktop panel (Tauri UI) against the real API with a paired laptop token
  rec.section('desktop panel');
  await desktopPanel();

  // --------------------------------------------------------------- 7. the gallery: key pages × size × theme
  rec.section('pages: 1440 and 390, light and dark');
  // Work lives under /tasks; the old /work gallery entry captured a 404 as a successful page.
  const pages = { kabir: ['/', '/me', '/chats', '/tasks', '/notifications'], vikram: ['/me/approvals', '/tasks?view=team'], neha: ['/hr', '/hr?tab=onboard'], rila: ['/dashboard', '/people'] };
  for (const kind of ['desktop', 'phone']) for (const theme of ['light', 'dark']) {
    for (const [who, list] of Object.entries(pages)) {
      const s = await open(P[who], kind, theme);
      for (const path of list) {
        const ms = await go(s, path);
        const ok = await fits(s);
        if (!ok) rec.note('P2', `${path} scrolls sideways at ${VIEW[kind].width} (${theme})`, { who });
        // The header's check-in chip must stay readable and tappable (Pip's island sits in the same bar).
        const measure = () => s.page.evaluate(() => {
          // An arrival opening the island across a phone's bar covers it for five seconds by design: measured at rest.
          const b = document.querySelector('button[data-state][data-tone]'); if (!b || document.querySelector('[data-island][data-open]')) return null;
          // A chip the bar does not show (no box) cannot be covered: it is not measured.
          if (!b.getClientRects().length || !b.getBoundingClientRect().width) return null;
          const r = b.getBoundingClientRect(), pts = [[r.left + 6, r.top + r.height / 2], [r.left + r.width / 2, r.top + r.height / 2], [r.right - 6, r.top + r.height / 2]];
          const hidden = pts.filter(([x, y]) => { const e = document.elementFromPoint(x, y); return e && !b.contains(e) && !e.contains(b); }).length;
          return { label: b.innerText.trim(), state: b.dataset.state, hidden, width: Math.round(r.width) };
        });
        // A page that redirects once it has loaded (/chats opens the last conversation) can replace the document while it
        // is measured: measure again on the settled page.
        const chip = await measure().catch(async () => { await s.page.waitForLoadState('load'); await delay(500); return measure(); });
        if (chip) chips.push({ who, path, kind, theme, ...chip });
        rec.timing(`${path} as ${who} (${kind}, ${theme})`, ms);
        await shot(s, `g-${who}-${path.replace(/\W+/g, '_') || 'home'}`);
      }
      await s.ctx.close();
    }
  }
  const covered = chips.filter((c) => c.hidden);
  // POLISH-2 (QA-E2E P1-4): the island follows its slot whenever a neighbour appears or changes width.
  rec.check(!covered.length, covered.length ? `Pip's island covers the header check-in chip (${covered.length} of ${chips.length} page views): ${[...new Set(covered.map((c) => `${c.kind} "${c.label}"`))].join(', ')}` : `the header check-in chip is clear on all ${chips.length} page views`, covered.slice(0, 8));
  await tick(stack, rec);
} catch (e) {
  rec.check(false, 'browser journeys ran to the end', String(e?.stack ?? e).slice(0, 2000));
}
rec.note('how', `page errors and console errors seen: ${errors.length}`, errors.slice(0, 20));
if (errors.some((e) => e.message)) rec.check(false, 'no uncaught page errors', errors.filter((e) => e.message).slice(0, 10));
const report = rec.finish({ base });
await browser?.close(); web.kill(); await stack.close();
process.exit(report.failed ? 1 : 0);
