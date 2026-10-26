// CONNECT-AI (owner, 23 Oct 2026): Settings → AI. An organisation's admins and leadership connect the AI its AI
// employees use, and the servers they run on (migration 0958):
//  * Subscriptions, signed in once from Pulse, no API billing: Claude (Claude Code with a Pro/Max/Team plan: Pulse runs
//    the official `claude setup-token` on this server, shows its sign-in link, takes the code the person copies back,
//    and keeps the long-lived token it prints) and Codex (ChatGPT plan: `codex login --device-auth`; Pulse shows the
//    link and the one-time code and waits until the person has signed in). A token made with `claude setup-token` on
//    another computer can be pasted instead.
//  * API keys of any provider (ai-providers.ts), checked with the provider before they are kept: its model list and one
//    short call. An optional monthly token cap per key.
//  * Agent workspaces: a server reached over SSH with a key Pulse generates (the public half is shown to paste into
//    authorized_keys) or the organisation's own deploy key; Pulse checks it (ssh, uname, CPUs, memory, disk, tools) and
//    pins its host key. The Pulse cloud workspace (this server) is the default.
// Every secret (token, Codex sign-in, API key, private key) is sealed with the document keyring before it reaches the
// database (document-keys.ts; bound to the organisation and the row), is never returned to a browser, never logged,
// and is opened only here: for a test, or for an AI employee's runtime inside one of its own live runs
// (agentConnection, called from agents.ts with its key). Connect, disconnect, test and verify are audit events.
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Installation } from './installation.js';
import { fail, hr, leadership, type Tx, type Viewer } from './routes.js';
import { open as openSealed, requireKeyring, seal } from './document-keys.js';
import { API_PROVIDERS, CLAUDE_ARGS, cliPath, CODEX_ARGS, ProviderError, chat, cliOutcome, cliScript, isApiProvider, listModels, refreshedAuth, run, scrub, type ApiProvider } from './ai-providers.js';

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = (x: unknown, what: string) => UUID.test(String(x)) ? String(x) : fail(400, `Choose a valid ${what}`);
const str = (x: unknown, max: number) => typeof x === 'string' ? x.trim().slice(0, max) : '';
const MODEL = /^[A-Za-z0-9._:/@-]{1,120}$/;
const leaders = (v: Viewer) => { if (!leadership(v)) fail(403, 'Admins and leadership connect AI'); };
const local = () => process.env.PULSE_AI_ALLOW_LOCAL === '1';
const stateDir = async () => { const d = join(homedir(), '.local', 'state', 'pulse-ai'); await mkdir(d, { recursive: true, mode: 0o700 }); return d; };
const privateDir = async (prefix: string) => mkdtemp(join(await stateDir(), prefix));
const context = (org: string, kind: 'connection' | 'workspace', id: string) => `${org}/ai/${kind}/${id}`;
const audit = (c: PoolClient, action: string, resource: 'ai_connection' | 'ai_workspace' | 'ai_setting', id: string) => c.query('select pulse.ai_audit($1,$2,$3)', [action, resource, id]);

async function sealText(org: string, kind: 'connection' | 'workspace', id: string, plain: string) {
  const ring = await requireKeyring('ai');
  return seal(ring, Buffer.from(plain, 'utf8'), context(org, kind, id));
}
async function openText(org: string, kind: 'connection' | 'workspace', id: string, keyId: string, wrapped: Buffer, sealed: Buffer) {
  const ring = await requireKeyring('ai');
  const b = openSealed(ring, { keyId, dataKey: wrapped, data: sealed }, context(org, kind, id));
  try { return b.toString('utf8'); } finally { b.fill(0); }
}

/** A private or loopback address: refused for keys and workspaces unless this Pulse allows it (dev: PULSE_AI_ALLOW_LOCAL=1). */
function privateIp(ip: string) {
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd') || ip === '::') return true;
  const v4 = ip.replace(/^::ffff:/, '');
  const p = v4.split('.').map(Number);
  if (p.length !== 4) return false;
  return p[0] === 127 || p[0] === 10 || p[0] === 0 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
async function publicHost(host: string, what: string) {
  if (local()) return;
  const ips = isIP(host) ? [host] : await lookup(host, { all: true }).then((x) => x.map((a) => a.address)).catch(() => fail(400, `${what}: ${host} could not be found`));
  if (!ips.length || ips.some(privateIp)) fail(400, `${what}: ${host} is a private or local address, which Pulse does not reach`);
}
async function baseUrlOf(provider: ApiProvider, given: unknown) {
  const preset = API_PROVIDERS[provider].base;
  if (preset) return preset;
  const raw = str(given, 300).replace(/\/+$/, '');
  let u: URL; try { u = new URL(raw); } catch { return fail(400, 'Give the address of the OpenAI-compatible API, e.g. https://llm.example.com/v1'); }
  if (u.username || u.password || u.search || u.hash) fail(400, 'Give the address without a user name, query or #');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local())) fail(400, 'The address must start with https://');
  await publicHost(u.hostname.replace(/^\[|\]$/g, ''), 'The address');
  return u.toString().replace(/\/+$/, '');
}

// ---- Workspaces over SSH ----
type WorkspaceRow = { id: string; host: string; port: number; username: string; host_key: string | null; key_id: string; key_wrapped: Buffer; key_sealed: Buffer };
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const CHECK = `echo "os=$(uname -srm)"; echo "host=$(hostname)"; echo "cpus=$(nproc 2>/dev/null)"; awk '/MemTotal/{print "mem="int($2/1024)} /MemAvailable/{print "memfree="int($2/1024)}' /proc/meminfo 2>/dev/null; echo "disk=$(df -Pm "$HOME" 2>/dev/null | awk 'NR==2{print $4"/"$2}')"; echo "load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"; for t in docker node python3 git claude codex gemini; do if command -v $t >/dev/null 2>&1; then echo "tool=$t|$($t --version 2>/dev/null | head -1 | cut -c1-60)"; fi; done`;
type Facts = { os?: string; host?: string; cpus?: number; memMb?: number; memFreeMb?: number; diskFreeMb?: number; diskMb?: number; load?: number; tools: Record<string, string> };
function factsOf(out: string): Facts {
  const f: Facts = { tools: {} };
  for (const line of out.split('\n')) {
    const [k, ...rest] = line.split('='); const v = rest.join('=').trim();
    if (k === 'os') f.os = v.slice(0, 120); if (k === 'host') f.host = v.slice(0, 80);
    if (k === 'cpus' && v) f.cpus = Number(v); if (k === 'mem' && v) f.memMb = Number(v); if (k === 'memfree' && v) f.memFreeMb = Number(v);
    if (k === 'load' && v) f.load = Number(v);
    if (k === 'disk' && v.includes('/')) { const [free, total] = v.split('/').map(Number); f.diskFreeMb = free; f.diskMb = total; }
    if (k === 'tool') { const [name, version] = v.split('|'); if (/^[a-z0-9]{2,12}$/.test(name)) f.tools[name] = (version ?? '').replace(/[^\w .()+-]/g, '').trim().slice(0, 60); }
  }
  return f;
}
/** Run a script on a workspace over SSH with its own key in a private temp file (removed after), its host key pinned
 *  after the first contact. Returns what it printed and the host key it presented. */
export async function sshRun(w: { host: string; port: number; username: string; hostKey: string | null }, privateKey: string, script: string, input: string, timeoutMs: number) {
  const dir = await privateDir('ssh-');
  try {
    const id = join(dir, 'id'), kh = join(dir, 'known_hosts');
    await writeFile(id, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 });
    await writeFile(kh, w.hostKey ? `${w.hostKey}\n` : '', { mode: 0o600 });
    const r = await run('ssh', ['-i', id, '-p', String(w.port), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', `UserKnownHostsFile=${kh}`,
      '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `StrictHostKeyChecking=${w.hostKey ? 'yes' : 'accept-new'}`, '-o', 'LogLevel=ERROR', `${w.username}@${w.host}`, `bash -lc ${q(script)}`], input, timeoutMs);
    const hostKey = (await readFile(kh, 'utf8')).trim().split('\n').filter(Boolean).join('\n') || null;
    return { ...r, hostKey };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function keygen() {
  const dir = await privateDir('key-');
  try {
    const r = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'pulse-agent-workspace', '-f', join(dir, 'k')], '', 20000);
    if (r.code !== 0) fail(500, 'Pulse could not make a key for this server');
    return { privateKey: await readFile(join(dir, 'k'), 'utf8'), publicKey: (await readFile(join(dir, 'k.pub'), 'utf8')).trim() };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function publicOf(privateKey: string) {
  if (!/^-----BEGIN (OPENSSH|RSA|EC) PRIVATE KEY-----[\s\S]+-----END (OPENSSH|RSA|EC) PRIVATE KEY-----\s*$/.test(privateKey.trim())) fail(400, 'Paste the whole private key, from -----BEGIN … to -----END … PRIVATE KEY-----');
  const dir = await privateDir('key-');
  try {
    await writeFile(join(dir, 'k'), `${privateKey.trim()}\n`, { mode: 0o600 });
    const r = await run('ssh-keygen', ['-y', '-P', '', '-f', join(dir, 'k')], '', 10000);
    if (r.code !== 0) fail(400, 'That key could not be read. Use a key without a passphrase (a deploy key made for Pulse).');
    return r.out.trim();
  } finally { await rm(dir, { recursive: true, force: true }); }
}
let checking = false;
let cloud: { state: 'ok' | 'error' | 'new'; facts: Facts | null; checkedAt: string | null; error: string | null } = { state: 'new', facts: null, checkedAt: null, error: null };
async function checkCloud() {
  try { const r = await run('bash', ['-lc', CHECK], '', 60000); cloud = { state: r.code === 0 ? 'ok' : 'error', facts: factsOf(r.out), checkedAt: new Date().toISOString(), error: r.code === 0 ? null : scrub(r.err) }; }
  catch (e) {
    // This server answers every request, so a slow check means it is busy, not unreachable: keep the last facts and say so.
    cloud = cloud.facts ? { ...cloud, checkedAt: new Date().toISOString(), error: 'The latest check took too long (the server is busy); these are the facts from the check before.' }
      : { state: 'error', facts: null, checkedAt: new Date().toISOString(), error: `The check did not finish: ${scrub((e as Error).message)}` };
  }
  return cloud;
}

// ---- Subscriptions: this server's own sign-ins (the install's own organisation only) ----
async function serverAccount(provider: 'claude' | 'codex') {
  try {
    if (provider === 'claude') {
      const j = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8')) as { oauthAccount?: { emailAddress?: string; organizationName?: string } };
      const e = j.oauthAccount?.emailAddress, o = j.oauthAccount?.organizationName;
      return e ? `${e}${o && !o.includes(e) ? ` · ${o}` : ''}` : null;
    }
    return codexAccount(await readFile(join(homedir(), '.codex', 'auth.json'), 'utf8'));
  } catch { return null; }
}
function codexAccount(authJson: string) {
  try {
    const a = JSON.parse(authJson) as { tokens?: { id_token?: string } };
    const p = JSON.parse(Buffer.from(String(a.tokens?.id_token ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const plan = (p['https://api.openai.com/auth'] as { chatgpt_plan_type?: string } | undefined)?.chatgpt_plan_type;
    const email = typeof p.email === 'string' ? p.email : null;
    return email ? `${email}${plan ? ` · ChatGPT ${plan[0].toUpperCase()}${plan.slice(1)}` : ''}` : null;
  } catch { return null; }
}
async function claudeAccount(token: string) {
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/profile', { headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json() as { account?: { email?: string; email_address?: string }; organization?: { name?: string; organization_type?: string } };
    const email = d.account?.email_address ?? d.account?.email;
    return email ? `${email}${d.organization?.organization_type ? ` · ${d.organization.organization_type.replace(/_/g, ' ')}` : ''}`.slice(0, 160) : null;
  } catch { return null; }
}
const serverTests = new Map<string, { state: string; detail: string | null; until: string | null; at: string }>();

/** One short test call with a CLI: on this server (its own sign-in, or the given secret) or on a workspace. */
async function cliTest(provider: 'claude' | 'codex', secret: string | null, ws: { row: WorkspaceRow; key: string } | null): Promise<{ text: string; tokens: number | null; refreshed: string | null; hostKey?: string | null }> {
  const prompt = 'This is a connection test from Pulse. Reply with the single word OK.';
  const args = provider === 'claude' ? CLAUDE_ARGS(null, null) : CODEX_ARGS(null, null);
  const line = secret ? Buffer.from(secret, 'utf8').toString('base64') : '';
  if (ws) {
    const r = await sshRun({ host: ws.row.host, port: ws.row.port, username: ws.row.username, hostKey: ws.row.host_key }, ws.key, cliScript(provider, args), `${line}\n${prompt}`, 240000);
    if (r.code === 255) throw new ProviderError('error', `Could not reach the workspace: ${scrub(r.err) || 'SSH refused'}`);
    if (r.code === 127 || /command not found/.test(r.err)) throw new ProviderError('error', `${provider === 'claude' ? 'Claude Code' : 'Codex'} is not installed on the workspace`);
    return { ...cliOutcome(provider, r), refreshed: provider === 'codex' && secret ? refreshedAuth(r.err) : null };
  }
  const r = await run('bash', ['-c', cliScript(provider, args)], `${line}\n${prompt}`, 240000);
  return { ...cliOutcome(provider, r), refreshed: provider === 'codex' && secret ? refreshedAuth(r.err) : null };
}

// ---- Sign-in sessions (kept in this process for 15 minutes; a restart asks to start again) ----
type Session = { id: string; org: string; person: string; provider: 'claude' | 'codex'; name: string; workspaceId: string | null; dir: string; child: ChildProcessWithoutNullStreams;
  out: string; url: string | null; code: string | null; exited: boolean; exitCode: number | null; done: boolean; expires: number; timer: NodeJS.Timeout };
const sessions = new Map<string, Session>();
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\r/g;
async function endSession(s: Session) {
  clearTimeout(s.timer); sessions.delete(s.id);
  if (!s.exited) s.child.kill('SIGKILL');
  s.out = ''; await rm(s.dir, { recursive: true, force: true }).catch(() => {});
}
const waitFor = (s: Session, test: () => boolean, ms: number) => new Promise<boolean>((resolve) => {
  const t0 = Date.now(); const tick = () => { if (test()) return resolve(true); if (s.exited || Date.now() - t0 > ms) return resolve(test()); setTimeout(tick, 250); }; tick();
});
async function startSession(org: string, person: string, provider: 'claude' | 'codex', name: string, workspaceId: string | null): Promise<Session> {
  for (const s of sessions.values()) if (s.org === org && s.person === person) await endSession(s);
  const dir = await privateDir(`${provider}-`);
  const child = provider === 'claude'
    ? spawn('script', ['-qfec', 'stty cols 4000 rows 60 2>/dev/null; exec claude setup-token', '/dev/null'], { cwd: dir, env: { ...process.env, PATH: cliPath(), CLAUDE_CONFIG_DIR: dir, TERM: 'xterm-256color', BROWSER: '/bin/true' }, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn('codex', ['login', '--device-auth'], { cwd: dir, env: { ...process.env, PATH: cliPath(), CODEX_HOME: dir, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const s: Session = { id: randomUUID(), org, person, provider, name, workspaceId, dir, child, out: '', url: null, code: null, exited: false, exitCode: null, done: false, expires: Date.now() + 15 * 60000,
    timer: setTimeout(() => { void endSession(s); }, 15 * 60000) };
  const read = (d: Buffer) => {
    s.out = (s.out + d.toString('utf8')).slice(-200_000);
    if (!s.url) {
      const m = provider === 'claude' ? s.out.match(/https:\/\/claude\.(?:com|ai)\/[^\s\x07\x1b"']*oauth\/authorize\?[^\s\x07\x1b"']+/) : s.out.replace(ANSI, '').match(/https:\/\/auth\.openai\.com\/[^\s\x1b]+/);
      if (m) s.url = m[0];
    }
    if (provider === 'codex' && !s.code) { const m = s.out.replace(ANSI, '').match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/); if (m) s.code = m[1]; }
  };
  child.stdout.on('data', read); child.stderr.on('data', read);
  child.on('close', (code) => { s.exited = true; s.exitCode = code; });
  child.on('error', () => { s.exited = true; s.exitCode = -1; });
  child.stdin.on('error', () => {});
  sessions.set(s.id, s);
  await waitFor(s, () => !!s.url && (provider === 'claude' || !!s.code), 25000);
  if (!s.url) { const said = scrub(s.out.replace(ANSI, '')); await endSession(s); throw exposed(502, `${provider === 'claude' ? 'Claude Code' : 'Codex'} did not start its sign-in on this server${said ? `: ${said}` : ''}. Try again in a minute.`); }
  return s;
}
const sessionView = (s: Session) => ({ id: s.id, provider: s.provider, url: s.url, code: s.code, expiresAt: new Date(s.expires).toISOString() });

// ---- Views ----
const CONNECTIONS = `select c.id,c.kind,c.provider,c.name,c.account,c.last4,c.base_url "baseUrl",c.models,c.default_model model,c.workspace_id "workspaceId",
  c.monthly_token_cap::text cap,pulse.ai_connection_used(c.id)::text used,c.state,c.state_detail detail,c.state_until until,c.checked_at "checkedAt",c.created_at "createdAt",
  p.display_name "createdBy",(select count(*) from pulse.agent_member m where m.ai_connection_id=c.id)::int agents
  from pulse.ai_connection c left join pulse.person p on p.id=c.created_by where c.removed_at is null`;
type ConnRow = { id: string; kind: string; provider: string; name: string; account: string | null; last4: string | null; baseUrl: string | null; models: string[]; model: string | null;
  workspaceId: string | null; cap: string | null; used: string; state: string; detail: string | null; until: string | null; checkedAt: string | null; createdAt: string; createdBy: string | null; agents: number };
const connView = (r: ConnRow) => {
  const { last4, cap, used, baseUrl, ...rest } = r;
  return { ...rest, masked: last4 ? `••••${last4}` : null, baseUrl: r.provider === 'custom' ? baseUrl : null, cap: cap === null ? null : Number(cap), used: Number(used),
    providerName: r.kind === 'api' && isApiProvider(r.provider) ? API_PROVIDERS[r.provider].name : r.provider === 'claude' ? 'Claude' : 'ChatGPT · Codex' };
};
const WORKSPACES = `select w.id,w.name,w.host,w.port,w.username,w.key_source "keySource",w.public_key "publicKey",w.state,w.facts,w.error,w.checked_at "checkedAt",w.created_at "createdAt",
  w.host_key is not null pinned,(select count(*) from pulse.agent_member m where m.ai_workspace_id=w.id)::int agents,
  (select count(*) from pulse.ai_connection c where c.workspace_id=w.id and c.removed_at is null)::int connections
  from pulse.ai_workspace w where w.removed_at is null`;

async function connRow(c: PoolClient, id: string) {
  const r = (await c.query(`select * from pulse.ai_connection where id=$1 and removed_at is null`, [uuid(id, 'connection')])).rows[0];
  return r ?? fail(404, 'That connection is not here any more');
}
async function workspaceFor(c: PoolClient, org: string, id: string | null) {
  if (!id) return null;
  const row = (await c.query('select * from pulse.ai_workspace where id=$1 and removed_at is null', [id])).rows[0] as WorkspaceRow | undefined;
  if (!row) return fail(400, 'Choose one of this organisation\'s workspaces');
  return { row, key: await openText(org, 'workspace', row.id, row.key_id, row.key_wrapped, row.key_sealed) };
}
async function policy(c: PoolClient) { return (await c.query('select paid_api_keys from pulse.ai_setting where org_id=pulse.current_org()')).rows[0]?.paid_api_keys !== false; }
async function serverEntries(c: PoolClient, own: boolean) {
  if (!own) return [];
  const states = (await c.query(`select provider,max(runtime_until) filter (where runtime_state='out_of_quota' and runtime_until>now()) until,
      count(*)::int agents from pulse.agent_member where ai_connection_id is null and provider in ('claude','codex') group by provider`)).rows as { provider: string; until: string | null; agents: number }[];
  return Promise.all((['claude', 'codex'] as const).map(async (p) => {
    const s = states.find((x) => x.provider === p), t = serverTests.get(p);
    const quota = t ? t.state === 'out_of_quota' && t.until && Date.parse(t.until) > Date.now() : !!s?.until;
    return { id: `server:${p}`, kind: 'subscription', provider: p, builtin: true, name: p === 'claude' ? 'Claude Max · this server' : 'Codex · this server',
      providerName: p === 'claude' ? 'Claude' : 'ChatGPT · Codex', account: await serverAccount(p), agents: s?.agents ?? 0,
      state: quota ? 'out_of_quota' : t?.state ?? 'connected', detail: t?.detail ?? null, until: quota ? t?.until ?? s?.until ?? null : null, checkedAt: t?.at ?? null };
  }));
}

async function saveConnection(c: PoolClient, v: Viewer, x: { kind: 'subscription' | 'api'; provider: string; name: string; secret: string; last4: string; account: string | null; baseUrl: string | null;
  models: string[]; model: string | null; workspaceId: string | null; cap: number | null }) {
  const id = randomUUID(), s = await sealText(v.org, 'connection', id, x.secret);
  await c.query(`insert into pulse.ai_connection(org_id,id,kind,provider,name,base_url,account,last4,secret_key_id,secret_wrapped,secret_sealed,models,default_model,workspace_id,monthly_token_cap,state,checked_at,created_by)
    values (pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'connected',now(),$15)`,
    [id, x.kind, x.provider, x.name, x.baseUrl, x.account, x.last4, s.keyId, s.dataKey, s.data, x.models.slice(0, 400), x.model, x.workspaceId, x.cap, v.person]);
  await audit(c, 'ai.connect', 'ai_connection', id);
  return connView((await c.query(`${CONNECTIONS} and c.id=$1`, [id])).rows[0]);
}
const capOf = (x: unknown) => { if (x === undefined || x === null || x === '') return null; const n = Number(x); return Number.isInteger(n) && n >= 1000 && n <= 1e10 ? n : fail(400, 'A monthly limit of at least 1,000 tokens, or none'); };
const nameOf = (x: unknown, fallback: string) => { const n = str(x, 81) || fallback; return n.length <= 80 ? n : fail(400, 'A name of up to 80 characters'); };
async function workspaceIdOf(c: PoolClient, x: unknown) {
  if (x === undefined || x === null || x === '' || x === 'cloud') return null;
  const id = uuid(x, 'workspace');
  if (!(await c.query('select 1 from pulse.ai_workspace where id=$1 and removed_at is null', [id])).rowCount) fail(400, 'Choose one of this organisation\'s workspaces');
  return id;
}

export function registerConnectAiRoutes(app: FastifyInstance, { tx }: { tx: Tx }, installation: Installation) {
  const own = async (v: Viewer) => v.org === await installation.readOrg();

  app.get('/api/v0/ai', req => tx(req, async (c, v) => {
    leaders(v);
    // The cloud workspace's health is checked in the background (a busy server must not hold the page); the last result shows.
    if (!checking && (!cloud.checkedAt || Date.now() - Date.parse(cloud.checkedAt) > 10 * 60000)) { checking = true; void checkCloud().finally(() => { checking = false; }); }
    const mine = await own(v);
    return {
      canEdit: true, paidApiKeys: await policy(c), installOrg: mine,
      connections: (await c.query(`${CONNECTIONS} order by c.created_at`)).rows.map(connView),
      server: await serverEntries(c, mine),
      workspaces: (await c.query(`${WORKSPACES} order by w.created_at`)).rows,
      cloud: { id: 'cloud', name: 'Pulse cloud workspace', builtin: true, host: hostname(), ...cloud },
      providers: Object.entries(API_PROVIDERS).map(([key, p]) => ({ key, name: p.name, paid: p.paid, keyHint: p.keyHint, keysAt: p.keysAt, needsUrl: !p.base })),
      subscriptions: [
        { key: 'claude', name: 'Claude', plan: 'Claude Pro, Max or Team', how: 'Sign in with your Claude account in your browser; Pulse keeps the long-lived token Claude Code makes (claude setup-token).', available: true },
        { key: 'codex', name: 'ChatGPT · Codex', plan: 'ChatGPT Plus, Pro, Business or Enterprise', how: 'Open the link, enter the one-time code and sign in with ChatGPT (codex login --device-auth).', available: true },
        { key: 'gemini', name: 'Google Gemini CLI', plan: 'Google AI Pro or Ultra', how: 'Gemini CLI signs in through a browser on the same computer; there is no supported way to sign it in for a server yet. Use a Gemini API key below meanwhile.', available: false },
        { key: 'antigravity', name: 'Google Antigravity', plan: 'Google AI plans', how: 'Antigravity is a desktop app with no command line or server sign-in, so agents cannot run on it.', available: false },
      ],
      signin: [...sessions.values()].filter((s) => s.org === v.org && s.person === v.person && !s.done).map(sessionView),
    };
  }));

  // Who may pick an AI on an AI employee's profile (HR too): the connections by name and state, never a secret.
  app.get('/api/v0/ai/choices', req => tx(req, async (c, v) => {
    if (!hr(v)) fail(403, 'Admins, HR and leadership choose an AI employee\'s AI');
    const mine = await own(v);
    return { paidApiKeys: await policy(c), canConnect: leadership(v),
      connections: (await c.query(`${CONNECTIONS} order by c.created_at`)).rows.map(connView).map(({ id, kind, provider, providerName, name, account, models, model, cap, used, state, until, workspaceId, masked }) =>
        ({ id, kind, provider, providerName, name, account, models, model, cap, used, state, until, workspaceId, masked })),
      server: (await serverEntries(c, mine)).map(({ id, provider, name, account, state, until }) => ({ id, provider, name, account, state, until })),
      workspaces: [{ id: 'cloud', name: 'Pulse cloud workspace', state: cloud.state === 'error' ? 'error' : 'ok' },
        ...(await c.query('select id,name,state from pulse.ai_workspace where removed_at is null order by created_at')).rows] };
  }));

  app.post<{ Body: Body }>('/api/v0/ai/policy', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    leaders(v);
    if (typeof req.body.paidApiKeys !== 'boolean') fail(400, 'Turn paid API keys on or off');
    await c.query(`insert into pulse.ai_setting(org_id,paid_api_keys,updated_by,updated_at) values (pulse.current_org(),$1,$2,now())
      on conflict (org_id) do update set paid_api_keys=excluded.paid_api_keys,updated_by=excluded.updated_by,updated_at=now()`, [req.body.paidApiKeys, v.person]);
    await audit(c, 'ai.policy', 'ai_setting', v.org);
    return { paidApiKeys: req.body.paidApiKeys };
  }));

  // An API key: checked with the provider (its models, and one short call) before it is sealed and kept.
  app.post<{ Body: Body }>('/api/v0/ai/keys', { schema: { body: { type: 'object' } } }, async (req, reply) => reply.header('cache-control', 'no-store').send(await tx(req, async (c, v) => {
    leaders(v);
    const b = req.body, provider = isApiProvider(b.provider) ? b.provider : fail(400, 'Choose a provider');
    const p = API_PROVIDERS[provider];
    if (p.paid && !(await policy(c))) fail(403, 'This organisation runs its AI on subscriptions only: paid API keys are off. An admin can turn them on above.');
    const key = typeof b.key === 'string' ? b.key.trim() : '';
    if (key.length < 8 || key.length > 400 || /\s/.test(key)) fail(400, 'Paste the whole API key');
    const base = await baseUrlOf(provider, b.baseUrl);
    let models: string[] = [];
    try { models = await listModels(p.style, base, key); }
    catch (e) { if (!(e instanceof ProviderError) || e.kind === 'refused' || provider !== 'custom') throw toHttp(e); }
    const chosen = str(b.model, 121) || models[0] || '';
    if (!chosen || !MODEL.test(chosen)) fail(400, models.length ? 'Choose a model' : 'The provider listed no models; type the model to use');
    try { await chat(p.style, base, key, chosen, 'This is a connection test from Pulse. Reply with the single word OK.', { maxTokens: 16 }); }
    catch (e) { throw toHttp(e); }
    const conn = await saveConnection(c, v, { kind: 'api', provider, name: nameOf(b.name, p.name), secret: key, last4: key.slice(-4).replace(/[^A-Za-z0-9_-]/g, ''), account: null,
      baseUrl: provider === 'custom' ? base : null, models: models.length ? models : [chosen], model: chosen, workspaceId: null, cap: capOf(b.monthlyTokenCap) });
    return { connection: conn };
  })));

  // A Claude token made with `claude setup-token` on another computer, pasted.
  app.post<{ Body: Body }>('/api/v0/ai/subscriptions', { schema: { body: { type: 'object' } } }, async (req, reply) => reply.header('cache-control', 'no-store').send(await tx(req, async (c, v) => {
    leaders(v);
    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    if (req.body.provider !== 'claude' || !/^sk-ant-oat01-[A-Za-z0-9_-]{20,300}$/.test(token)) fail(400, 'Paste the token `claude setup-token` printed (it starts with sk-ant-oat01-)');
    const workspaceId = await workspaceIdOf(c, req.body.workspaceId);
    return { connection: await saveConnection(c, v, { kind: 'subscription', provider: 'claude', name: nameOf(req.body.name, 'Claude'), secret: token, last4: token.slice(-4).replace(/[^A-Za-z0-9_-]/g, ''),
      account: await claudeAccount(token), baseUrl: null, models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-5'], model: null, workspaceId, cap: null }) };
  })));

  // Sign in with a subscription: Pulse starts the official CLI sign-in on this server and shows its link (and code).
  app.post<{ Body: Body }>('/api/v0/ai/signin', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    leaders(v);
    const provider = req.body.provider === 'claude' || req.body.provider === 'codex' ? req.body.provider : fail(400, 'Choose Claude or Codex');
    const workspaceId = await workspaceIdOf(c, req.body.workspaceId);
    return sessionView(await startSession(v.org, v.person ?? v.email, provider, nameOf(req.body.name, provider === 'claude' ? 'Claude' : 'ChatGPT · Codex'), workspaceId));
  }));
  const session = (id: string, v: Viewer) => { const s = sessions.get(id); if (!s || s.org !== v.org || s.person !== (v.person ?? v.email)) fail(404, 'That sign-in has ended. Start again.'); return s!; };
  // Claude: the code the person copied after signing in. Claude Code then prints the long-lived token, which is sealed.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/ai/signin/:id/code', { schema: { body: { type: 'object' } } }, async (req, reply) => reply.header('cache-control', 'no-store').send(await tx(req, async (c, v) => {
    leaders(v);
    const s = session(uuid(req.params.id, 'sign-in'), v);
    const code = str(req.body.code, 600);
    if (s.provider !== 'claude' || !/^[A-Za-z0-9_#.~-]{10,600}$/.test(code)) fail(400, 'Paste the code Claude showed after you signed in');
    const before = s.out.length;
    s.child.stdin.write(`${code}\r`);
    const TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
    await waitFor(s, () => TOKEN.test(s.out.slice(before).replace(ANSI, '')), 45000);
    const m = s.out.slice(before).replace(ANSI, '').match(TOKEN);
    if (!m) {
      const raw = s.out.slice(before).replace(ANSI, '').replace(/[\x00-\x1f]/g, ' ');
      const said = scrub(raw.match(/OAuth error:.*?(?=Press Enter|$)/)?.[0] ?? (/error|invalid|expired/i.test(raw) ? raw.replace(/.*?(error|invalid|expired)/i, '$1') : ''));
      await endSession(s);
      return fail(400, `Claude did not accept that code${said ? ` (${said.slice(0, 160)})` : ''}. Start the sign-in again and paste the newest code.`);
    }
    const token = m[0]; s.done = true; await endSession(s);
    return { state: 'connected', connection: await saveConnection(c, v, { kind: 'subscription', provider: 'claude', name: s.name, secret: token, last4: token.slice(-4), account: await claudeAccount(token),
      baseUrl: null, models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-5'], model: null, workspaceId: s.workspaceId, cap: null }) };
  })));
  // Codex: asked every few seconds until the person has signed in with the code (then its sign-in is sealed).
  app.get<{ Params: { id: string } }>('/api/v0/ai/signin/:id', async (req, reply) => reply.header('cache-control', 'no-store').send(await tx(req, async (c, v) => {
    leaders(v);
    const s = session(uuid(req.params.id, 'sign-in'), v);
    if (s.provider !== 'codex' || !s.exited) return { state: 'waiting', ...sessionView(s) };
    const auth = await readFile(join(s.dir, 'auth.json'), 'utf8').catch(() => null);
    if (s.exitCode !== 0 || !auth) { const said = scrub(s.out.replace(ANSI, '').split('\n').slice(-3).join(' ')); await endSession(s); return { state: 'failed', error: `The sign-in did not finish${said ? `: ${said}` : ''}. Start again.` }; }
    s.done = true; await endSession(s);
    const last = (JSON.parse(auth) as { tokens?: { account_id?: string } }).tokens?.account_id ?? '';
    return { state: 'connected', connection: await saveConnection(c, v, { kind: 'subscription', provider: 'codex', name: s.name, secret: auth, last4: last.slice(-4).replace(/[^A-Za-z0-9_-]/g, ''),
      account: codexAccount(auth), baseUrl: null, models: ['gpt-6-luna', 'gpt-6', 'gpt-6-codex'], model: null, workspaceId: s.workspaceId, cap: null }) };
  })));
  app.post<{ Params: { id: string } }>('/api/v0/ai/signin/:id/cancel', req => tx(req, async (_c, v) => {
    leaders(v); const s = sessions.get(uuid(req.params.id, 'sign-in')); if (s && s.org === v.org && s.person === (v.person ?? v.email)) await endSession(s); return { ok: true };
  }));

  // Test a connection (or this server's own sign-in): one short call; its state is updated from what the provider said.
  app.post<{ Params: { id: string } }>('/api/v0/ai/connections/:id/test', async (req, reply) => reply.header('cache-control', 'no-store').send(await tx(req, async (c, v) => {
    leaders(v);
    if (req.params.id === 'server:claude' || req.params.id === 'server:codex') {
      if (!(await own(v))) fail(404, 'Not found');
      const p = req.params.id.slice(7) as 'claude' | 'codex';
      try { await cliTest(p, null, null); serverTests.set(p, { state: 'connected', detail: 'Answered a test just now', until: null, at: new Date().toISOString() }); }
      catch (e) { const x = e instanceof ProviderError ? e : new ProviderError('error', scrub(String((e as Error).message)));
        serverTests.set(p, { state: x.kind === 'quota' ? 'out_of_quota' : x.kind === 'refused' ? 'expired' : 'error', detail: x.message, until: x.until?.toISOString() ?? null, at: new Date().toISOString() }); }
      const t = serverTests.get(p)!; return { ok: t.state === 'connected', ...t };
    }
    const row = await connRow(c, req.params.id);
    const secret = await openText(v.org, 'connection', row.id, row.secret_key_id, row.secret_wrapped, row.secret_sealed);
    let state = 'connected', detail = 'Answered a test just now', until: Date | null = null, models: string[] | null = null, refreshed: string | null = null;
    try {
      if (row.kind === 'api') {
        const p = API_PROVIDERS[row.provider as ApiProvider], base = row.base_url ?? p.base!;
        models = await listModels(p.style, base, secret).catch((e) => { if (row.provider === 'custom' && e instanceof ProviderError && e.kind === 'error') return null; throw e; });
        await chat(p.style, base, secret, row.default_model ?? models?.[0] ?? '', 'This is a connection test from Pulse. Reply with the single word OK.', { maxTokens: 16 });
      } else {
        const r = await cliTest(row.provider, secret, await workspaceFor(c, v.org, row.workspace_id));
        refreshed = r.refreshed && r.refreshed !== secret ? r.refreshed : null;
        detail = row.workspace_id ? 'Answered a test on its workspace just now' : detail;
      }
    } catch (e) {
      const x = e instanceof ProviderError ? e : new ProviderError('error', scrub(String((e as Error).message)));
      state = x.kind === 'quota' ? 'out_of_quota' : x.kind === 'refused' ? 'expired' : 'error'; detail = x.message; until = x.until;
    }
    const s = refreshed ? await sealText(v.org, 'connection', row.id, refreshed) : null;
    await c.query(`update pulse.ai_connection set state=$2,state_detail=$3,state_until=$4,checked_at=now(),models=coalesce($5,models),
      secret_key_id=coalesce($6,secret_key_id),secret_wrapped=coalesce($7,secret_wrapped),secret_sealed=coalesce($8,secret_sealed) where id=$1`,
      [row.id, state, detail.slice(0, 300), state === 'out_of_quota' ? until : null, models?.length ? models.slice(0, 400) : null, s?.keyId ?? null, s?.dataKey ?? null, s?.data ?? null]);
    await audit(c, 'ai.test', 'ai_connection', row.id);
    return { ok: state === 'connected', state, detail, until, connection: connView((await c.query(`${CONNECTIONS} and c.id=$1`, [row.id])).rows[0]) };
  })));

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/ai/connections/:id', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    leaders(v);
    const row = await connRow(c, req.params.id), b = req.body;
    const model = b.model === undefined ? row.default_model : str(b.model, 121) || null;
    if (model && !MODEL.test(model)) fail(400, 'Choose a model');
    await c.query('update pulse.ai_connection set name=$2,default_model=$3,monthly_token_cap=$4,workspace_id=$5 where id=$1', [row.id, b.name === undefined ? row.name : nameOf(b.name, row.name), model,
      b.monthlyTokenCap === undefined ? row.monthly_token_cap : capOf(b.monthlyTokenCap), b.workspaceId === undefined ? row.workspace_id : await workspaceIdOf(c, b.workspaceId)]);
    return { connection: connView((await c.query(`${CONNECTIONS} and c.id=$1`, [row.id])).rows[0]) };
  }));
  // Disconnect: the sealed secret is destroyed at once (crypto-shredded); AI employees using it stop and say so.
  app.post<{ Params: { id: string } }>('/api/v0/ai/connections/:id/disconnect', req => tx(req, async (c, v) => {
    leaders(v);
    const row = await connRow(c, req.params.id);
    await c.query(`update pulse.ai_connection set removed_at=now(),secret_wrapped='\\x'::bytea,secret_sealed='\\x'::bytea,state='error',state_detail='Disconnected' where id=$1`, [row.id]);
    await audit(c, 'ai.disconnect', 'ai_connection', row.id);
    return { ok: true };
  }));

  // ---- Workspaces ----
  app.post<{ Body: Body }>('/api/v0/ai/workspaces', { schema: { body: { type: 'object' } } }, async (req, reply) => reply.header('cache-control', 'no-store').send(await tx(req, async (c, v) => {
    leaders(v);
    const b = req.body, host = str(b.host, 254).toLowerCase(), username = str(b.username, 33), port = b.port === undefined || b.port === '' ? 22 : Number(b.port);
    if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(host) && isIP(host) !== 4) fail(400, 'Give the server\'s address: a host name like vps.example.com or an IP address');
    if (!/^[a-z_][a-z0-9_.-]{0,31}$/.test(username)) fail(400, 'Give the user Pulse signs in as on the server, e.g. pulse or ubuntu');
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(400, 'Give the SSH port (usually 22)');
    await publicHost(host, 'The server');
    const pasted = b.keyMode === 'paste';
    const pair = pasted ? { privateKey: String(b.privateKey ?? '').trim() + '\n', publicKey: '' } : await keygen();
    if (pasted) pair.publicKey = await publicOf(pair.privateKey);
    const id = randomUUID(), s = await sealText(v.org, 'workspace', id, pair.privateKey);
    pair.privateKey = '';
    await c.query(`insert into pulse.ai_workspace(org_id,id,name,host,port,username,key_source,public_key,key_id,key_wrapped,key_sealed,created_by)
      values (pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, nameOf(b.name, host), host, port, username, pasted ? 'pasted' : 'generated', pair.publicKey, s.keyId, s.dataKey, s.data, v.person]);
    await audit(c, 'ai.workspace_add', 'ai_workspace', id);
    return { workspace: (await c.query(`${WORKSPACES} and w.id=$1`, [id])).rows[0] };
  })));
  app.post<{ Params: { id: string } }>('/api/v0/ai/workspaces/:id/verify', req => tx(req, async (c, v) => {
    leaders(v);
    if (req.params.id === 'cloud') return { workspace: { id: 'cloud', name: 'Pulse cloud workspace', builtin: true, host: hostname(), ...(await checkCloud()) } };
    const w = await workspaceFor(c, v.org, uuid(req.params.id, 'workspace'));
    let state = 'ok', error: string | null = null, facts: Facts | null = null, hostKey: string | null = w!.row.host_key;
    try {
      const r = await sshRun({ host: w!.row.host, port: w!.row.port, username: w!.row.username, hostKey: w!.row.host_key }, w!.key, CHECK, '', 30000);
      if (r.code !== 0) {
        state = 'error';
        error = /Permission denied/i.test(r.err) ? 'The server refused Pulse\'s key. Add the public key below to ~/.ssh/authorized_keys of that user, then check again.'
          : /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(r.err) ? 'The server presented a different host key than the one Pulse pinned. If you rebuilt the server, remove this workspace and add it again.'
          : /timed out|Connection refused|No route|Could not resolve/i.test(r.err) ? `Pulse could not reach ${w!.row.host}:${w!.row.port} (${scrub(r.err).slice(0, 120)})`
          : `The check failed: ${scrub(r.err).slice(0, 200) || `exit ${r.code}`}`;
      } else { facts = factsOf(r.out); hostKey = hostKey ?? r.hostKey; }
    } catch (e) { state = 'error'; error = scrub((e as Error).message); }
    await c.query('update pulse.ai_workspace set state=$2,error=$3,facts=coalesce($4,facts),host_key=$5,checked_at=now() where id=$1', [w!.row.id, state, error, facts ? JSON.stringify(facts) : null, hostKey]);
    await audit(c, 'ai.workspace_verify', 'ai_workspace', w!.row.id);
    return { workspace: (await c.query(`${WORKSPACES} and w.id=$1`, [w!.row.id])).rows[0] };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/ai/workspaces/:id/remove', req => tx(req, async (c, v) => {
    leaders(v);
    const id = uuid(req.params.id, 'workspace');
    if ((await c.query("update pulse.ai_workspace set removed_at=now(),key_wrapped='\\x'::bytea,key_sealed='\\x'::bytea where id=$1 and removed_at is null", [id])).rowCount !== 1) fail(404, 'That workspace is not here any more');
    await c.query('update pulse.ai_connection set workspace_id=null where workspace_id=$1', [id]);
    await audit(c, 'ai.workspace_remove', 'ai_workspace', id);
    return { ok: true };
  }));
}
const toHttp = (e: unknown) => {
  if (e instanceof ProviderError) return exposed(e.kind === 'error' ? 502 : 400, e.message);
  return e;
};
/** A refusal people can read, also for a 5xx (the API's error handler passes on an exposed sentence). */
function exposed(status: number, message: string) { const err = new Error(message) as Error & { statusCode: number; expose: boolean }; err.statusCode = status; err.expose = true; return err; }

// ---- The AI employee's runtime (agents.ts, with its own key, inside one of its live runs) ----
/** What its run should call: its connection, opened (the secret goes only to the runtime on this server, in memory),
 *  and its workspace's address and key; or 'server' (this server's own sign-in), 'cap' (monthly cap used) or 'missing'. */
export async function agentConnection(c: PoolClient, runId: string, connectionId: string | null = null) {
  // FEATURES-1024: a fallback engine may be another of the organisation's connections (agent_run_connection_pick, 0988).
  const d = (connectionId ? await c.query('select pulse.agent_run_connection_pick($1,$2) d', [runId, connectionId]) : await c.query('select pulse.agent_run_connection($1) d', [runId])).rows[0].d as { status: string; connection?: Record<string, string>; workspace?: Record<string, string> | null; until?: string; used?: number; cap?: number };
  const org = (await c.query('select pulse.current_org()::text o')).rows[0].o as string;
  const out: Record<string, unknown> = { status: d.status, until: d.until ?? null, used: d.used ?? null, cap: d.cap ?? null };
  if (d.connection) {
    const k = d.connection;
    out.connection = { id: k.id, kind: k.kind, provider: k.provider, model: k.model ?? null,
      style: k.kind === 'api' && isApiProvider(k.provider) ? API_PROVIDERS[k.provider].style : null,
      baseUrl: k.kind === 'api' && isApiProvider(k.provider) ? k.baseUrl ?? API_PROVIDERS[k.provider].base : null,
      secret: await openText(org, 'connection', k.id, k.keyId, Buffer.from(k.wrapped, 'base64'), Buffer.from(k.sealed, 'base64')) };
  }
  if (d.workspace) {
    const w = d.workspace;
    out.workspace = { host: w.host, port: Number(w.port), username: w.username, hostKey: w.hostKey ?? null,
      privateKey: await openText(org, 'workspace', w.id, w.keyId, Buffer.from(w.keyWrapped, 'base64'), Buffer.from(w.keySealed, 'base64')) };
  }
  return out;
}
/** How the connection did in its run; a refreshed sign-in (Codex) is sealed again. */
export async function agentConnectionReport(c: PoolClient, runId: string, b: Body) {
  const state = ['connected', 'out_of_quota', 'expired', 'error'].includes(String(b.state)) ? String(b.state) : fail(400, 'Report a known state');
  const until = b.until ? new Date(String(b.until)) : null;
  let s: { keyId: string; dataKey: Buffer; data: Buffer } | null = null;
  if (typeof b.secret === 'string' && b.secret.length > 10 && b.secret.length < 20000) {
    const id = (await c.query('select connection_id::text id from pulse.agent_run where id=$1', [runId])).rows[0]?.id as string | undefined;
    const org = (await c.query('select pulse.current_org()::text o')).rows[0].o as string;
    if (id) s = await sealText(org, 'connection', id, b.secret);
  }
  await c.query('select pulse.agent_connection_report($1,$2,$3,$4,$5,$6,$7)', [runId, state, str(b.detail, 300) || null, until && Number.isFinite(until.getTime()) ? until.toISOString() : null, s?.keyId ?? null, s?.dataKey ?? null, s?.data ?? null]);
  return { ok: true };
}
