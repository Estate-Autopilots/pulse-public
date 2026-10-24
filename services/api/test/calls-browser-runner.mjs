// CHAT-VOICE journey J8 in the browser: the real API (in this process) and the web app on the synthetic agency of
// tests/core/test_chats_browser.py, two people in two Chromium contexts with fake microphones and cameras (Chromium's
// own test devices: a beeping tone and a test pattern). Nothing leaves this machine.
//   1. Kabir (desktop) holds the mic in Pod 1 and records a voice note; Ahoro (phone size) plays it at 1.5×; Kabir sees
//      it played.
//   2. Kabir calls Ahoro from their chat; Ahoro's Pulse rings; he answers; audio flows both ways (inbound RTP bytes);
//      Ahoro mutes and Kabir sees it; Kabir minimises to the pill and back, then hangs up; the call is a line in the
//      chat with its length.
//   3. Kabir calls again; nobody answers; after the ring times out it is a missed call for Ahoro ("needs you"), and
//      "no answer" for Kabir.
// Screenshots (and a video per person) with PULSE_CALLS_SHOTS=<dir>. CALLS_NEXT_DEV=1 runs a private `next dev`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const worker = new Pool(JSON.parse(process.env.TEST_WORKER_CONFIG));
const app = createApp(pool, pool); const E = JSON.parse(process.env.TEST_IDS); const org = process.env.PULSE_ORG_ID;
const emails = { kabir: process.env.TEST_MEMBER, ahoro: process.env.TEST_HEAD };
const shots = process.env.PULSE_CALLS_SHOTS; if (shots) await mkdir(`${shots}/video`, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`; const dev = process.env.CALLS_NEXT_DEV === '1';
// The web server's own output goes beside the screenshots (or nowhere), so a server that never answers says why.
const { openSync } = await import('node:fs'); const out = shots ? openSync(`${shots}/next.log`, 'w') : 'ignore';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: dev ? 'development' : 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? (dev ? '.next-calls' : '.next') }, stdio: ['ignore', out, out] });
let exited = null; server.on('exit', (code) => { exited = code; });
process.on('exit', () => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } });
const T = dev ? 180000 : 45000;
let checks = 0; const errors = []; const steps = [];
const ok = (c, m) => { checks++; assert.ok(c, m); };
const seen = async (locator, timeout = T) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const sql = async (q, params = []) => { const c = await worker.connect(); try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [org]); const r = await c.query(q, params); await c.query('commit'); return r.rows; } finally { c.release(); } };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load', timeout: T }); await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: T }); await page.waitForTimeout(300); };
const inbound = (page) => page.evaluate(async () => {
  const s = window.__pulseCalls?.session; if (!s) return -1; let bytes = 0;
  for (const p of s.peers.values()) (await p.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived ?? 0; });
  return bytes;
});
const connected = (page) => page.evaluate(() => [...(window.__pulseCalls?.session?.peers.values() ?? [])].some((p) => p.pc.connectionState === 'connected'));

let up = false;
for (let i = 0; i < 600 && exited === null; i++) { try { if ((await fetch(base + '/login')).status < 500) { up = true; break; } } catch { /* starting */ } await delay(1000); }
assert.ok(up, `the web server did not start (exit ${exited})`);
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
async function person(who, phone) {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone,
    permissions: ['microphone', 'camera'], extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[who] },
    ...(shots ? { recordVideo: { dir: `${shots}/video`, size: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 } } } : {}) });
  const page = await ctx.newPage(); page.setDefaultTimeout(T);
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message.slice(0, 200)}`));
  return { ctx, page };
}
const step = async (name, run) => { const at = Date.now(); try { await run(); } catch (e) { console.error(`STEP FAILED: ${name}
${e?.stack ?? e}`); if (shots) for (const [who, p] of [['kabir', kabir?.page], ['ahoro', ahoro?.page]]) await p?.screenshot({ path: `${shots}/failed-${who}.png` }).catch(() => {}); throw e; } steps.push({ name, seconds: Math.round((Date.now() - at) / 100) / 10 }); };

let kabir, ahoro;
try {
  kabir = await person('kabir', false); ahoro = await person('ahoro', true);
  const K = kabir.page, A = ahoro.page;

  await step('voice note: hold to record, play at 1.5x, played state', async () => {
    await go(K, `/chats?channel=${E.pod1}`);
    const mic = K.locator('[data-voice-mic]'); await seen(mic);
    const box = await mic.boundingBox();
    await K.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await K.mouse.down();
    await seen(K.getByRole('status', { name: /^Recording/ })); await K.waitForTimeout(2600); await shot(K, 'j8-01-recording');
    await K.mouse.up();
    const mine = K.locator('[data-voice-note][data-mine]').last(); await seen(mine);
    await expect(mine.locator('time')).toHaveText(/^0:0[2-4]$/, { timeout: T }); checks++;
    await shot(K, 'j8-02-voice-sent');
    await go(A, `/chats?channel=${E.pod1}`);
    const note = A.locator('[data-voice-note][data-unplayed]').last(); await seen(note);
    await note.locator('[data-voice-play]').click();
    const rate = A.getByRole('button', { name: /Playback speed 1×/ }); await seen(rate); await rate.click();
    await seen(A.getByRole('button', { name: /Playback speed 1\.5×/ })); await shot(A, 'j8-03-playing-1.5x');
    await expect(A.locator('[data-voice-note]').last()).not.toHaveAttribute('data-unplayed', '', { timeout: T }); checks++;
    await expect(K.locator('[data-voice-note][data-mine]').last().locator('i[data-played]')).toBeVisible({ timeout: T }); checks++;
    const kinds = await sql("select event_type,priority,quiet from pulse.notification where person_id=$1 and event_type='chat.voice'", [E.people.ahoro]);
    ok(kinds.length >= 1 && kinds.every((n) => n.priority === 'needs_you' && !n.quiet), 'a voice note in a group needs you');
  });

  await step('call: ring, answer, audio both ways, mute, minimise, hang up, line in chat', async () => {
    await go(A, '/chats');
    await go(K, `/chats?channel=${E.ahoroDm}`);
    await K.locator('[data-chat-call="voice"]').first().click();
    await seen(K.getByRole('dialog', { name: /^Call with/ })); await seen(K.getByText('Ringing…'));
    const ring = A.getByRole('alertdialog', { name: /is calling/ }); await seen(ring, 20000); await shot(A, 'j8-04-incoming-phone'); await shot(K, 'j8-05-ringing-desktop');
    const urgent = await sql("select priority,quiet from pulse.notification where person_id=$1 and event_type='chat.call' order by created_at desc limit 1", [E.people.ahoro]);
    ok(urgent[0]?.priority === 'urgent' && !urgent[0].quiet, 'an incoming call is urgent and pings');
    await ring.getByRole('button', { name: 'Answer' }).click();
    await expect.poll(() => connected(K), { timeout: 30000 }).toBe(true); checks++;
    await expect.poll(() => connected(A), { timeout: 30000 }).toBe(true); checks++;
    await K.waitForTimeout(2500);
    ok((await inbound(K)) > 2000 && (await inbound(A)) > 2000, 'audio flows both ways');
    await seen(K.getByRole('dialog', { name: /^Call with/ }).getByText(/^0:0\d$/)); await shot(K, 'j8-06-in-call-desktop'); await shot(A, 'j8-07-in-call-phone');
    await A.getByRole('button', { name: 'Mute', exact: true }).click();
    await seen(K.getByRole('dialog', { name: /^Call with/ }).getByLabel('Muted'), 15000);
    await K.getByRole('button', { name: 'Minimise the call' }).click();
    await seen(K.getByRole('region', { name: 'Call in progress' })); await shot(K, 'j8-08-pill');
    await K.getByRole('button', { name: 'Open the call' }).click();
    await K.getByRole('button', { name: 'Hang up' }).first().click();
    await expect(A.getByRole('dialog', { name: /^Call with/ })).toHaveCount(0, { timeout: 15000 }); checks++;
    await seen(K.locator('[role="log"]').getByText('Voice call', { exact: true }));
    await seen(K.locator('[role="log"]').getByRole('button', { name: /Call back/ })); await shot(K, 'j8-09-call-in-chat');
  });

  await step('missed call: no answer, a missed call that needs you', async () => {
    await A.close();
    await K.locator('[data-chat-call="voice"]').first().click();
    await seen(K.getByText('Ringing…'));
    // The 45-second ring, shortened: the ring started 50 s ago.
    await sql("update pulse.chat_call_party set invited_at=invited_at-interval '50 seconds' where state='ringing'");
    await expect(K.getByRole('dialog', { name: /^Call with/ })).toHaveCount(0, { timeout: 20000 }); checks++;
    await seen(K.locator('[role="log"]').getByText(/no answer/));
    const missed = await sql("select priority,quiet,title from pulse.notification where person_id=$1 and event_type='chat.missed_call'", [E.people.ahoro]);
    ok(missed.length === 1 && missed[0].priority === 'needs_you' && !missed[0].quiet, 'a missed call needs you');
    const back = await ahoro.ctx.newPage(); await go(back, '/chats');
    await seen(back.getByText(/Missed voice call/)); await shot(back, 'j8-10-missed-in-list');
    await back.close();
  });
  ok(!errors.length, `no page errors: ${errors.join(' | ')}`);
} finally {
  await kabir?.ctx.close().catch(() => {}); await ahoro?.ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  const soon = (p) => Promise.race([p.catch(() => {}), delay(8000)]);
  await soon(app.close()); await soon(pool.end()); await soon(worker.end());
}
if (process.env.PULSE_CALLS_REPORT) await writeFile(process.env.PULSE_CALLS_REPORT, JSON.stringify({ checks, steps }));
console.log(JSON.stringify({ checks, steps }));
process.exit(0);
