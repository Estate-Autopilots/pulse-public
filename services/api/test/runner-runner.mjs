// SERVERS-AI on a disposable database (tests/core/test_runners.py): Pulse Runner's protocol end to end, as a paired
// server sees it (docs/runner/PROTOCOL.md v1), and Settings → Servers & AI as an admin (and nobody else) sees it.
import assert from 'node:assert/strict'; import { Pool } from 'pg'; import { writeFile } from 'node:fs/promises'; import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), owner = new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG)), app = createApp(pool, pool);
const ORG = process.env.PULSE_ORG_ID;
let checks = 0; const receipts = [];
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; receipts.push(label); };
const ok = (v, label) => { assert.ok(v, label); checks++; receipts.push(label); };
const sha = (x) => createHash('sha256').update(x).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, { role, cred, body, raw, headers = {} } = {}) {
  const h = { 'x-pulse-client-ip': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers };
  if (role) h['cf-access-authenticated-user-email'] = `${role}@runners.example`;
  if (cred) h.authorization = `Bearer ${cred}`;
  if (raw) h['content-type'] = 'application/octet-stream';
  const r = await app.inject({ method, url, headers: h, ...(raw ? { payload: raw } : body !== undefined ? { payload: body } : {}) });
  let data = null; try { data = JSON.parse(r.body); } catch { data = r.body; }
  // Every refusal of a runner endpoint is { error: { code, message } }.
  if (url.startsWith('/runner/') && r.statusCode >= 400) assert.ok(data?.error?.code && typeof data.error.message === 'string', `${url}: error shape ${r.body}`);
  return { status: r.statusCode, data };
}
const adminGet = (path, role = 'admin') => call('GET', `/api/v0/admin/${path}`, { role });
const adminPost = (path, body = {}, role = 'admin') => call('POST', `/api/v0/admin/${path}`, { role, body });
const runner = (path, cred, body = {}) => call('POST', `/runner/v1/${path}`, { cred, body });
async function own(sql, args = []) {
  const c = await owner.connect();
  try {
    await c.query('begin');
    const role = (await c.query("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'")).rows[0].r;
    await c.query(`set local role ${role}`); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]);
    const r = await c.query(sql, args); await c.query('commit'); return r.rows;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
/** pulse.v1_runner_principal as the API's v1 front door calls it, on a fresh transaction. */
async function principal(token, scope) {
  const c = await pool.connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]); return (await c.query('select pulse.v1_runner_principal($1,$2) v', [sha(token), scope])).rows[0].v; }
  finally { await c.query('rollback'); c.release(); }
}
const job = async (id) => (await own('select status,error_code,attempts,missing_since,event_count,last_state,cancel_acked_at,exit_code from pulse.runner_job where id=$1', [id]))[0];
const pairCode = async () => (await adminPost('runners/pair-code')).data;
const pair = async (code, hostname = 'wl-server') => runner('pair', null, { code, runner: { hostname, os: 'linux', arch: 'x64', version: '0.1.0' } });

// ------------------------------------------------------------------------------------------- admins only
for (const role of ['person', 'hr', 'leadership']) {
  eq((await adminGet('runners', role)).status, 403, `${role} cannot open Servers & AI`);
  eq((await adminPost('runners/pair-code', {}, role)).status, 403, `${role} cannot make a pairing code`);
}
eq((await call('GET', '/api/v0/admin/runners')).status, 401, 'anonymous: sign in first');
const empty = await adminGet('runners');
eq([empty.status, empty.data.runners, empty.data.jobs], [200, [], []], 'an admin sees no servers yet');
ok(empty.data.command.includes('--code XXXX-XXXX') && empty.data.command.startsWith('sudo npx --yes @vitalsos/pulse-runner connect '), 'the empty state shows the one-line install');

// ------------------------------------------------------------------------------------------- pairing
const first = await pairCode();
ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(first.code), 'a code looks like ABCD-1234');
eq([first.expiresIn, first.command.endsWith(`--code ${first.code}`)], [600, true], 'the code lives ten minutes and is in the command');
ok(Math.abs(Date.parse(first.expiresAt) - Date.now() - 600000) < 30000, 'expiresAt is ten minutes away');
eq((await own('select count(*)::int n from pulse_priv.runner_pair_code where code_hash=$1', [sha('runner-code:' + first.code)]))[0].n, 1, 'only the code hash is stored');
eq((await own('select count(*)::int n from pulse_priv.runner_pair_code where code_hash=$1', [first.code]))[0].n, 0, 'never the code');
eq((await adminGet('runners')).data.pairing.waiting, 1, 'the page knows a code is waiting (never which)');
eq((await pair('ZZZZ-ZZZ2')).data.error.code, 'invalid_code', 'an unknown code is 404 invalid_code');
eq((await pair('AB$D-12')).status, 400, 'a malformed code is 400');
const paired = await pair(first.code.replace('-', '').toLowerCase());
eq(paired.status, 200, 'the server pairs with the code (typed loosely)');
eq(Object.keys(paired.data).sort(), ['credential', 'orgId', 'orgName', 'runnerId'], 'pair answers runnerId, orgId, orgName and the credential');
eq(paired.data.orgId, ORG, 'orgId is this organisation');
ok(/^prc_[A-Za-z0-9_-]{43}$/.test(paired.data.credential), 'the credential starts with prc_ and is at least 32 characters');
const cred = paired.data.credential, R1 = paired.data.runnerId;
eq((await own('select count(*)::int n from pulse_priv.runner_credential where secret_hash=$1', [sha(cred)]))[0].n, 1, 'only the credential hash is stored');
const again = await pair(first.code);
eq([again.status, again.data.error.code], [409, 'code_used'], 'a code works once (409 code_used)');
const late = await pairCode();
await own(`update pulse_priv.runner_pair_code set expires_at=now()-interval '1 second' where code_hash=$1`, [sha('runner-code:' + late.code)]);
const expired = await pair(late.code);
eq([expired.status, expired.data.error.code], [410, 'expired_code'], 'an expired code is 410 expired_code');

// ------------------------------------------------------------------------------------------- credential, heartbeat, capabilities
eq((await runner('heartbeat', null, {})).data.error.code, 'invalid_credential', 'no credential: 401 (retryable, not runner_revoked)');
eq((await runner('heartbeat', 'prc_' + 'x'.repeat(43), {})).data.error.code, 'invalid_credential', 'an unknown credential: 401 invalid_credential');
const beat = await runner('heartbeat', cred, { version: '0.1.0', status: 'ready', runningJobs: [], maxConcurrent: 2, uptimeSec: 60 });
eq([beat.status, beat.data.ok], [200, true], 'heartbeat answers ok');
ok(Math.abs(Date.parse(beat.data.serverTime) - Date.now()) < 10000, 'heartbeat carries serverTime');
const caps = await runner('capabilities', cred, { runnerVersion: '0.1.0', reportedAt: new Date().toISOString(), apiKey: 'fixture-api-key', home: '/root',
  system: { os: 'linux', arch: 'x64', cpu: { model: 'AMD EPYC', cores: 8, loadAvg1: 0.4 }, ram: { totalBytes: 34359738368, freeBytes: 1e10 }, disk: { totalBytes: 5e11, freeBytes: 2.5e11 } },
  ai: { claude: { installed: true, version: '2.1.0', loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'owner@example.test' }, codex: { installed: false, version: null, loggedIn: false } },
  tools: { node: '24.1.0', python: '3.14.4', git: '2.53.0', docker: null }, isolation: { mode: 'bwrap', available: true, verified: true, reason: null }, limits: { maxConcurrent: 2, maxProfile: 'shell' } });
eq(caps.data, { ok: true }, 'capabilities answer ok');
const stored = JSON.stringify((await own('select capabilities c from pulse.runner where id=$1', [R1]))[0].c);
ok(!stored.includes('fixture-api-key') && !stored.includes('/root') && !stored.includes('owner@example'), 'capabilities outside the allow-list are never stored');
const listed = (await adminGet('runners')).data.runners;
eq(listed.map((r) => [r.id, r.name, r.online, r.claude.loggedIn, r.codex.loggedIn, r.isolation.verified, r.maxConcurrent]), [[R1, 'wl-server', true, true, false, true, 2]], 'the admin sees the server online, Claude connected');

// ------------------------------------------------------------------------------------------- a shell-safe job, start to finish
eq((await adminPost(`runners/${R1}/jobs`, { kind: 'shell-safe', command: ['rm', '-rf', '/'] })).status, 400, 'a command outside the allow-list is refused in Pulse');
eq((await adminPost(`runners/${R1}/jobs`, { kind: 'claude', prompt: 'x', profile: 'shell' })).status, 400, 'a shell job needs an explicit approval');
eq((await adminPost(`runners/${R1}/jobs`, { kind: 'shell-safe', command: ['uname', '-a'] }, 'leadership')).status, 403, 'leadership cannot start a job');
const s1 = (await adminPost(`runners/${R1}/jobs`, { kind: 'shell-safe', command: ['uname', '-a'] })).data.job;
eq([s1.status, s1.kind, s1.runnerName], ['queued', 'shell-safe', 'wl-server'], 'an admin starts a test job');
const got = await runner('poll', cred, { waitSec: 2, slots: 1, runningJobs: [] });
eq([got.status, got.data.jobs.length, got.data.cancel], [200, 1, []], 'the poll hands out the job');
const j1 = got.data.jobs[0];
eq([j1.id, j1.orgId, j1.kind, j1.command, j1.profile, j1.approval, j1.limits, j1.dryRun, j1.requestedBy.type], [s1.id, ORG, 'shell-safe', ['uname', '-a'], 'read-only', null, { timeLimitSec: 120 }, false, 'person'], 'the Job object as the protocol says');
ok(!('mcp' in j1) && !('prompt' in j1), 'a shell-safe job has no MCP token and no prompt');
eq((await runner('poll', cred, { waitSec: 0, slots: 2, runningJobs: [] })).data.jobs, [], 'a delivered job is not handed out again before 60 s');
eq((await runner(`jobs/${j1.id}/ack`, cred)).data, { ok: true }, 'ack');
eq((await job(j1.id)).status, 'running', 'acked: running');
const batch = { events: [{ seq: 1, ts: new Date().toISOString(), type: 'status', data: { state: 'running' } }, { seq: 2, type: 'log', data: { stream: 'stdout', line: 'Linux wl-server 6.8' } }, { seq: 3, type: 'unknown_type', data: {} }] };
eq((await runner(`jobs/${j1.id}/events`, cred, batch)).data, { ok: true, cancel: false }, 'events answer ok, cancel false');
await runner(`jobs/${j1.id}/events`, cred, batch);
eq((await own('select count(*)::int n from pulse.runner_job_event where job_id=$1', [j1.id]))[0].n, 2, 'a retried batch is deduplicated on (job, seq); unknown types are skipped');
eq((await job(j1.id)).last_state, 'running', 'the last state is kept');
eq((await call('PUT', `/runner/v1/jobs/${j1.id}/outputs?path=out/x.txt`, { cred, raw: Buffer.from('x'), headers: { 'x-content-sha256': sha('x') } })).status, 400, 'an undeclared output path is refused');
const result = { status: 'succeeded', dryRun: false, exitCode: 0, signal: null, error: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 120,
  usage: null, outputs: [], audit: { requestedBy: j1.requestedBy, kind: 'shell-safe', profile: 'read-only', approval: null, isolation: 'bwrap', promptSha256: null } };
eq((await runner(`jobs/${j1.id}/result`, cred, result)).data, { ok: true }, 'result ok');
eq((await runner(`jobs/${j1.id}/result`, cred, { ...result, status: 'failed' })).data, { ok: true }, 'a retried result answers ok');
eq([(await job(j1.id)).status, (await job(j1.id)).exit_code], ['succeeded', 0], 'and changes nothing (idempotent)');
eq((await runner(`jobs/${j1.id}/events`, cred, batch)).data.error.code, 'job_not_active', 'events of a finished job: job_not_active');
const used = (await adminGet('runners')).data.runners[0].usage;
eq([used.jobs, used.succeeded, used.failed, used.costUsd], [1, 1, 0, 0], 'the usage view counts the finished job (last 30 days)');

// ------------------------------------------------------------------------------------------- a Claude job: MCP token, outputs, cancel
const c1 = (await adminPost(`runners/${R1}/jobs`, { kind: 'claude', prompt: 'Draft the quotation follow-ups for today.', timeLimitSec: 600, costCapUsd: 2.5, outputs: [{ path: 'out/report.md', required: true }] })).data.job;
const jc = (await runner('poll', cred, { waitSec: 1, slots: 1, runningJobs: [] })).data.jobs[0];
eq([jc.id, jc.prompt, jc.limits, jc.outputs], [c1.id, 'Draft the quotation follow-ups for today.', { timeLimitSec: 600, costCapUsd: 2.5 }, [{ path: 'out/report.md', required: true }]], 'the Claude job carries prompt, limits and outputs');
ok(/^pmt_[A-Za-z0-9_-]{43}$/.test(jc.mcp.token) && jc.mcp.url === (process.env.PULSE_RUNNER_MCP_URL || 'https://mcp.vitalsos.ai/mcp'), 'and its own MCP token for the configured MCP URL');
const life = Date.parse(jc.mcp.expiresAt) - Date.now();
ok(life > 590000 && life <= 905000, 'the token lasts the time limit plus a small margin');
eq((await own('select count(*)::int n from pulse_priv.runner_mcp_token where token_hash=$1', [sha(jc.mcp.token)]))[0].n, 1, 'only the token hash is stored');
ok(await principal(jc.mcp.token, 'tasks.read'), 'the token reads Pulse as the admin who asked, while the job is with its server');
eq(await principal(jc.mcp.token, 'tasks.write'), null, 'never writes');
eq(await principal('pmt_' + 'q'.repeat(43), 'tasks.read'), null, 'an unknown token is nobody');
const mcp = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { authorization: `Bearer ${jc.mcp.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
eq(mcp.statusCode, 200, 'the Pulse MCP server accepts the job token');
await runner(`jobs/${jc.id}/ack`, cred);
const file = Buffer.from('# Follow-ups\n');
eq((await call('PUT', `/runner/v1/jobs/${jc.id}/outputs?path=out%2Freport.md`, { cred, raw: file, headers: { 'x-content-sha256': sha('other') } })).status, 400, 'a wrong hash is refused');
const up = await call('PUT', `/runner/v1/jobs/${jc.id}/outputs?path=out%2Freport.md`, { cred, raw: file, headers: { 'x-content-sha256': sha(file) } });
eq(up.status, 201, 'a declared output uploads (201)'); ok(/^out_[0-9a-f]{32}$/.test(up.data.outputId), 'with its outputId');
eq((await call('PUT', `/runner/v1/jobs/${jc.id}/outputs?path=out%2Freport.md`, { cred, raw: file, headers: { 'x-content-sha256': sha(file) } })).data.outputId, up.data.outputId, 'a retried upload keeps its id');
eq((await call('PUT', `/runner/v1/jobs/${jc.id}/outputs?path=..%2Fetc%2Fpasswd`, { cred, raw: file, headers: { 'x-content-sha256': sha(file) } })).status, 400, 'path traversal is refused');
eq((await adminPost(`runners/jobs/${jc.id}/cancel`)).data.job.status, 'cancelling', 'an admin cancels the running job');
const t0 = Date.now(); const cancelPoll = await runner('poll', cred, { waitSec: 10, slots: 0, runningJobs: [jc.id] });
ok(cancelPoll.data.cancel.includes(jc.id) && Date.now() - t0 < 3000, 'the poll delivers the cancel at once');
eq((await runner(`jobs/${jc.id}/events`, cred, { events: [{ seq: 1, type: 'status', data: { state: 'stopping' } }] })).data.cancel, true, 'events say cancel: true');
ok((await job(jc.id)).cancel_acked_at, 'the stopping status acknowledges the cancel');
await runner(`jobs/${jc.id}/result`, cred, { status: 'cancelled', error: { code: 'cancelled', message: 'Cancelled by Pulse' } });
eq((await job(jc.id)).status, 'cancelled', 'the job ends cancelled');
eq(await principal(jc.mcp.token, 'tasks.read'), null, 'its MCP token ended with the job');
eq((await adminPost(`runners/jobs/${jc.id}/cancel`)).status, 409, 'a finished job cannot be cancelled again');
const detail = (await adminGet(`runners/jobs/${jc.id}`)).data;
eq([detail.job.status, detail.outputs.map((o) => o.path), detail.events.length], ['cancelled', ['out/report.md'], 1], 'the admin reads the job, its files and events');

// ------------------------------------------------------------------------------------------- requeue, redelivery, lost jobs
const cap = (await adminPost(`runners/${R1}/jobs`, { kind: 'codex', prompt: 'Say hello' })).data.job;
const capJob = (await runner('poll', cred, { waitSec: 1, slots: 1, runningJobs: [] })).data.jobs[0];
await runner(`jobs/${cap.id}/result`, cred, { status: 'rejected', error: { code: 'capacity', message: 'No free slot' } });
eq((await job(cap.id)).status, 'queued', 'a capacity rejection goes back to the queue');
const capAgain = (await runner('poll', cred, { waitSec: 1, slots: 1, runningJobs: [] })).data.jobs[0];
eq(capAgain.id, cap.id, 'and is handed out again'); ok(capAgain.mcp.token !== capJob.mcp.token, 'with a new MCP token');
eq(await principal(capJob.mcp.token, 'tasks.read'), null, 'the old token ended');
await own(`update pulse.runner_job set delivered_at=now()-interval '61 seconds' where id=$1`, [cap.id]);
eq((await runner('poll', cred, { waitSec: 1, slots: 1, runningJobs: [] })).data.jobs.map((j) => j.id), [cap.id], 'a job not acknowledged within 60 s is handed out again');
await runner(`jobs/${cap.id}/ack`, cred);
await runner('heartbeat', cred, { runningJobs: [] });
ok((await job(cap.id)).missing_since, 'a running job missing from runningJobs starts its clock');
await runner('heartbeat', cred, { runningJobs: [cap.id] });
eq((await job(cap.id)).missing_since, null, 'and stops it when it is seen again');
await runner('heartbeat', cred, { runningJobs: [] });
await own(`update pulse.runner_job set missing_since=now()-interval '61 seconds' where id=$1`, [cap.id]);
await runner('heartbeat', cred, { runningJobs: [] });
eq([(await job(cap.id)).status, (await job(cap.id)).error_code], ['failed', 'runner_lost'], 'missing for over 60 s with no result: failed, runner_lost');
eq((await runner('poll', cred, { waitSec: 0, slots: 1, runningJobs: ['job_' + 'f'.repeat(32), cap.id] })).data.cancel.sort(), ['job_' + 'f'.repeat(32), cap.id].sort(), 'jobs Pulse does not hold as running are cancelled');

// ------------------------------------------------------------------------------------------- the long poll answers when work arrives
const held = runner('poll', cred, { waitSec: 8, slots: 1, runningJobs: [] }), started = Date.now();
await sleep(400);
const w1 = (await adminPost(`runners/${R1}/jobs`, { kind: 'shell-safe', command: ['uptime'] })).data.job;
const woke = await held;
ok(woke.data.jobs.some((j) => j.id === w1.id) && Date.now() - started < 4000, 'a held poll answers as soon as a job is started');

// ------------------------------------------------------------------------------------------- another server, rename, revoke, deregister
const two = await pair((await pairCode()).code, 'second-box');
const cred2 = two.data.credential, R2 = two.data.runnerId;
eq((await runner(`jobs/${w1.id}/ack`, cred2)).data.error.code, 'job_not_active', 'a server cannot touch another server\'s job');
eq((await runner('poll', cred2, { waitSec: 0, slots: 4, runningJobs: [] })).data.jobs, [], 'nor receive it');
eq((await adminPost(`runners/${R1}/rename`, { name: 'Willow Lane box' })).data.name, 'Willow Lane box', 'an admin renames a server');
eq((await adminPost(`runners/${R1}/rename`, { name: '  ' })).status, 400, 'a name is needed');
eq((await adminPost(`runners/${R1}/revoke`, {}, 'hr')).status, 403, 'HR cannot revoke a server');
eq((await adminPost(`runners/${R1}/revoke`)).data, { ok: true }, 'an admin revokes the server');
const refused = await runner('heartbeat', cred, {});
eq([refused.status, refused.data.error.code], [401, 'runner_revoked'], 'the revoked credential answers exactly 401 runner_revoked');
eq((await runner('poll', cred, { waitSec: 0, slots: 1 })).data.error.code, 'runner_revoked', 'on every endpoint');
eq((await job(w1.id)).status, 'cancelled', 'its unfinished jobs are cancelled');
eq((await adminGet('runners')).data.runners.map((r) => r.id), [R2], 'the revoked server leaves the list');
eq((await adminPost(`runners/${R1}/jobs`, { kind: 'shell-safe', command: ['uptime'] })).status, 404, 'no job for a revoked server');
eq((await runner('deregister', cred2, {})).data, { ok: true }, 'uninstall deregisters');
eq((await runner('heartbeat', cred2, {})).data.error.code, 'runner_revoked', 'and the credential ends');
eq((await own('select status from pulse.runner where id=$1', [R2]))[0].status, 'removed', 'the server is marked removed');

await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, receipts }, null, 2));
await app.close(); await pool.end(); await owner.end();
console.log(`runner protocol: ${checks} checks passed`);
void randomUUID;
