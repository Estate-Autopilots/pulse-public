// AGENT-CHANNELS: the API and (PULSE_AUTH_BROWSER=1) a Playwright walk of an AI employee's channel settings, the
// listening room and its live transcript, on a disposable synthetic company (tests/core/test_agent_channels_browser.py).
// The browser's microphone is Chromium's fake device playing a synthetic WAV made here (tones, no voice); the
// transcriber is the stub (what tools/listen-transcribe.py does with PULSE_LISTEN_STT=stub), so no model and no audio
// leave this machine. Nothing is sent to Telegram or WhatsApp: neither has credentials here, and the screens say so.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
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

let browser, web;
const restore = () => { try { execFileSync('git', ['checkout', '--', 'apps/web/tsconfig.json', 'apps/web/next-env.d.ts'], { cwd: '../..', stdio: 'ignore' }); } catch { /* not a checkout */ } };
try {
  // ---- API: waiting states, admin settings, a listening session end to end ----------------------------------------
  const tg = await call('telegram/link', MEMBER);
  assert.equal(tg.bot, null); assert.equal(tg.waiting, 'token');
  const wa = await call('whatsapp/link', MEMBER);
  assert.equal(wa.on, false); assert.equal(wa.ready, false);
  await call('whatsapp/link', MEMBER, 'POST', { agentId: AGENT }, 409);
  await call('agent-channels', MEMBER, 'PUT', { listenOn: true }, 403);
  await call('listen/sessions', ADMIN, 'POST', { agentId: AGENT, title: 'Synthetic', consent: true }, 409);
  const s = await call('agent-channels', ADMIN, 'PUT', { listenOn: true, listenRetentionDays: 14 });
  assert.deepEqual(s.listen, { on: true, retentionDays: 14 });
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
      await expect(box).toContainText('Waiting for the Vitals OS bot token');
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
      await expect(page.getByRole('heading', { name: 'Listening' }).first()).toBeVisible({ timeout: 120000 });
      const start = page.getByRole('button', { name: 'Start listening' });
      await expect(start).toBeDisabled(); browserChecks++;
      await page.getByLabel('What is it?').selectOption('quotation');
      await page.getByLabel('Name').fill(`Synthetic client call ${width}`);
      await page.getByText('I have told everyone that this conversation is being recorded and transcribed.').click();
      await expect(start).toBeEnabled(); browserChecks++;
      await page.screenshot({ path: join(shots, `listen-ready-${width}-${theme}.png`), fullPage: true });
      await start.click();
      const live = page.getByRole('status').filter({ hasText: 'Listening' });
      await expect(live).toBeVisible({ timeout: 20000 });
      await expect(page.getByText('Recording: everyone in this conversation has been told')).toBeVisible();
      browserChecks += 2;
      // The fake microphone plays the synthetic tones; the first 10-second piece reaches the server.
      const [{ id }] = await inOrg(owner, 'select id from pulse.listen_session where title=$1', [`Synthetic client call ${width}`]);
      for (let i = 0; i < 80; i++) { const [{ n }] = await inOrg(owner, 'select count(*)::int n from pulse_priv.listen_chunk where session_id=$1', [id]); if (n) break; await delay(250); }
      const [{ mime }] = await inOrg(owner, 'select mime from pulse_priv.listen_chunk where session_id=$1 order by seq limit 1', [id]);
      assert.match(mime, /^audio\//); browserChecks++;
      assert.ok(await transcribeStub() >= 1);
      await expect(page.getByTestId('transcript')).toContainText('40 signboards', { timeout: 15000 }); browserChecks++;
      const [{ channel_id: ch }] = await inOrg(owner, 'select channel_id from pulse.listen_session where id=$1', [id]);
      await inOrg(owner, "insert into pulse.chat_message (org_id, channel_id, author_id, body, client_id) values ($1,$2,$3,'Draft quotation (synthetic): 40 signboards, delivery Friday.',gen_random_uuid())", [org, ch, AGENT]);
      await expect(page.getByLabel('What the AI employee did')).toContainText('Draft quotation (synthetic)', { timeout: 15000 }); browserChecks++;
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(wide <= 1, `no sideways scroll at ${width}px (${wide})`); browserChecks++;
      await page.screenshot({ path: join(shots, `listen-live-${width}-${theme}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Stop listening' }).click();
      await expect(live).toHaveCount(0, { timeout: 20000 });
      const [{ stopped }] = await inOrg(owner, 'select stopped_at is not null stopped from pulse.listen_session where id=$1', [id]);
      assert.equal(stopped, true); browserChecks += 2;
      await transcribeStub();
      await page.screenshot({ path: join(shots, `listen-stopped-${width}-${theme}.png`), fullPage: true });
      assert.deepEqual(errors, []); await c.close();
    }
  }
  writeFileSync(process.env.AGENT_CHANNELS_REPORT || join(tmpdir(), 'agent-channels.json'), JSON.stringify({ apiChecks, browserChecks, shots, syntheticOnly: true, sent: 0 }));
  console.log(JSON.stringify({ apiChecks, browserChecks, shots }));
} finally {
  await browser?.close().catch(() => {});
  if (web) { try { process.kill(-web.pid, 'SIGTERM'); } catch { /* gone */ } restore(); }
  await app.close().catch(() => {});
  await Promise.all([pool.end(), owner.end(), worker.end()]).catch(() => {});
}
