#!/usr/bin/env node
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
const fail = (message, code = 4) => { throw Object.assign(Error(message), { code }); };
const args = process.argv.slice(2), params = new Map(), sets = new Map(), options = {}, words = [];
const secrets = [process.env.PULSE_API_KEY, process.env.PULSE_PERSON_TOKEN].filter(Boolean);
const safe = value => {
  let text = String(value);
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text.replace(/(?:psvc_|pak_|pcat_|pat_|prt_|pcs_|poc_)[A-Za-z0-9_-]+/g, '[redacted]').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
};
const output = value => process.stdout.write(safe(JSON.stringify(value, null, 2)) + '\n');
const configDir = () => {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && !isAbsolute(xdg)) fail('XDG_CONFIG_HOME must be absolute');
  return join(xdg || join(homedir(), '.config'), 'pulse');
};
const keyFile = () => join(configDir(), 'auth.json');
async function stored() {
  try { return JSON.parse(await readFile(keyFile(), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; fail('Cannot read Pulse auth configuration'); }
}
async function hidden() {
  const input = process.stdin;
  if (!input.isTTY || !process.stderr.isTTY) fail('Login needs an interactive terminal; scripts use PULSE_API_KEY');
  return new Promise((resolve, reject) => {
    let value = ''; const raw = input.isRaw;
    const finish = (error) => {
      input.removeListener('data', onData); process.removeListener('SIGTERM', stopped);
      input.setRawMode(raw); input.pause(); process.stderr.write('\n');
      if (error) reject(Object.assign(Error('Login cancelled'), { code: 2 })); else resolve(value);
    };
    const stopped = () => finish(true);
    const onData = bytes => {
      for (const char of bytes.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish(false);
        if (char === '\x03' || char === '\x04') return finish(true);
        if (char === '\x7f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && char <= '~' && value.length < 512) value += char;
      }
    };
    input.setRawMode(true); process.stderr.write('API key: '); input.on('data', onData); process.once('SIGTERM', stopped); input.resume();
  });
}
async function save(value) {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const temporary = keyFile() + '.' + randomUUID();
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); } finally { await handle.close(); }
    await rename(temporary, keyFile());
  } finally { await unlink(temporary).catch(() => {}); }
}
// EST-2811: `auth connect` signs in with your own Pulse account in the browser (OAuth 2.1 + PKCE on a loopback
// address, like `gh auth login`); the CLI then acts as you, with your roles, and refreshes its 1-hour token itself.
const b64 = bytes => Buffer.from(bytes).toString('base64url');
async function oauthPost(base, path, body) {
  const response = await fetch(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) fail(`Sign-in refused: ${safe(data.error_description ?? data.error ?? response.status)}`, response.status === 401 ? 2 : 4);
  return data;
}
async function connect(base) {
  const verifier = b64(randomBytes(32)), state = b64(randomBytes(16)), challenge = createHash('sha256').update(verifier).digest('base64url');
  let finish; const done = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' }).end(ok ? 'Pulse CLI is signed in. You can close this tab.' : 'Sign-in was cancelled or did not match. Run pulse auth connect again.');
    if (ok) finish.resolve(url.searchParams.get('code')); else finish.reject(Object.assign(Error('Sign-in cancelled'), { code: 2 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  try {
    const client = await oauthPost(base, '/oauth/register', { client_name: 'Pulse CLI', redirect_uris: [redirect], token_endpoint_auth_method: 'none' });
    const url = new URL('/oauth/authorize', base);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state }))
      url.searchParams.set(k, v);
    process.stderr.write(`Opening your browser to sign in to Pulse. If it does not open, visit:\n${url.href}\n`);
    const opener = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url.href]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url.href]];
    try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* the printed link still works */ }
    const timer = setTimeout(() => finish.reject(Object.assign(Error('Sign-in timed out after 5 minutes'), { code: 2 })), 300_000);
    const code = await done.finally(() => clearTimeout(timer));
    const token = await oauthPost(base, '/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, client_id: client.client_id });
    await save({ url: base.origin, oauth: { clientId: client.client_id, access: token.access_token, refresh: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000, scope: token.scope } });
    output({ saved: true, scope: token.scope });
  } finally { server.close(); }
}
async function personToken(saved) {
  const o = saved.oauth;
  if (o.expiresAt - 60_000 > Date.now()) return o.access;
  const token = await oauthPost(new URL(saved.url), '/oauth/token', { grant_type: 'refresh_token', refresh_token: o.refresh, client_id: o.clientId });
  await save({ ...saved, oauth: { ...o, access: token.access_token, refresh: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 } });
  return token.access_token;
}
async function login(base) {
  const key = await hidden(); secrets.push(key);
  if (!/^(?:psvc_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}|pak_[0-9a-f]{8}_[0-9a-f]{64})$/.test(key)) fail('Malformed API key');
  await save({ url: base.origin, key });
  output({ saved: true });
}
function baseURL(value) {
  let url; try { url = new URL(value); } catch { fail('Set --url or PULSE_URL to your company address'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    fail('Use an HTTPS company origin (HTTP is allowed on loopback only)');
  return url;
}
const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
function operations(doc) {
  if (doc.openapi !== '3.1.0' || !doc.paths) fail('OpenAPI 3.1 reference unavailable');
  return Object.entries(doc.paths).flatMap(([path, item]) => {
    // A reference never selects another host, authentication realm or privileged route.
    if (!/^\/api\/v1\/(tasks|projects|people|chats|docs|billing|workflows|companies|search|events|service|catalog)(\/|$)/.test(path) ||
        !path.split('/').slice(1).every(p => /^[A-Za-z0-9_{}-]+$/.test(p) && !['operator', 'auth'].includes(p))) return [];
    return Object.entries(item).filter(([m]) => methods.includes(m)).map(([method, op]) => ({ ...op, path, method,
      parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])],
      operationId: op.operationId || method + path.replace('/api/v1/', '/').split(/[\/{}-]+/).filter(Boolean).map(s => s[0].toUpperCase() + s.slice(1)).join('') }));
  });
}
async function main() {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    if (arg === '--all') { options.all = true; continue; }
    if (!['--url', '--param', '--set', '--data', '--idempotency-key'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) fail('Unknown option or missing option value');
    const value = args[++i];
    if (arg === '--param') {
      if (value.split('=')[0].toLowerCase() === 'pulse-person-token') fail('Use PULSE_PERSON_TOKEN; never pass person credentials as arguments');
      const at = value.indexOf('='); if (at < 1 || params.has(value.slice(0, at))) fail('Use unique --param name=value pairs');
      params.set(value.slice(0, at), value.slice(at + 1));
    } else if (arg === '--set') {
      // EST-2811: a write's JSON body field by field; [..], {..}, true, false, null and numbers are read as JSON.
      const at = value.indexOf('='); if (at < 1 || sets.has(value.slice(0, at))) fail('Use unique --set name=value pairs');
      const raw = value.slice(at + 1);
      let parsed = raw;
      if (/^(\[|\{|true$|false$|null$|-?\d+(\.\d+)?$)/.test(raw)) { try { parsed = JSON.parse(raw); } catch { fail('A --set value that looks like JSON must be valid JSON'); } }
      sets.set(value.slice(0, at), parsed);
    } else options[arg.slice(2)] = value;
  }
  if (!words.length || words[0] === 'help') return process.stdout.write('pulse [--url https://company.example] ops | auth connect | auth login | auth status | auth logout\n'
    + 'pulse <operationId> [--param name=value] [--set field=value] [--data @file.json] [--all] [--idempotency-key value]\n'
    + '  auth connect   sign in with your Pulse account in the browser (acts as you, with your roles)\n'
    + '  auth login     paste an API key instead (scripts: set PULSE_API_KEY)\n');
  const saved = await stored();
  if (words.join(' ') === 'auth logout') { await save({}); return output({ signedOut: true }); }
  const base = baseURL(options.url || process.env.PULSE_URL || saved.url);
  if (words.join(' ') === 'auth connect') return connect(base);
  if (!process.env.PULSE_API_KEY && saved.oauth && words[0] !== 'auth' && base.origin !== saved.url) fail('Saved sign-in belongs to another company address; run auth connect here', 2);
  const key = process.env.PULSE_API_KEY || (saved.oauth && words[0] !== 'auth' ? await personToken(saved) : saved.key);
  if (key) secrets.push(key, key.replace(/^psvc_[0-9a-f-]{36}_|^pak_[0-9a-f]{8}_/, ''));
  if (words.join(' ') === 'auth login') return login(base);
  if (key && !process.env.PULSE_API_KEY && base.origin !== saved.url) fail('Saved key belongs to another company address; login here or set PULSE_API_KEY explicitly', 2);
  if (words.join(' ') === 'auth status') {
    if (saved.oauth && !process.env.PULSE_API_KEY) return output({ url: base.origin, signedIn: 'oauth', scopes: saved.oauth.scope?.split(' ') ?? null,
      note: 'Signed in as yourself with auth connect; run whoAmI to see who and your roles.' });
    if (!key) fail('No API key; run auth login or set PULSE_API_KEY', 2);
    return output({ url: base.origin, keyId: /^(?:psvc_([0-9a-f-]{36})_|pak_([0-9a-f]{8})_)/.exec(key)?.slice(1).find(Boolean) ?? 'unknown',
      scopes: null, note: 'Scopes and validity are not available locally; manage this key in Settings → Integrations.' });
  }
  if (words.length !== 1) fail('Choose one operation from ops');
  const request = async (url, init = {}) => {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length; if (bytes > 4 * 1024 * 1024) fail('Response exceeds 4 MiB; narrow filters or page explicitly', 1);
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) {
      let problem; try { problem = JSON.parse(body); } catch { /* Never print proxy HTML or response headers. */ }
      fail(`HTTP ${response.status}: ${safe(problem?.detail ?? problem?.error ?? 'Request refused')}`,
        response.status === 401 ? 2 : response.status === 403 ? 3 : response.status === 429 ? 5 : response.status < 500 ? 4 : 1);
    }
    try { return JSON.parse(body); } catch { fail('Server did not return JSON', 1); }
  };
  const doc = await request(new URL('/api/v1/openapi.json', base)), ops = operations(doc);
  if (new Set(ops.map(op => op.operationId)).size !== ops.length) fail('OpenAPI has duplicate operation ids');
  if (words[0] === 'ops') return output(ops.map(({ operationId, method, path, summary, security }) => ({ operationId, method, path, summary, scopes: security })));
  const op = ops.find(o => o.operationId === words[0]);
  if (!op) fail('Unknown operation; choose an id from ops');
  if (!key) fail('No API key; run auth login or set PULSE_API_KEY', 2);
  const headers = { Authorization: `Bearer ${key}` }, query = new URLSearchParams();
  const path = op.path.replace(/\{(\w+)\}/g, (_, name) => {
    const value = params.get(name); params.delete(name);
    if (!value || !/^[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)?$/.test(value)) fail('Provide a plain path identifier with --param');
    return value;
  });
  for (const [name, value] of params) {
    const parameter = op.parameters.find(p => p.name === name && p.in !== 'path');
    if (!parameter) fail('Unknown parameter; consult the served OpenAPI');
    if (parameter.in === 'query') query.set(name, value);
    else fail('Use --idempotency-key for the write header');
  }
  for (const p of op.parameters) if (p.in === 'header' && p.name.toLowerCase() === 'pulse-person-token' && process.env.PULSE_PERSON_TOKEN) headers[p.name] = process.env.PULSE_PERSON_TOKEN;
  for (const p of op.parameters) if (p.required && p.in === 'header' && p.name.toLowerCase() !== 'idempotency-key' && !headers[p.name]) fail('Missing required operation header');
  const write = !['get', 'head', 'options'].includes(op.method);
  if (options.all && (write || !op.parameters.some(p => p.in === 'query' && p.name === 'cursor'))) fail('--all requires a cursor list operation');
  if (write && !options['idempotency-key'] && op.parameters.some(p => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key' && p.schema?.pattern)) fail('This operation requires its documented --idempotency-key format');
  if (write) headers['Idempotency-Key'] = options['idempotency-key'] || randomUUID();
  let body;
  if (sets.size) {
    if (!write || options.data) fail('Use --set on a write, without --data');
    body = JSON.stringify(Object.fromEntries(sets)); headers['Content-Type'] = 'application/json';
  } else if (options.data) {
    if (!write || !options.data.startsWith('@')) fail('Use --data @file.json for a write');
    try { body = JSON.stringify(JSON.parse(await readFile(options.data.slice(1), 'utf8'))); } catch { fail('Cannot read JSON data file'); }
    headers['Content-Type'] = 'application/json';
  }
  const pages = [], seen = new Set();
  for (let page = 0; page < 100; page++) {
    const url = new URL(path, base); url.search = query.toString();
    const result = await request(url, { method: op.method.toUpperCase(), headers, ...(body === undefined ? {} : { body }) });
    if (!options.all) return output(result);
    if (!Array.isArray(result.items)) fail('Cursor response has no items', 1);
    pages.push(...result.items);
    if (result.nextCursor === null) return output({ items: pages, nextCursor: null });
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor)) fail('Invalid or repeated cursor; no partial result printed', 1);
    seen.add(result.nextCursor); query.set('cursor', result.nextCursor);
  }
  fail('Page cap reached (100); narrow filters or page explicitly; no partial result printed', 1);
}
main().catch(error => { process.stderr.write(safe(error.code >= 1 && error.code <= 5 ? error.message : 'Pulse request failed') + '\n'); process.exitCode = error.code >= 1 && error.code <= 5 ? error.code : 1; });
