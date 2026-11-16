// AGENT-CHANNELS: the API and (PULSE_AUTH_BROWSER=1) a Playwright walk of an AI employee's channel settings, the
// listening room and its live transcript, on a disposable synthetic company (tests/core/test_agent_channels_browser.py).
// The browser's microphone is Chromium's fake device playing a synthetic WAV made here (tones, no voice); the
// transcriber is the stub (what tools/listen-transcribe.py does with PULSE_LISTEN_STT=stub), so no model and no audio
// leave this machine. Nothing is sent to Telegram or WhatsApp: neither has credentials here, and the screens say so.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../dist/app.js';

const pool = new pg.Pool(JSON.parse(process.env.TEST_API_CONFIG)), owner = new pg.Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const worker = new pg.Pool(JSON.parse(process.env.TEST_WORKER_CONFIG));
const app = createApp(pool, pool), org = process.env.PULSE_ORG_ID, ADMIN = process.env.TEST_ADMIN_EMAIL, MEMBER = process.env.TEST_MEMBER;
const AGENT = process.env.TEST_AGENT_ID, AGENT_NAME = process.env.TEST_AGENT_NAME;
const shots = process.env.AGENT_CHANNELS_SHOTS || join(tmpdir(), 'agent-channels-shots');
let apiChecks = 0, browserChecks = 0;
const call = async (path, who, method = 'GET', body, expected = 200) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method, headers: { 'cf-access-authenticated-user-email': who }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${method} ${path}: ${r.body}`);
  return r.json();
};
const inOrg = async (p, sql, args = []) => {
  const c = await p.connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [org]); const r = await c.query(sql, args); await c.query('commit'); return r.rows; }
  catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
};
/** One pass of the stub transcriber and the forwarder, as tools/listen-transcribe.py does with PULSE_LISTEN_STT=stub. */
async function transcribeStub() {
  let n = 0;
  for (;;) {
    const [{ j }] = await inOrg(worker, 'select pulse.listen_chunk_claim() j');
    if (!j) break;
    const secs = Math.max(1, (j.ms || 10000) / 1000);
    await inOrg(worker, 'select pulse.listen_chunk_done($1,$2,$3::jsonb,null)', [j.sessionId, j.seq,
      JSON.stringify([{ s: 0, e: secs, t: `Synthetic speech, part ${j.seq + 1}: the client asks for a quotation for 40 signboards by Friday.` }])]);
    n++;
  }
  await inOrg(worker, 'select pulse.listen_forward()');
  return n;
}
/** A synthetic WAV: 16 kHz mono, a few seconds of alternating tones (no voice). */
function syntheticWav(file, seconds = 30) {
  const rate = 16000, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (Math.floor(i / 8000) % 2 ? 440 : 660) * i / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([h, data]));
}

/** LISTEN-FAST: a stand-in for the live speech service on 127.0.0.1 (no sound leaves this machine): the token endpoint
 *  and a minimal WebSocket server that answers setup, counts the 16 kHz PCM it gets, and says synthetic words: an interim
 *  after 0.8 s of sound and the finished sentence after 1.6 s, twice. It records when it sent each, for the latency. */
function mockSpeech() {
  const log = { tokens: 0, setups: [], audioBytes: 0, sent: [] };
  const lines = [['Synthetic client needs forty', 'Synthetic client needs forty signboards by Friday.'], ['We agreed the budget', 'We agreed the budget is two lakh rupees.']];
  const frame = (text) => { const b = Buffer.from(text); const h = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]); return Buffer.concat([h, b]); };
  const srv = httpServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/auth_tokens')) { log.tokens++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'auth_tokens/synthetic-walk' })); return; }
    res.writeHead(404); res.end();
  });
  srv.on('upgrade', (req, sock) => {
    if (!/access_token=auth_tokens%2Fsynthetic-walk|access_token=auth_tokens\/synthetic-walk/.test(req.url)) { sock.destroy(); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0), heard = 0, line = 0, stage = 0;
    const say = (o, what) => { log.sent.push({ what, at: Date.now() }); sock.write(frame(JSON.stringify(o))); };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4), body = Buffer.from(buf.subarray(off + 4, off + 4 + len)); buf = buf.subarray(off + 4 + len);
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        if (op === 8) { sock.end(); return; }
        if (op !== 1) continue;
        const m = JSON.parse(body.toString());
        if (m.setup) { log.setups.push(m.setup); say({ setupComplete: {} }, 'ready'); continue; }
        const a = m.realtimeInput?.audio;
        if (!a || line >= lines.length) continue;
        const n = Buffer.from(a.data, 'base64').length; log.audioBytes += n; heard += n;
        if (stage === 0 && heard >= 25600) { stage = 1; say({ serverContent: { interimInputTranscription: { text: lines[line][0] } } }, `interim${line}`); }
        else if (stage === 1 && heard >= 51200) { say({ serverContent: { inputTranscription: { text: lines[line][1] } } }, `final${line}`); line++; stage = 0; heard = 0; }
      }
    });
    sock.on('error', () => {});
  });
  return { srv, log };
}

let browser, web, speech;
const restore = () => { try { execFileSync('git', ['checkout', '--', 'apps/web/tsconfig.json', 'apps/web/next-env.d.ts'], { cwd: '../..', stdio: 'ignore' }); } catch { /* not a checkout */ } };
try {
  // ---- API: waiting states, admin settings, a listening session end to end ----------------------------------------
  const tg = await call('telegram/link', MEMBER);
  assert.equal(tg.bot, null); assert.equal(tg.waiting, 'token');
  const wa = await call('whatsapp/link', MEMBER);
  assert.equal(wa.on, false); assert.equal(wa.ready, false);
  await call('whatsapp/link', MEMBER, 'POST', { agentId: AGENT }, 409);
  await call('agent-channels', MEMBER, 'PUT', { listenOn: true }, 403);
  // FIX-CHAT-AI: listening is on by default; an admin's off stops new sessions until switched on again.
  await call('agent-channels', ADMIN, 'PUT', { listenOn: false });
  await call('listen/sessions', ADMIN, 'POST', { agentId: AGENT, title: 'Synthetic', consent: true }, 409);
  const s = await call('agent-channels', ADMIN, 'PUT', { listenOn: true, listenRetentionDays: 14 });
  assert.deepEqual(s.listen, { on: true, retentionDays: 14, live: true }); // LISTEN-FAST (2092): live words on by default
  await call('listen/sessions', ADMIN, 'POST', { agentId: AGENT, title: 'Synthetic', consent: false }, 400);
  const started = await call('listen/sessions', ADMIN, 'POST', { agentId: AGENT, title: 'Synthetic API call', purpose: 'quotation', consent: true });
  const audio = Buffer.from('synthetic-audio-bytes').toString('base64');
  await call(`listen/sessions/${started.id}/audio`, ADMIN, 'POST', { seq: 0, ms: 10000, mime: 'audio/webm', audio });
  await call(`listen/sessions/${started.id}/audio`, ADMIN, 'POST', { seq: 1, ms: 10000, mime: 'text/html', audio }, 400);
  await call(`listen/sessions/${started.id}/audio`, MEMBER, 'POST', { seq: 1, ms: 10000, mime: 'audio/webm', audio }, 404);
  assert.equal(await transcribeStub(), 1);
  const v = await call(`listen/sessions/${started.id}`, ADMIN);
  assert.equal(v.segments.length, 1); assert.match(v.segments[0].text, /40 signboards/);
  await call(`listen/sessions/${started.id}`, MEMBER, 'GET', undefined, 404);
  await call(`listen/sessions/${started.id}/stop`, ADMIN, 'POST', {});
  await transcribeStub();
  const ev = await call('listen/events?after=0', ADMIN);
  assert.deepEqual(ev.events.filter((e) => e.sessionId === started.id).map((e) => e.type), ['listen.started', 'listen.window', 'listen.stopped']);
  await call('listen/events', MEMBER, 'GET', undefined, 403);
  await call(`listen/sessions/${started.id}/delete`, ADMIN, 'POST', {});

  // ---- the browser walk --------------------------------------------------------------------------------------------
  if (process.env.PULSE_AUTH_BROWSER === '1') {
    mkdirSync(shots, { recursive: true });
    const wav = join(shots, 'synthetic-tones.wav'); syntheticWav(wav);
    const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const probe = createServer(); await new Promise((d) => probe.listen(0, '127.0.0.1', d)); const port = probe.address().port; await new Promise((d) => probe.close(d));
    const base = `http://127.0.0.1:${port}`;
    web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true, stdio: 'ignore',
      env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-agent-channels', PULSE_PUBLIC_LOGIN_ENABLED: '' } });
    for (let i = 0; i < 480; i++) { try { if ((await fetch(base + '/login')).status < 500) break; } catch { /* starting */ } await delay(250); if (i === 479) throw Error('web did not start'); }
    browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] });
    const ctx = async (who, width, theme) => {
      const c = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, permissions: ['microphone'], extraHTTPHeaders: { 'cf-access-authenticated-user-email': who } });
      await c.addInitScript((t) => localStorage.setItem('pulse.theme', t), theme);
      return c;
    };
    // 1. The AI employee's channels on its AI tab (waiting states, no credentials on this machine).
    for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
      const c = await ctx(ADMIN, width, theme), page = await c.newPage(), errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/people/${AGENT}?tab=ai`, { timeout: 180000 });
      const box = page.getByTestId('agent-channels');
      await expect(box).toContainText(`Talk to ${AGENT_NAME} on Telegram`, { timeout: 120000 });
      await expect(box).toContainText('Waiting for the Vitals OS bot token', { timeout: 30000 }); // LISTEN-FAST: the dev server may still be compiling the link routes
      await expect(box).toContainText(`Talk to ${AGENT_NAME} on WhatsApp`);
      await expect(box).toContainText('Connect your WhatsApp Business number first');
      await expect(box).toContainText('Company channels (admins)');
      await expect(box.getByRole('link', { name: 'Start listening' })).toHaveAttribute('href', `/listen?agent=${AGENT}`);
      browserChecks += 6;
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(wide <= 1, `no sideways scroll at ${width}px (${wide})`); browserChecks++;
      await box.screenshot({ path: join(shots, `channels-${width}-${theme}.png`) });
      assert.deepEqual(errors, []); await c.close();
    }
    // 2. The listening room: consent, start, the Listening indicator, the live transcript, the AI employee's reply, stop.
    for (const [width, theme] of [[390, 'light'], [1440, 'dark']]) {
      const c = await ctx(ADMIN, width, theme), page = await c.newPage(), errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/listen?agent=${AGENT}`, { timeout: 180000 });
      await expect(page.getByRole('heading', { name: 'Listen', exact: true }).first()).toBeVisible({ timeout: 120000 }); // LISTEN-FAST: the page's heading is "Listen" (SETTINGS-APPLE)
      // SETTINGS-APPLE (T1.4.1): Listen is one big button; consent is a "Did you tell everyone?" confirmation before
      // recording starts (no tick box, no name field: the name is made for you).
      const start = page.getByRole('button', { name: 'Start listening' });
      await expect(start).toBeEnabled(); browserChecks++;
      await page.getByLabel('What the talk is about').selectOption('quotation');
      await page.screenshot({ path: join(shots, `listen-ready-${width}-${theme}.png`), fullPage: true });
      const before = new Date().toISOString();
      await start.click();
      const ask = page.getByRole('alertdialog').filter({ hasText: 'Did you tell everyone?' });
      await expect(ask).toContainText('must know it is being recorded'); browserChecks++;
      await ask.getByRole('button', { name: 'Yes, start listening' }).click();
      const live = page.getByLabel('Listening now');
      await expect(live).toBeVisible({ timeout: 20000 });
      await expect(page.getByText('Everyone was told this is being recorded.')).toBeVisible();
      browserChecks += 2;
      // The fake microphone plays the synthetic tones; the first 10-second piece reaches the server.
      const [{ id }] = await inOrg(owner, "select id from pulse.listen_session where purpose='quotation' and consent_at is not null and started_at >= $1 order by started_at desc limit 1", [before]);
      for (let i = 0; i < 80; i++) { const [{ n }] = await inOrg(owner, 'select count(*)::int n from pulse_priv.listen_chunk where session_id=$1', [id]); if (n) break; await delay(250); }
      const [{ mime }] = await inOrg(owner, 'select mime from pulse_priv.listen_chunk where session_id=$1 order by seq limit 1', [id]);
      assert.match(mime, /^audio\//); browserChecks++;
      assert.ok(await transcribeStub() >= 1);
      await expect(page.getByTestId('transcript')).toContainText('40 signboards', { timeout: 15000 }); browserChecks++;
      const [{ channel_id: ch }] = await inOrg(owner, 'select channel_id from pulse.listen_session where id=$1', [id]);
      await inOrg(owner, "insert into pulse.chat_message (org_id, channel_id, author_id, body, client_id) values ($1,$2,$3,'Draft quotation (synthetic): 40 signboards, delivery Friday.',gen_random_uuid())", [org, ch, AGENT]);
      await expect(page.getByLabel('What the AI helper did')).toContainText('Draft quotation (synthetic)', { timeout: 15000 }); browserChecks++;
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(wide <= 1, `no sideways scroll at ${width}px (${wide})`); browserChecks++;
      await page.screenshot({ path: join(shots, `listen-live-${width}-${theme}.png`), fullPage: true });
      await live.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(live).toHaveCount(0, { timeout: 20000 });
      const [{ stopped }] = await inOrg(owner, 'select stopped_at is not null stopped from pulse.listen_session where id=$1', [id]);
      assert.equal(stopped, true); browserChecks += 2;
      await transcribeStub();
      await page.screenshot({ path: join(shots, `listen-stopped-${width}-${theme}.png`), fullPage: true });
      assert.deepEqual(errors, []); await c.close();
    }
    // 3. LISTEN-FAST: instant words through a stand-in speech service on this machine (the API's token, the browser's
    //    stream, interim words, finished sentences on the server), the level meter, the helper's action as a card, and
    //    the summary after Stop. Times are measured in the page (performance.now) and against the stand-in's clock.
    speech = mockSpeech(); await new Promise((d) => speech.srv.listen(0, '127.0.0.1', d));
    const sp = `127.0.0.1:${speech.srv.address().port}`;
    Object.assign(process.env, { PULSE_LISTEN_GEMINI_KEY: 'AIzaSyntheticWalkKeySynthetic0001', PULSE_LISTEN_LIVE_TOKENS: `http://${sp}/auth_tokens`, PULSE_LISTEN_LIVE_WS: `ws://${sp}/ws` });
    const timings = [];
    for (const [width, theme] of [[1440, 'light'], [363, 'dark'], [363, 'light'], [1440, 'dark']]) {
      const c = await ctx(ADMIN, width, theme), page = await c.newPage(), errors = [];
      // The screenshots are of Listen: the shell's island stays calm (arrivals only raise its badge; Settings → Devices).
      await c.addInitScript(() => localStorage.setItem('pulse-island-calm', '1'));
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/listen?agent=${AGENT}`, { timeout: 180000 });
      const start = page.getByRole('button', { name: 'Start listening' });
      await expect(start).toBeEnabled({ timeout: 120000 });
      await page.getByLabel('What the talk is about').selectOption('meeting');
      await expect(page.getByTestId('listen-promise')).toHaveText(`${AGENT_NAME} will note decisions and create tasks for follow-ups.`); browserChecks++;
      await delay(500); await page.screenshot({ path: join(shots, `instant-ready-${width}-${theme}.png`) }); // after the cards' 260 ms entrance
      const before = new Date().toISOString(), sentFrom = speech.log.sent.length;
      await start.click();
      const ask = page.getByRole('alertdialog').filter({ hasText: 'Did you tell everyone?' });
      await expect(ask).toContainText("Google's speech service"); browserChecks++;
      // In the page: when "Yes" is pressed, when the live bar shows, when the meter first moves, when words show.
      await page.evaluate(() => {
        const t = (window.__lf = { yes: 0, bar: 0, meter: 0, interim: 0, final: 0, wall: {} });
        const mark = (k) => { if (!t[k]) { t[k] = performance.now(); t.wall[k] = Date.now(); } };
        document.addEventListener('click', (e) => { if (e.target.closest('button')?.textContent?.includes('Yes, start listening')) mark('yes'); }, true);
        const look = () => {
          if (document.querySelector('[aria-label="Listening now"]')) mark('bar');
          const m = document.querySelector('[data-testid="level-meter"]'); if (m && Number(m.style.getPropertyValue('--lvl')) > 0) mark('meter');
          if (document.querySelector('[data-testid="interim"]')) mark('interim');
          if (document.querySelector('[data-testid="transcript"]')?.textContent?.includes('signboards by Friday')) mark('final');
          requestAnimationFrame(look);
        };
        new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true }); look();
      });
      await ask.getByRole('button', { name: 'Yes, start listening' }).click();
      const live = page.getByLabel('Listening now');
      await expect(live).toBeVisible({ timeout: 20000 });
      await expect(live).toContainText('Words show as you speak', { timeout: 15000 }); browserChecks += 2;
      await expect(page.getByTestId('transcript')).toContainText('signboards by Friday', { timeout: 20000 });
      await expect(page.getByTestId('transcript')).toContainText('two lakh rupees', { timeout: 20000 }); browserChecks += 2;
      const t = await page.evaluate(() => window.__lf);
      const sent = Object.fromEntries(speech.log.sent.slice(sentFrom).map((s) => [s.what, s.at]));
      timings.push({ width, theme, barMs: Math.round(t.bar - t.yes), meterMs: Math.round(t.meter - t.yes),
        interimAfterServiceMs: t.wall.interim && sent.interim0 ? t.wall.interim - sent.interim0 : null, finalAfterServiceMs: t.wall.final && sent.final0 ? t.wall.final - sent.final0 : null,
        firstWordsAfterYesMs: Math.round(t.interim - t.yes) });
      // The target is 300 ms in a production build. This walk runs `next dev` (unminified React) on a shared, often busy CPU
      // (measured 181-643 ms), so it guards against a regression (the bar waiting for the microphone and the server again)
      // at 1 s and writes every measurement to instant-timings.json; the LISTEN-FAST report lists them all.
      assert.ok(t.bar - t.yes < 1000, `the live bar shows within 1 s of Yes on the dev server (${Math.round(t.bar - t.yes)} ms)`); browserChecks++;
      assert.ok(t.meter > 0, 'the level meter moved'); browserChecks++;
      const [{ id }] = await inOrg(owner, "select id from pulse.listen_session where purpose='meeting' and started_at >= $1 order by started_at desc limit 1", [before]);
      for (let i = 0; i < 40; i++) { const [{ n }] = await inOrg(owner, 'select count(*)::int n from pulse.listen_segment where session_id=$1', [id]); if (n >= 2) break; await delay(250); }
      const rows = await inOrg(owner, 'select seq, text from pulse.listen_segment where session_id=$1 order by seq', [id]);
      assert.deepEqual(rows.map((r) => r.text), ['Synthetic client needs forty signboards by Friday.', 'We agreed the budget is two lakh rupees.']); browserChecks++;
      const [{ n: audioRows }] = await inOrg(owner, 'select count(*)::int n from pulse_priv.listen_chunk where session_id=$1', [id]);
      assert.equal(audioRows, 0, 'with live words no sound is stored on the server'); browserChecks++;
      const [{ n: meters }] = await inOrg(owner, 'select count(*)::int n from pulse_priv.listen_live_use where session_id=$1', [id]);
      assert.equal(meters, 1, 'the stream is on the budget meter'); browserChecks++;
      // The helper made a task: it shows as a card that opens it.
      const [{ channel_id: ch }] = await inOrg(owner, 'select channel_id from pulse.listen_session where id=$1', [id]);
      const taskId = '0a1b2c3d-0000-4000-8000-00000000f00d';
      await inOrg(owner, "insert into pulse.chat_message (org_id, channel_id, author_id, body, client_id) values ($1,$2,$3,$4,gen_random_uuid())",
        [org, ch, AGENT, `Made a task: [Order 40 signboards (synthetic)](/tasks/${taskId}). The budget is noted as a decision.`]);
      const card = page.getByLabel('What the AI helper made').getByRole('link', { name: /Order 40 signboards/ });
      await expect(card.first()).toBeVisible({ timeout: 15000 });
      await expect(card.first()).toHaveAttribute('href', `/tasks/${taskId}`); browserChecks += 2;
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(wide <= 1, `no sideways scroll at ${width}px (${wide})`); browserChecks++;
      await delay(500); await page.screenshot({ path: join(shots, `instant-live-${width}-${theme}.png`) }); // after the cards' 260 ms entrance
      await live.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(live).toHaveCount(0, { timeout: 20000 });
      const after = page.getByLabel('Summary of the talk');
      await expect(after).toContainText('Decided', { timeout: 20000 });
      await expect(after).toContainText('We agreed the budget is two lakh rupees.');
      await expect(after.getByRole('link', { name: /Order 40 signboards/ })).toBeVisible();
      await expect(after.getByRole('button', { name: 'Keep as a meeting' })).toBeVisible(); browserChecks += 4;
      const wide2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(wide2 <= 1, `no sideways scroll after Stop at ${width}px (${wide2})`); browserChecks++;
      await delay(500); await page.screenshot({ path: join(shots, `instant-after-${width}-${theme}.png`) }); // after the cards' 260 ms entrance
      assert.deepEqual(errors, []); await c.close();
    }
    assert.ok(speech.log.tokens >= 4 && speech.log.setups.every((s) => s.model === 'models/gemini-3.5-transcribe-live' && s.generationConfig.responseModalities[0] === 'TEXT'));
    browserChecks++;
    writeFileSync(join(shots, 'instant-timings.json'), JSON.stringify(timings, null, 1));
    console.log(JSON.stringify({ instantTimings: timings }));
  }
  writeFileSync(process.env.AGENT_CHANNELS_REPORT || join(tmpdir(), 'agent-channels.json'), JSON.stringify({ apiChecks, browserChecks, shots, syntheticOnly: true, sent: 0 }));
  console.log(JSON.stringify({ apiChecks, browserChecks, shots }));
} finally {
  await browser?.close().catch(() => {});
  speech?.srv.close();
  if (web) { try { process.kill(-web.pid, 'SIGTERM'); } catch { /* gone */ } restore(); }
  await app.close().catch(() => {});
  await Promise.all([pool.end(), owner.end(), worker.end()]).catch(() => {});
}
