// Signing in. `pulse login` is "Sign in with Pulse" (OAuth 2.1, services/api/src/oauth.ts): the CLI registers itself
// (RFC 7591, a public client), opens Pulse's consent screen in your browser and listens once on 127.0.0.1 for the answer
// (PKCE S256, state, iss checked). It then acts as you, with your roles, and renews its 1-hour access token itself.
// Without a browser on this computer, --no-browser prints the link and takes the address your browser ends on.
// `--token` stores a token you already have (a personal token or an app key). PULSE_TOKEN overrides every stored one.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { CliError, EXIT, redact, secret, usage } from './errors.js';
import { call, refusal } from './http.js';
import { readStore, withStoreLock, writeStore, type Credential, type OAuthCredential } from './config.js';

export type Metadata = { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint: string; revocation_endpoint?: string };
const CLIENT_NAME = 'Pulse CLI';

/** The authorization server's endpoints (RFC 8414), only on the Pulse address itself; the documented paths otherwise. */
export async function discover(host: string): Promise<Metadata> {
  const fallback: Metadata = { issuer: host, authorization_endpoint: `${host}/oauth/mcp/authorize`, token_endpoint: `${host}/oauth/mcp/token`,
    registration_endpoint: `${host}/oauth/mcp/register`, revocation_endpoint: `${host}/oauth/mcp/revoke` };
  const reply = await call(`${host}/.well-known/oauth-authorization-server`);
  if (reply.status === 404) return fallback;
  if (reply.status !== 200 || !reply.body || typeof reply.body !== 'object') throw refusal(reply, 'Reading Pulse\'s sign-in settings');
  const m = reply.body as Partial<Metadata>;
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'] as const) {
    const value = m[key];
    if (value === undefined && key === 'revocation_endpoint') continue;
    if (typeof value !== 'string' || new URL(value).origin !== host)
      throw new CliError(`Pulse's sign-in settings point ${key} away from ${host}; refusing to sign in there`, EXIT.failed);
  }
  return { ...fallback, ...m, issuer: typeof m.issuer === 'string' ? m.issuer : host } as Metadata;
}

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

export function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try { spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).on('error', () => { /* the printed link still works */ }).unref(); }
  catch { /* the printed link still works */ }
}

type Answer = { code: string; state: string | null; iss: string | null };
/** What the consent screen sent back, from the callback request or the address pasted into --no-browser. */
export function readAnswer(address: string, expectedState: string, issuer: string): string {
  let url: URL;
  try { url = new URL(address.trim()); } catch { return usage('That is not the address from your browser; copy the whole address bar'); }
  const error = url.searchParams.get('error');
  if (error === 'access_denied') throw new CliError('Sign-in cancelled: you chose Cancel on Pulse\'s consent screen', EXIT.auth);
  if (error) throw new CliError(`Pulse refused the sign-in: ${redact(url.searchParams.get('error_description') ?? error)}`, EXIT.auth);
  const answer: Answer = { code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state'), iss: url.searchParams.get('iss') };
  if (!answer.code) usage('That address has no sign-in code; copy the whole address bar after you chose Allow');
  if (answer.state !== expectedState) throw new CliError('The sign-in answer does not belong to this pulse login (state differs); run pulse login again', EXIT.auth);
  const origin = (u: string) => { try { return new URL(u).origin; } catch { return u; } };
  if (answer.iss !== null && origin(answer.iss) !== origin(issuer)) throw new CliError(`The sign-in answer came from ${answer.iss}, not ${issuer}; refusing it`, EXIT.auth);
  return answer.code;
}

const page = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1d1d1f"><h1 style="font-size:22px">${title}</h1><p>${text}</p></body>`;

export type LoginOptions = { browser: boolean; scopes?: string; port?: number; timeoutMs?: number; log: (line: string) => void; opener?: (url: string) => void };

/** The browser sign-in. Returns the credential to store (not yet stored). */
export async function browserLogin(host: string, options: LoginOptions): Promise<OAuthCredential> {
  const meta = await discover(host);
  const { verifier, challenge } = pkce(), state = randomBytes(16).toString('base64url');
  let settle!: { resolve: (address: string) => void; reject: (e: Error) => void };
  const answered = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const denied = url.searchParams.get('error'), ok = !denied && url.searchParams.get('state') === state && !!url.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(ok ? page('Signed in to Pulse', 'The pulse command is signed in. You can close this tab.')
        : page('Not signed in', denied === 'access_denied' ? 'You chose Cancel. Run <code>pulse login</code> again to sign in.'
          : 'This answer did not match the sign-in the pulse command started. Run <code>pulse login</code> again.'));
    settle.resolve(`http://127.0.0.1${req.url}`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port, redirect = `http://127.0.0.1:${port}/callback`;
  let rl: ReturnType<typeof createInterface> | undefined;
  const timer = setTimeout(() => settle.reject(new CliError('Sign-in timed out after 5 minutes; run pulse login again', EXIT.auth)), options.timeoutMs ?? 300_000);
  try {
    const registered = await call(meta.registration_endpoint, { json: { client_name: CLIENT_NAME, redirect_uris: [redirect], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] } });
    if (registered.status !== 201 && registered.status !== 200) throw refusal(registered, 'Registering the CLI with Pulse');
    const clientId = String((registered.body as { client_id?: string }).client_id ?? '');
    if (!clientId) throw new CliError('Pulse did not return a client id', EXIT.failed);
    const authorize = new URL(meta.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge,
      code_challenge_method: 'S256', state, ...(options.scopes ? { scope: options.scopes } : {}) })) authorize.searchParams.set(k, v);
    if (options.browser) {
      options.log(`Opening your browser to sign in to ${host}. If it does not open, visit:\n\n  ${authorize.href}\n`);
      (options.opener ?? openBrowser)(authorize.href);
      options.log('Waiting for you to choose Allow in the browser (Ctrl+C to stop)...');
    } else {
      options.log(`Open this link in a browser where you can sign in to Pulse:\n\n  ${authorize.href}\n`);
      options.log('After you choose Allow, the browser goes to a 127.0.0.1 address. If that page does not load (another computer),');
      options.log('copy the whole address from the address bar and paste it here.');
      if (process.stdin.isTTY || process.env.PULSE_LOGIN_PASTE === '1') {
        rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
        process.stderr.write('Address: ');
        rl.once('line', line => settle.resolve(line));
      }
    }
    const code = readAnswer(await answered, state, meta.issuer);
    const reply = await call(meta.token_endpoint, { form: { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier } });
    if (reply.status !== 200) throw refusal(reply, 'Finishing the sign-in');
    return credentialFrom(reply.body, clientId, meta);
  } finally {
    clearTimeout(timer); rl?.close();
    server.closeAllConnections?.(); server.close();
  }
}

function credentialFrom(body: unknown, clientId: string, meta: Pick<Metadata, 'token_endpoint' | 'revocation_endpoint'>): OAuthCredential {
  const t = body as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!t?.access_token || !t.refresh_token) throw new CliError('Pulse answered the sign-in without tokens', EXIT.failed);
  secret(t.access_token); secret(t.refresh_token);
  return { kind: 'oauth', clientId, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    scope: t.scope ?? '', tokenEndpoint: meta.token_endpoint, revocationEndpoint: meta.revocation_endpoint, savedAt: new Date().toISOString() };
}

export type Session = { host: string; token: string; source: 'env' | 'oauth' | 'token'; refresh?: () => Promise<string> };

/** The bearer for `host`: PULSE_TOKEN, else the stored sign-in (renewed when it is within a minute of expiry). */
export async function session(host: string, env: NodeJS.ProcessEnv = process.env): Promise<Session> {
  if (env.PULSE_TOKEN) { secret(env.PULSE_TOKEN); return { host, token: env.PULSE_TOKEN.trim(), source: 'env' }; }
  const saved = readStore().hosts[host];
  if (!saved) throw new CliError(`Not signed in to ${host}`, EXIT.auth, `Run \`pulse login --host ${host}\` or set PULSE_TOKEN.`);
  if (saved.kind === 'token') { secret(saved.token); return { host, token: saved.token, source: 'token' }; }
  secret(saved.accessToken); secret(saved.refreshToken);
  const refresh = () => renew(host, true);
  if (saved.expiresAt - 60_000 > Date.now()) return { host, token: saved.accessToken, source: 'oauth', refresh };
  return { host, token: await renew(host, false), source: 'oauth', refresh };
}

/** Swap the refresh token for new tokens, under the lock; another pulse command may already have done it. */
async function renew(host: string, force: boolean): Promise<string> {
  return withStoreLock(async () => {
    const store = readStore(), saved = store.hosts[host];
    if (!saved || saved.kind !== 'oauth') throw new CliError(`Not signed in to ${host}`, EXIT.auth, 'Run `pulse login`.');
    if (!force && saved.expiresAt - 60_000 > Date.now()) return saved.accessToken;
    const reply = await call(saved.tokenEndpoint, { form: { grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: saved.clientId } });
    if (reply.status === 400 || reply.status === 401) {
      delete store.hosts[host]; writeStore(store);
      throw new CliError(`Your sign-in to ${host} has ended (expired, revoked or disconnected)`, EXIT.auth, 'Run `pulse login` again.');
    }
    if (reply.status !== 200) throw refusal(reply, 'Renewing your sign-in');
    const next = credentialFrom(reply.body, saved.clientId, { token_endpoint: saved.tokenEndpoint, revocation_endpoint: saved.revocationEndpoint });
    store.hosts[host] = { ...next, scope: next.scope || saved.scope };
    writeStore(store);
    return next.accessToken;
  });
}

export async function saveCredential(host: string, credential: Credential) {
  await withStoreLock(async () => { const store = readStore(); store.hosts[host] = credential; store.defaultHost = host; writeStore(store); });
}

/** Forget the sign-in for `host` and end it at Pulse (revoking the refresh token ends the app's connection). */
export async function logout(host: string): Promise<{ removed: boolean; revoked: boolean }> {
  return withStoreLock(async () => {
    const store = readStore(), saved = store.hosts[host];
    if (!saved) return { removed: false, revoked: false };
    let revoked = false;
    if (saved.kind === 'oauth' && saved.revocationEndpoint) {
      try {
        const reply = await call(saved.revocationEndpoint, { form: { token: saved.refreshToken, token_type_hint: 'refresh_token', client_id: saved.clientId } });
        revoked = reply.status === 200;
        await call(saved.revocationEndpoint, { form: { token: saved.accessToken, token_type_hint: 'access_token', client_id: saved.clientId } }).catch(() => undefined);
      } catch { /* offline: still forget it here */ }
    }
    delete store.hosts[host];
    if (store.defaultHost === host) delete store.defaultHost;
    writeStore(store);
    return { removed: true, revoked };
  });
}

/** A token typed at a hidden prompt (never echoed, never in shell history), or read from stdin when piped. */
export async function readTokenInput(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = input.isRaw;
    const finish = (error?: Error) => {
      input.removeListener('data', onData); input.setRawMode(wasRaw); input.pause(); process.stderr.write('\n');
      if (error) reject(error); else resolve(value.trim());
    };
    const onData = (bytes: Buffer) => {
      for (const ch of bytes.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\x03' || ch === '\x04') return finish(new CliError('Cancelled', EXIT.auth));
        if (ch === '\x7f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ' && value.length < 1024) value += ch;
      }
    };
    process.stderr.write('Paste your Pulse token (input is hidden): ');
    input.setRawMode(true); input.on('data', onData); input.resume();
  });
}
