// QA-E2E harness: the real Pulse API on a local port, synthetic personas that sign in and act through it, a phone or
// laptop paired the way the apps pair, the worker's minute tick, and a recorder that keeps every request with its
// response time. Used by driver.mjs (backend scenarios) and browser.mjs (journeys). Synthetic tenants only.
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../../../../services/api/package.json', import.meta.url));
export const { Pool } = require('pg');
export const dist = (module) => import(new URL(`../../../../services/api/dist/${module}`, import.meta.url).href);
export { delay, randomUUID };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** "/api/v0/chats/4f…/messages?flat=1" → "/api/v0/chats/:id/messages": requests group by route in the report. */
export const route = (path) => path.split('?')[0].replace(UUID, ':id').replace(/\/[A-Z0-9]{4}-[A-Z0-9]{4}$/, '/:code');

/** Everything a run observes: requests, checks (hard), observations (how Pulse behaves, issues), timings. */
export class Recorder {
  constructor(out, title) {
    this.out = out; this.title = title; mkdirSync(out, { recursive: true });
    this.requests = []; this.checks = []; this.notes = []; this.timings = []; this.scenario = 'setup'; this.started = Date.now();
    writeFileSync(`${out}/requests.jsonl`, '');
  }
  section(name) { this.scenario = name; console.log(`\n== ${name}`); }
  request(r) {
    const row = { at: new Date().toISOString(), scenario: this.scenario, ...r };
    this.requests.push(row); appendFileSync(`${this.out}/requests.jsonl`, JSON.stringify(row) + '\n');
  }
  /** A hard expectation: the run fails if it does not hold (kept going, so one run shows every failure). */
  check(ok, name, detail) {
    this.checks.push({ scenario: this.scenario, name, ok: !!ok, detail: detail === undefined ? undefined : summary(detail) });
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(summary(detail)).slice(0, 400)}` : ''}`);
    return !!ok;
  }
  /** How Pulse behaves (kind 'how'), or an issue found (kind 'P0'|'P1'|'P2') with what happened. Never fails the run. */
  note(kind, name, detail) {
    this.notes.push({ scenario: this.scenario, kind, name, detail: detail === undefined ? undefined : summary(detail) });
    console.log(`  ${kind.padEnd(4)} ${name}`);
  }
  timing(name, ms, detail) { this.timings.push({ scenario: this.scenario, name, ms: Math.round(ms), detail }); console.log(`  time ${name}: ${Math.round(ms)} ms`); }
  finish(extra = {}) {
    const failed = this.checks.filter((c) => !c.ok);
    const byRoute = {};
    for (const r of this.requests) {
      const k = `${r.method} ${r.route}`; const s = byRoute[k] ??= { count: 0, ms: [], statuses: {} };
      s.count++; s.ms.push(r.ms); s.statuses[r.status] = (s.statuses[r.status] ?? 0) + 1;
    }
    const routes = Object.entries(byRoute).map(([k, s]) => { const ms = s.ms.sort((a, b) => a - b); return { route: k, count: s.count, p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))], max: ms.at(-1), statuses: s.statuses }; })
      .sort((a, b) => b.p95 - a.p95);
    const report = { title: this.title, startedAt: new Date(this.started).toISOString(), seconds: Math.round((Date.now() - this.started) / 1000), requests: this.requests.length,
      checks: this.checks.length, failed: failed.length, failures: failed, notes: this.notes, timings: this.timings, routes, ...extra };
    writeFileSync(`${this.out}/report.json`, JSON.stringify(report, null, 1));
    writeFileSync(`${this.out}/report.md`, markdown(report));
    console.log(`\n${report.checks - report.failed}/${report.checks} checks passed, ${report.requests} requests, ${report.notes.filter((n) => n.kind !== 'how').length} issues noted`);
    return report;
  }
}

function summary(x) {
  if (x === null || typeof x !== 'object') return x;
  const s = JSON.stringify(x); return s.length > 1500 ? JSON.parse(JSON.stringify(x, (k, v) => typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v)) : x;
}

function markdown(r) {
  const lines = [`# ${r.title}`, '', `${r.startedAt} · ${r.seconds} s · ${r.requests} requests · ${r.checks - r.failed}/${r.checks} checks passed`, ''];
  if (r.failures.length) { lines.push('## Failed checks', ''); for (const f of r.failures) lines.push(`- **${f.scenario}** ${f.name}${f.detail !== undefined ? ` — \`${JSON.stringify(f.detail).slice(0, 300)}\`` : ''}`); lines.push(''); }
  for (const kind of ['P0', 'P1', 'P2']) {
    const list = r.notes.filter((n) => n.kind === kind); if (!list.length) continue;
    lines.push(`## ${kind} issues`, ''); for (const n of list) lines.push(`- **${n.scenario}** ${n.name}${n.detail !== undefined ? ` — \`${JSON.stringify(n.detail).slice(0, 400)}\`` : ''}`); lines.push('');
  }
  lines.push('## How it behaves', ''); for (const n of r.notes.filter((x) => x.kind === 'how')) lines.push(`- **${n.scenario}** ${n.name}${n.detail !== undefined ? ` — \`${JSON.stringify(n.detail).slice(0, 300)}\`` : ''}`);
  lines.push('', '## Timings', '', '| scenario | what | ms |', '|---|---|---:|'); for (const t of r.timings) lines.push(`| ${t.scenario} | ${t.name} | ${t.ms} |`);
  lines.push('', '## Requests by route (slowest p95 first)', '', '| route | n | p50 | p95 | max | statuses |', '|---|---:|---:|---:|---:|---|');
  for (const x of r.routes) lines.push(`| \`${x.route}\` | ${x.count} | ${x.p50} | ${x.p95} | ${x.max} | ${Object.entries(x.statuses).map(([k, v]) => `${k}×${v}`).join(' ')} |`);
  return lines.join('\n') + '\n';
}

/** The real API (createApp, as server.js builds it) listening on a local port, plus a worker pool for the minute tick. */
export async function startStack({ apiConfig = JSON.parse(process.env.TEST_API_CONFIG), workerConfig = JSON.parse(process.env.TEST_WORKER_CONFIG), ownerConfig = JSON.parse(process.env.TEST_OWNER_CONFIG ?? 'null'), observe = null } = {}) {
  await webPushKeys();
  const { createApp } = await dist('app.js');
  const pool = new Pool({ ...apiConfig, max: 12 }), worker = new Pool({ ...workerConfig, max: 3 }), owner = ownerConfig ? new Pool({ ...ownerConfig, max: 2 }) : null;
  const app = createApp(pool, pool);
  // Every request the API serves (browsers included, through the web proxy), with its server time.
  if (observe) app.addHook('onResponse', async (req, reply) => observe({ method: req.method, path: req.url, route: route(req.url), status: reply.statusCode, ms: Math.round(reply.elapsedTime),
    session: typeof req.headers['x-pulse-session'] === 'string' ? req.headers['x-pulse-session'] : null, device: typeof req.headers.authorization === 'string' }));
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const org = (await pool.query('select pulse.install_org() org')).rows[0].org;
  return { app, pool, worker, owner, base, org, close: async () => { await app.close(); await pool.end(); await worker.end(); await owner?.end(); } };
}

/** A throwaway VAPID pair for this process, as root provides in production (PULSE_WEB_PUSH_*): browser pings can be
 *  enrolled; deliveries stay in sink mode (PULSE_NOTIFICATION_MODE=sink), so nothing is sent to a push service. */
async function webPushKeys() {
  if (process.env.PULSE_WEB_PUSH_PUBLIC_KEY || process.env.QA_NO_WEB_PUSH === '1') return;
  const { generateVAPIDKeys } = require('web-push');
  const { mkdtempSync, writeFileSync: write } = await import('node:fs'); const { tmpdir } = await import('node:os');
  const keys = generateVAPIDKeys(), dir = mkdtempSync(`${tmpdir()}/qa-vapid-`);
  write(`${dir}/private`, keys.privateKey, { mode: 0o600 });
  process.env.PULSE_WEB_PUSH_PUBLIC_KEY = keys.publicKey; process.env.PULSE_WEB_PUSH_PRIVATE_KEY_FILE = `${dir}/private`;
}

/** A transaction as the worker role in the tenant: fixtures (moving stored times) and the minute tick. */
export async function asWorker(stack, run) {
  const c = await stack.worker.connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [stack.org]); const r = await run(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}

/** A transaction as the owner (migration) role: fixtures the worker may not touch (moving presence timestamps). */
export async function asOwner(stack, run) {
  if (!stack.owner) throw Error('TEST_OWNER_CONFIG is not set');
  const c = await stack.owner.connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [stack.org]); const r = await run(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}

/** The notifications worker's minute tick (services/workers/…/notifications.py main), then the web and phone push drains
 *  in sink mode (PULSE_NOTIFICATION_MODE=sink: accepted, nothing leaves the machine). Telegram and e-mail are counted. */
export async function tick(stack, rec, label = 'worker tick') {
  const started = performance.now();
  await asWorker(stack, async (c) => {
    for (const [signature, call] of [['companion_presence_tick(uuid)', 'companion_presence_tick(null)'], ['attendance_forgotten_tick(timestamptz)', 'attendance_forgotten_tick()'], ['hr_flow_remind()', 'hr_flow_remind()'],
      ['notification_reminder_tick(timestamptz)', 'notification_reminder_tick()'], ['onboarding_tick(timestamptz)', 'onboarding_tick()'], ['task_due_tick()', 'task_due_tick()']]) {
      if ((await c.query(`select to_regprocedure('pulse.${signature}') is not null ok`)).rows[0].ok) await c.query(`select pulse.${call}`);
    }
  });
  const { drainWebPush } = await dist('web-push.js'); const { drainNativePush } = await dist('native-push.js');
  const web = await drainWebPush(stack.worker); process.env.PULSE_NATIVE_PUSH_ENABLED = '1'; const native = await drainNativePush(stack.worker);
  rec?.request({ persona: 'worker', method: 'TICK', route: label, path: label, status: 0, ms: Math.round(performance.now() - started), web, native });
  return { web, native };
}

/** One synthetic person: a password sign-in like the public login page, then calls with the session token. */
export class Persona {
  constructor(h, key, info) { Object.assign(this, { h, key, id: info.id, username: info.username, roles: info.roles ?? [], password: h.password, token: null, device: null }); this.name = info.name ?? key; }
  async call(method, path, body, { device = false, expect, quiet, headers = {} } = {}) {
    const auth = device ? { authorization: `Bearer ${this.device.accessToken}` } : this.token ? { 'x-pulse-session': this.token } : {};
    const started = performance.now();
    const res = await fetch(this.h.stack.base + path, { method, headers: { ...auth, 'x-pulse-client-ip': this.ip ?? 'unattributed-web', 'user-agent': device ? `PulseShell/1.1.2 (${this.device.platform})` : 'Mozilla/5.0 QA-E2E', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ms = performance.now() - started; const text = await res.text(); let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* binary or text */ }
    this.h.rec.request({ persona: this.key + (device ? ':' + this.device.platform : ''), method, route: route(path), path, status: res.status, ms: Math.round(ms), bytes: text.length, ...(res.status >= 400 ? { error: typeof data === 'object' ? data?.error ?? data?.message : String(data).slice(0, 200) } : {}) });
    if (expect !== undefined && !quiet) this.h.rec.check(Array.isArray(expect) ? expect.includes(res.status) : res.status === expect, `${this.key} ${method} ${route(path)} → ${expect}`, { status: res.status, data: typeof data === 'object' ? data : String(data).slice(0, 300) });
    return { status: res.status, data, ms, headers: res.headers };
  }
  get(path, o) { return this.call('GET', path, undefined, o); }
  post(path, body = {}, o) { return this.call('POST', path, body, o); }
  dget(path, o) { return this.call('GET', path, undefined, { ...o, device: true }); }
  dpost(path, body = {}, o) { return this.call('POST', path, body, { ...o, device: true }); }

  /** The public sign-in; a first sign-in with an HR-issued password must choose its own before anything else opens. */
  async signIn() {
    const r = await this.post('/api/v0/auth/sign-in', { username: this.username, password: this.password });
    if (r.status !== 200 || !r.data?.token) { this.h.rec.check(false, `${this.key} signs in`, r); return r; }
    this.token = r.data.token;
    if (r.data.mustChange) {
      const blocked = await this.get('/api/v0/chats');
      this.h.rec.check(blocked.status === 403, `${this.key}: an issued password opens nothing until it is changed`, blocked.status);
      const next = `Synthetic-${this.key}-2026!`;
      const c = await this.post('/api/v0/auth/change-password', { current: this.password, next });
      this.h.rec.check(c.status === 200, `${this.key} chooses a password`, c); this.password = next;
    }
    return r;
  }

  /** The phone (android/ios) pairs as the Capacitor shell does after a web sign-in; a laptop (windows/macos) as the
   *  desktop app does, by a code approved on the Pulse site. Returns the device tokens. */
  async pair(platform = 'android', name = `QA ${platform}`) {
    const start = await this.post('/api/v0/native/pair/start', { platform, name });
    if (!this.h.rec.check(start.status === 200 && start.data.code, `${this.key} ${platform}: a pairing code`, start)) return null;
    const approve = ['android', 'ios'].includes(platform)
      ? await this.post('/api/v0/native/shell/enroll', { code: start.data.code, expectedPersonId: this.id })
      : await this.post('/api/v0/native/pair/decide', { code: start.data.code, approve: true });
    this.h.rec.check(approve.status === 200, `${this.key} ${platform}: approved from the signed-in Pulse`, approve);
    const poll = await this.post('/api/v0/native/pair/poll', { pairId: start.data.pairId, pollSecret: start.data.pollSecret });
    if (!this.h.rec.check(poll.status === 200 && poll.data.status === 'approved', `${this.key} ${platform}: the app collects its tokens`, poll)) return null;
    this.device = { platform, ...poll.data };
    return this.device;
  }

  /** Live updates the way the chats page listens (Server-Sent Events). Resolves waiters when a channel changes. */
  listen() {
    const ctrl = new AbortController(); const waiters = []; const seen = [];
    const run = async () => {
      while (!ctrl.signal.aborted) {
        try {
          const res = await fetch(this.h.stack.base + '/api/v0/chats/events', { headers: { 'x-pulse-session': this.token }, signal: ctrl.signal });
          const reader = res.body.getReader(); let buf = '';
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            buf += Buffer.from(value).toString();
            let i; while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              const data = block.split('\n').find((l) => l.startsWith('data: '));
              if (!data) continue; const ev = JSON.parse(data.slice(6)); const at = performance.now(); seen.push({ at, ev });
              for (const w of [...waiters]) if (ev.all || ev.channels?.includes(w.channel)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(at); }
            }
          }
        } catch { if (ctrl.signal.aborted) return; await delay(500); }
      }
    };
    void run();
    return { seen, close: () => ctrl.abort(), wait: (channel, ms = 15000) => new Promise((resolve) => { const w = { channel, resolve }; waiters.push(w); setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); resolve(null); } }, ms); }) };
  }
}

/** IST helpers: Pulse's working day, clock and dates follow Asia/Kolkata. */
export const IST = (d = new Date()) => new Date(d.getTime() + 330 * 60000);
export const istDate = (d = new Date()) => IST(d).toISOString().slice(0, 10);
export const istClock = (d = new Date()) => IST(d).toISOString().slice(11, 16);
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
