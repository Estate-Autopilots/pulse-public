// PHONE-QA: Pulse for real phones on a synthetic agency. The real API in-process (as the QA-E2E harness runs it) on a
// database a QA-E2E backend run kept (KEEP=1 with PULSE_QA_E2E_SEED_FILE), and a private `next dev` in public sign-in
// mode on http://localhost:<web port>, which a laptop forwards to each phone (ssh -L, then adb reverse). Mail and pushes
// are sinks (PULSE_AUTH_MAIL_MODE=sink, PULSE_NOTIFICATION_MODE=sink): nothing leaves the machine, and the control port
// shows the sign-in and sign-up codes the sink caught, so e-mail-code journeys work with invented addresses.
// Synthetic people only; never a production or staging database.
//
//   ea-heavy node tools/qa/phone-qa/phone-qa-serve.mjs <seed file> <web port> <control port>
//   curl 127.0.0.1:<control>/who          personas (username, e-mail; passwords as the backend run left them)
//   curl '127.0.0.1:<control>/mail?to=x'  the sink's mails to x (newest last); /mail for all
//   curl 127.0.0.1:<control>/tick         the worker's minute tick and push drains;  /pushes  sink pushes;  /stop
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dist, Recorder, startStack, tick } from '../../../tests/e2e/scenarios/lib/harness.mjs';

const [seedFile, webPort, controlPort] = process.argv.slice(2);
if (!seedFile || !webPort || !controlPort) { console.error('usage: phone-qa-serve.mjs <seed file> <web port> <control port>'); process.exit(2); }
const origin = `http://localhost:${webPort}`;
Object.assign(process.env, { PULSE_CI: '1', PULSE_NOTIFICATION_MODE: 'sink', PULSE_AUTH_MAIL_MODE: 'sink', PULSE_PUBLIC_LOGIN_ENABLED: '1', PULSE_PUBLIC_URL: origin });
const kept = JSON.parse(readFileSync(seedFile, 'utf8'));
const rec = new Recorder(`${process.env.TMPDIR ?? '/tmp'}/phone-qa-serve`, 'PHONE-QA serve');
const stack = await startStack({ apiConfig: JSON.parse(kept.api), workerConfig: JSON.parse(kept.worker), ownerConfig: JSON.parse(kept.owner) });
const { testMail } = await dist('auth-mail.js');
const webDir = new URL('../../../apps/web/', import.meta.url).pathname, repo = new URL('../../../', import.meta.url).pathname;
const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--disable-source-maps', '--hostname', '127.0.0.1', '--port', String(webPort)], {
  cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-phoneqa', PULSE_API_URL: stack.base },
});
let webLog = ''; web.stdout.on('data', (d) => { webLog = (webLog + d).slice(-8000); }); web.stderr.on('data', (d) => { webLog = (webLog + d).slice(-8000); });
// `next dev` with another dist dir writes it into tsconfig.json; put it back when done.
const restore = () => { try { execFileSync('git', ['checkout', '--', 'apps/web/tsconfig.json', 'apps/web/next-env.d.ts'], { cwd: repo, stdio: 'ignore' }); } catch { /* not a checkout */ } };
const stop = async () => { try { process.kill(-web.pid, 'SIGTERM'); } catch { /* gone */ } restore(); await stack.close().catch(() => {}); };
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://control'), q = url.searchParams;
  try {
    if (url.pathname === '/who') return json(res, 200, { origin, api: stack.base, password: kept.seed.password, personas: kept.seed.personas });
    if (url.pathname === '/mail') return json(res, 200, testMail.filter((m) => !q.get('to') || m.to.toLowerCase() === q.get('to').toLowerCase()).slice(-Number(q.get('n') ?? 5)));
    if (url.pathname === '/tick') { await tick(stack, rec); return json(res, 200, { ok: true }); }
    if (url.pathname === '/log') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(webLog); }
    if (url.pathname === '/stop') { json(res, 200, { stopping: true }); await stop(); process.exit(0); }
    json(res, 404, { error: 'unknown' });
  } catch (e) { json(res, 500, { error: String(e?.stack ?? e).slice(0, 2000) }); }
}).listen(Number(controlPort), '127.0.0.1');
console.log(`phone-qa: web ${origin} (127.0.0.1:${webPort})  api ${stack.base}  control 127.0.0.1:${controlPort}`);
