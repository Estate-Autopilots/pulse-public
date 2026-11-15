// Test-only provider + disposable stack. Nothing here is imported by production.
import { createServer, request } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import * as oidc from 'openid-client';

export const identities = Object.fromEntries(['admin', 'linked', 'unlinked', 'disabled', 'other-org', 'wrong-domain', 'unverified'].map(name =>
 [name, { sub: `synthetic-${name}`, email: `${name}@example.test`, email_verified: name !== 'unverified', hd: name === 'wrong-domain' ? 'wrong.test' : 'example.test' }]));
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); });
export async function startGoogle({ canonical = false, origin } = {}) {
 const key = generateKeyPairSync('rsa', { modulusLength: 2048 }), forged = generateKeyPairSync('rsa', { modulusLength: 2048 }), codes = new Map();
 const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
 let selected = 'linked', session = false;
 const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/jwks') return json(200, { keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'RS256', use: 'sig' }] });
  let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16384) return json(413, { error: 'too_large' }); }
  if (url.pathname === '/session' && req.method === 'POST') {
   let value; try { value = JSON.parse(body); } catch { return json(400, { error: 'invalid_json' }); }
   if (!Object.hasOwn(identities, value?.identity) || typeof value.session !== 'boolean') return json(400, { error: 'invalid_selection' });
   selected = value.identity; session = value.session; return json(200, { identity: selected, session });
  }
  if (url.pathname === '/auth') {
   const q = url.searchParams, redirect = q.get('redirect_uri');
   if (!origin || redirect !== origin + '/api/v0/auth/google/callback' || q.get('client_id') !== 'synthetic-client' || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state') || !q.get('nonce')) return json(400, { error: 'invalid_request' });
   const back = new URL(redirect); back.searchParams.set('state', q.get('state'));
   if (q.get('prompt') === 'none' && !session) back.searchParams.set('error', 'login_required');
   else {
    session = true; const code = randomBytes(24).toString('base64url'), now = Math.floor(Date.now() / 1000);
    if (codes.size >= 1000) codes.delete(codes.keys().next().value);
    codes.set(code, { challenge: q.get('code_challenge'), redirect, claims: { iss: 'https://accounts.google.com', aud: 'synthetic-client', iat: now, exp: now + 300, auth_time: now, nonce: q.get('nonce'), ...identities[selected] } });
    back.searchParams.set('code', code);
   }
   res.writeHead(302, { location: back.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); return res.end();
  }
  if (url.pathname !== '/token' || req.method !== 'POST') return json(404, { error: 'not_found' });
  const form = new URLSearchParams(body), grant = codes.get(form.get('code')); codes.delete(form.get('code'));
  if (!grant || (grant.redirect && (form.get('redirect_uri') !== grant.redirect || form.get('grant_type') !== 'authorization_code')) || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) return json(400, { error: 'invalid_grant' });
  const signed = b64({ alg: 'RS256', kid: 'synthetic', typ: 'JWT' }) + '.' + b64(grant.claims);
  return json(200, { access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 300, id_token: signed + '.' + sign('sha256', Buffer.from(signed), (grant.claims.forged ? forged : key).privateKey).toString('base64url') });
 });
 const at = await listen(server);
 const config = new oidc.Configuration({ issuer: 'https://accounts.google.com', authorization_endpoint: canonical ? 'https://accounts.google.com/o/oauth2/v2/auth' : at + '/auth', token_endpoint: at + '/token', jwks_uri: at + '/jwks', id_token_signing_alg_values_supported: ['RS256'] }, 'synthetic-client', { client_secret: 'synthetic-secret', [oidc.clockTolerance]: 60 });
 oidc.allowInsecureRequests(config);
 return { at, config, codes, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
// Playwright does not route a redirected request independently of the initial navigation. Fetch the real
// start response, keep its cookies and replace only its canonical Google Location at the test boundary.
// Fail closed on real Google network traffic; callbacks still traverse the real Next proxy and cookie rules.
export async function routeGoogle(context, googleOrigin) {
 await context.route('https://accounts.google.com/**', route => route.abort());
 await context.route(url => url.pathname === '/api/v0/auth/google/start', async route => {
  const response = await route.fetch({ maxRedirects: 0 }), headers = response.headers();
  if (headers.location?.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')) headers.location = googleOrigin + '/auth' + new URL(headers.location).search;
  await route.fulfill({ response, headers });
 });
}

async function stack() {
 const scratch = process.env.PULSE_HARNESS_SCRATCH;
 if (!scratch || !process.env.PULSE_HARNESS_DB?.includes('/pulse_ci?')) throw new Error('Run tools/google-acceptance.sh');
 const admin = new Pool({ connectionString: process.env.PULSE_HARNESS_DB, max: 1 });
 const pool = new Pool({ connectionString: process.env.PULSE_HARNESS_DB.replace('postgresql://postgres@/', 'postgresql://pulse_api_login@/'), max: 2 });
 const credentialsFile = scratch + '/credentials.json', manifest = { sha: process.env.PULSE_HARNESS_SHA, credentialsFile, orgs: { a: randomUUID(), b: randomUUID() }, people: {}, links: {} };
 const password = randomBytes(24).toString('base64url') + 'Aa1!', totpHex = randomBytes(20).toString('hex');
 const c = await admin.connect();
 try {
  await c.query('begin');
  for (const [name, org] of Object.entries(manifest.orgs)) {
   await c.query("insert into pulse.org(id,slug,name,code) values($1,$2,$3,$4)", [org, 'synthetic-' + name, 'Synthetic Google ' + name, name === 'a' ? 'SYNA' : 'SYNB']);
   await c.query("select set_config('pulse.org_id',$1,true)", [org]);
   await c.query("insert into pulse_priv.google_settings(org_id,enabled,allowed_domains) values($1,true,array['example.test'])", [org]);
  }
  await c.query("insert into pulse.install(org_id,initialised_by) values($1,'test:google-harness')", [manifest.orgs.a]);
  for (const name of ['admin', 'linked', 'unlinked', 'disabled', 'other-org']) {
   const id = randomUUID(), org = name === 'other-org' ? manifest.orgs.b : manifest.orgs.a, username = 'harness.' + name;
   manifest.people[name] = { id, org, username, ...identities[name] };
   await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [org, id]);
   await c.query("insert into pulse.person(id,org_id,display_name,side) values($1,$2,$3,'staff')", [id, org, 'Synthetic ' + name]);
   await c.query("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values($1,$2,'admin','2020-01-01')", [org, id]);
   await c.query("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values($1,$2,'Synthetic QA',$3,$4,'{}')", [org, id, username, identities[name].email]);
   await c.query('select pulse.login_issue($1,$2)', [id, password]);
   if (name !== 'unlinked') await c.query("insert into pulse_priv.google_identity(org_id,person_id,issuer,subject,email,domain) values($1,$2,'https://accounts.google.com',$3,$4,'example.test')", [org, id, identities[name].sub, identities[name].email]);
  }
  await c.query("update pulse.login_credential set must_change=false,status=case when person_id=$1 then 'disabled' else 'active' end", [manifest.people.disabled.id]);
  await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [manifest.orgs.a, manifest.people.admin.id]);
  await c.query('insert into pulse_priv.auth_key values($1,gen_random_bytes(32))', [manifest.orgs.a]);
  await c.query("insert into pulse_priv.auth_account(org_id,realm,actor,totp) select $1,'staff',$2,pgp_sym_encrypt_bytea(decode($3,'hex'),encode(key,'hex')) from pulse_priv.auth_key where org_id=$1", [manifest.orgs.a, manifest.people.admin.id, totpHex]);
  const client = (await c.query("insert into pulse.client(org_id,display_name) values($1,'Synthetic Google client') returning id", [manifest.orgs.a])).rows[0].id;
  const task = (await c.query("insert into pulse.task(org_id,title,owner_id,assignee_person_id) values($1,'Synthetic Google task',$2,$2) returning id", [manifest.orgs.a, manifest.people.unlinked.id])).rows[0].id;
  manifest.links = { client: '/clients/' + client, task: '/tasks/' + task };
  for (const [name, type] of [['document', 'invoice'], ['quote', 'quotation']]) {
   const id = (await c.query('insert into pulse.erp_document(org_id,doc_type,client_id,created_by) values($1,$2,$3,$4) returning id', [manifest.orgs.a, type, client, manifest.people.admin.id])).rows[0].id;
   manifest.links[name] = '/erp/documents/' + id;
  }
  await c.query('commit');
 } finally { c.release(); await admin.end(); }
 writeFileSync(credentialsFile, JSON.stringify({ password, adminTotpHex: totpHex }), { mode: 0o600 });
 const front = httpsServer({ key: readFileSync(scratch + '/key.pem'), cert: readFileSync(scratch + '/cert.pem') });
 manifest.origin = (await listen(front)).replace('http:', 'https:');
 const google = await startGoogle({ canonical: true, origin: manifest.origin }); manifest.googleOrigin = google.at;
 Object.assign(process.env, { PULSE_PUBLIC_URL: manifest.origin, PULSE_GOOGLE_CLIENT_ID: 'synthetic-client', PULSE_GOOGLE_CLIENT_SECRET_FILE: '/synthetic-unread' });
 const { createApp } = await import('../dist/app.js');
 const app = createApp(pool, pool, undefined, undefined, async () => google.config);
 await app.listen({ host: '127.0.0.1', port: 0 }); manifest.apiOrigin = `http://127.0.0.1:${app.server.address().port}`;
 // Let Next select an ephemeral loopback port; its startup output supplies the chosen port.
 const web = spawn(process.execPath, ['./node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '0'], { cwd: 'apps/web', env: { ...process.env, PULSE_API_URL: manifest.apiOrigin }, stdio: ['ignore', 'pipe', 'inherit'] });
 process.once('exit', () => web.kill('SIGTERM'));
 let closing = false;
 const close = async () => { if (closing) return; closing = true; web.kill('SIGTERM'); front.closeAllConnections(); await Promise.all([new Promise(r => front.close(r)), app.close(), google.close()]); await pool.end(); };
 process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
 web.once('exit', () => { if (!closing) { void close(); process.exitCode = 1; } });
 let output = '';
 const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Next startup timed out')), 60000); web.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } }); web.once('exit', () => { clearTimeout(timer); reject(new Error('Next exited before startup')); }); });
 front.on('request', (req, res) => { const upstream = request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: { ...req.headers, host: new URL(manifest.origin).host } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); }); upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream); });
 // Wait for the real web proxy to reach the configured synthetic API before publishing readiness.
 for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${port}/api/v0/auth/branding`, { headers: { host: new URL(manifest.origin).host } })).ok) { writeFileSync(scratch + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }); return; } } catch {}
  await new Promise(r => setTimeout(r, 500));
 }
 await close(); throw new Error('Web readiness timed out');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await stack();
