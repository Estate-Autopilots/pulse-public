// POLISH-2: walk Pulse as its people on a synthetic agency. The real API (in-process, as the QA-E2E harness runs it)
// on a database a QA-E2E backend run kept (KEEP=1 with PULSE_QA_E2E_SEED_FILE), a private `next dev` (its own dist
// dir) behind a stand-in Access gate (admin@estateautopilots.com, the fixture's install admin, as on pulse-dev), and a
// small control server that shoots any page as any persona (their password session) or any Access address at any size
// and theme, through the style gate (tasks4b-gate.mjs) and the layout audit (layout-audit.mjs). Synthetic people only.
//
//   ea-heavy node tests/e2e/scenarios/walk-serve.mjs <seed file> <control port>
//   curl '127.0.0.1:<port>/shoot?who=kabir&path=/me&name=me&widths=1440,390&themes=light,dark&out=<dir>'
//     who=<persona key> or an Access address (admin@estateautopilots.com: the install's admin, who sets up companies);
//     host=<name>.localhost for another company's own address; also click=<exact text>, probe=<js>, full=1, wait=<ms>
//   curl '127.0.0.1:<port>/tick'   the worker's minute tick;  /who  personas;  /stop
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { Persona, Recorder, startStack, tick } from './lib/harness.mjs';
import { STYLE_AUDIT } from '../tasks4b-gate.mjs';
import { auditLayout, BLOCKING, settle } from '../layout-audit.mjs';

const [seedFile, controlPort] = process.argv.slice(2);
const kept = JSON.parse(readFileSync(seedFile, 'utf8'));
const seed = kept.seed;
const rec = new Recorder(`${process.env.TMPDIR ?? '/tmp'}/walk-serve`, 'POLISH-2 walk');
const stack = await startStack({ apiConfig: JSON.parse(kept.api), workerConfig: JSON.parse(kept.worker), ownerConfig: JSON.parse(kept.owner) });
const free = () => new Promise((done) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const port = await free(), base = `http://127.0.0.1:${port}`;
const webDir = new URL('../../../apps/web/', import.meta.url).pathname, repo = new URL('../../../', import.meta.url).pathname;
const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--disable-source-maps', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-polish2', PULSE_API_URL: stack.base, PULSE_PUBLIC_LOGIN_ENABLED: '', PULSE_PUBLIC_URL: base },
});
let webLog = ''; web.stdout.on('data', (d) => { webLog = (webLog + d).slice(-4000); }); web.stderr.on('data', (d) => { webLog = (webLog + d).slice(-4000); });
// `next dev` with another dist dir writes it into tsconfig.json; put it back when done.
const restore = () => { try { execFileSync('git', ['checkout', '--', 'apps/web/tsconfig.json'], { cwd: repo, stdio: 'ignore' }); } catch { /* not a checkout */ } };
const stop = async () => { try { process.kill(-web.pid, 'SIGTERM'); } catch { /* gone */ } restore(); await stack.close().catch(() => {}); };
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));

const names = { kabir: 'Kabir Shah', ahoro: 'Ahoro Rao', meera: 'Meera Iyer', neha: 'Neha Jivop', rila: 'Rila Kapoor', dev: 'Dev Panab', sana: 'Sana Khan', ishaan: 'Ishaan Vivim', tara: 'Tara Nair', vikram: 'Vikram Seduh', zoya: 'Zoya Sheikh', rifob: 'Rifob Desai' };
const h = { rec, stack, password: seed.password };
const P = Object.fromEntries(Object.entries(seed.personas).map(([k, v]) => [k, new Persona(h, k, { ...v, name: names[k] })]));
/** A session for a persona: the backend run changed each issued password to Synthetic-<key>-2026!. */
async function session(key) {
  const p = P[key]; if (!p) throw Error(`unknown persona ${key}`);
  if (p.token) return p.token;
  for (const password of [`Synthetic-${key}-2026!`, `Synthetic-${key}-web-2026!`, seed.password]) {
    p.password = password; const r = await p.post('/api/v0/auth/sign-in', { username: p.username, password });
    if (r.status === 200 && r.data?.token) { p.token = r.data.token; if (r.data.mustChange) { const next = `Synthetic-${key}-2026!`; await p.post('/api/v0/auth/change-password', { current: password, next }); p.password = next; } return p.token; }
  }
  throw Error(`${key} cannot sign in`);
}

const { chromium } = await import(new URL('../node_modules/@playwright/test/index.mjs', import.meta.url).href);
const browser = await chromium.launch();
for (let i = 0; i < 240; i++) { try { const r = await fetch(`${base}/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 1000)); }
console.log(`walk: web ${base}  api ${stack.base}  control 127.0.0.1:${controlPort}`);

async function shoot(q) {
  const who = q.get('who') ?? 'kabir', path = q.get('path') ?? '/', name = q.get('name') ?? (path.replace(/\W+/g, '_') || 'home');
  const out = q.get('out') ?? '/tmp/walk'; mkdirSync(out, { recursive: true });
  const lines = []; const access = who.includes('@'); const token = access ? null : await session(who);
  const origin = q.get('host') ? `http://${q.get('host')}:${port}` : base;
  for (const width of (q.get('widths') ?? '1440,390').split(',').map(Number)) for (const theme of (q.get('themes') ?? 'light,dark').split(',')) {
    const phone = width < 600, height = phone ? 844 : width < 1100 ? 1024 : 900;
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, ...(phone ? { isMobile: true, hasTouch: true } : {}),
      extraHTTPHeaders: { 'Cf-Access-Authenticated-User-Email': access ? who : 'admin@estateautopilots.com' } });
    if (token) await ctx.addCookies([{ name: 'pulse_session', value: token, url: origin }]);
    await ctx.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); localStorage.setItem('pulse.notify.asked', '1'); } catch { /* private */ } }, theme);
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(m.text().slice(0, 200)); });
    try {
      await page.goto(origin + path, { waitUntil: 'load', timeout: 240000 });
      await page.waitForFunction(() => { const m = document.querySelector('main'); return m && m.innerText.trim().length > 10 && !m.querySelector('[aria-busy="true"]'); }, {}, { timeout: 120000 }).catch(() => errors.push('main did not settle'));
      await settle(page, Number(q.get('wait') ?? 900));
      for (const text of q.getAll('click')) { await page.getByText(text, { exact: true }).first().click(); await page.waitForTimeout(700); }
      const gate = await page.evaluate(STYLE_AUDIT, { theme, width });
      const { findings } = await page.evaluate(auditLayout, {});
      const bad = findings.filter((f) => BLOCKING.includes(f.rule));
      if (q.get('probe')) lines.push(`probe ${name} ${width} ${theme}: ${JSON.stringify(await page.evaluate(q.get('probe'))).slice(0, 3000)}`);
      if (q.get('full') && phone) {
        const full = await page.evaluate(() => { let hh = document.documentElement.scrollHeight; for (const el of document.querySelectorAll('body *')) { const c = getComputedStyle(el); if (/(auto|scroll)/.test(c.overflowY) && el.scrollHeight > el.clientHeight + 4) hh = Math.max(hh, el.scrollHeight + el.getBoundingClientRect().top); } return Math.ceil(hh); });
        if (full > height) { await page.setViewportSize({ width, height: Math.min(full, 9000) }); await page.waitForTimeout(500); }
      }
      const file = `${out}/${name}-${width}-${theme}.png`; await page.screenshot({ path: file });
      lines.push(`${gate.problems.length || bad.length || errors.length ? '✗' : '✓'} ${name} ${width} ${theme}${gate.problems.length ? ` GATE ${gate.problems.join(' | ')}` : ''}${bad.length ? ` LAYOUT ${bad.slice(0, 6).map((f) => `${f.rule}: ${f.where} — ${f.detail}`).join(' | ')}` : ''}${errors.length ? ` ERRORS ${errors.slice(0, 3).join(' | ')}` : ''}`);
    } catch (e) { lines.push(`! ${name} ${width} ${theme} FAILED ${String(e).slice(0, 300)}`); }
    console.log(lines.at(-1));
    await ctx.close();
  }
  writeFileSync(`${out}/${name}.txt`, lines.join('\n') + '\n');
  return lines;
}

createServer(async (req, res) => {
  const q = new URL(req.url ?? '/', 'http://x').searchParams, at = new URL(req.url ?? '/', 'http://x').pathname;
  try {
    if (at === '/stop') { res.end('stopping\n'); await browser.close(); await stop(); process.exit(0); }
    if (at === '/tick') { const t = await tick(stack, rec); return res.end(JSON.stringify(t) + '\n'); }
    if (at === '/who') return res.end(JSON.stringify(Object.fromEntries(Object.entries(P).map(([k, p]) => [k, { id: p.id, username: p.username, roles: p.roles }])), null, 1) + '\n');
    if (at === '/log') return res.end(webLog + '\n');
    if (at === '/shoot') return res.end((await shoot(q)).join('\n') + '\n');
    res.statusCode = 404; res.end('unknown\n');
  } catch (e) { res.statusCode = 500; res.end(String(e?.stack ?? e).slice(0, 2000) + '\n'); }
}).listen(Number(controlPort), '127.0.0.1');
