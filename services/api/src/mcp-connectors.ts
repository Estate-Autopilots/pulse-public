// CONNECTORS-CONTRACTS (owner, 6 Nov 2026: "connectors like Claude's and ChatGPT's: any kind of application can be
// connected"; design docs/connectors/MCP-CONNECTORS.md, migration 1584). A company's admins connect remote MCP servers
// in Settings → Connectors: by address, signed in with OAuth 2.1 (the server's own metadata, RFC 9728 and 8414; Vitals OS
// registers itself there, RFC 7591; code + PKCE S256; the resource indicator, RFC 8707) or with a bearer token. Featured
// apps (Sales X-Ray first) fill the address in. Admins choose which tools are on, which writing tools may run without
// asking, and who may use them (people by role, AI employees by name). The company's people and AI employees then call
// those tools through Vitals OS: here (screens), and API v1 / MCP / the CLI (v1-connectors.ts).
//  * Every secret is sealed with the company's document keyring (document-keys.ts), bound to the company and connector,
//    and opened only inside a call; never returned, never logged.
//  * Every outbound call goes through safeFetch (https on 443, public addresses only, pinned after the lookup, no
//    redirects, size and time caps), like webhooks.
//  * Every tool call is audited (pulse.mcp_tool_call); every change to a connector is on the admins' ledger
//    (pulse.mcp_connector_event, written by the database).
//  * A tool that is not marked read-only by its server counts as writing: it needs confirm true unless an admin allowed
//    it to run on its own.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { DocumentKeyError, loadKeyring, open as unseal, seal, type Keyring } from './document-keys.js';
import { admin, fail, sessionHash, type Tx } from './routes.js';
import { OUTBOUND_WORDS, OutboundError, safeFetch, type SafeAnswer } from './safe-fetch.js';
import { salesXrayBase } from './sales-xray.js';
import { companyOrigin, normaliseHost } from './tenant-context.js';
import { publicOrigin } from './tenant-model.js';

type Row = Record<string, unknown>;
type Box = { k: string; w: string; d: string };
export type Fetcher = (url: string, init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs?: number }) => Promise<SafeAnswer>;
export type Tool = { name: string; title: string; description: string; inputSchema: Row; readOnly: boolean; destructive: boolean };
export const CALLBACK = '/settings/connectors/callback';
export const PROTOCOL = '2025-06-18';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOOL = /^[A-Za-z0-9_.:-]{1,128}$/;
export const connectorId = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(404, 'No such connector in this company');

/** A refusal written for people (the error handler passes `expose` messages on). */
export class ConnectorError extends Error {
  readonly expose = true;
  constructor(readonly statusCode: number, message: string, readonly reason = 'connector') { super(message); }
}
const outbound = (e: unknown) => e instanceof OutboundError ? new ConnectorError(502, OUTBOUND_WORDS[e.kind], e.kind) : e;

// ------------------------------------------------------------------------------------------------ featured apps
export type Featured = { key: string; name: string; publisher: string; summary: string; url: string | null; auth: 'oauth'; why: string | null };
/** Specially built apps, first in the list. Sales X-Ray's own MCP server (/v1/mcp; OAuth 2.1 with RFC 9728 metadata and
 *  dynamic registration) is set by the install (PULSE_SALES_XRAY_URL); docs/connectors/SALES-XRAY.md is its contract. */
export function featuredApps(env: NodeJS.ProcessEnv = process.env): Featured[] {
  const sx = salesXrayBase(env);
  const https = !!sx && sx.startsWith('https://');
  return [{ key: 'sales-xray', name: 'Sales X-Ray', publisher: 'Atlas Crest', auth: 'oauth',
    summary: 'Sales calls, their analysis and leads: list and read calls and leads, find duplicates, add leads, notes and tasks.',
    url: https ? `${sx}/v1/mcp` : null, why: https ? null : 'This install has no Sales X-Ray address yet. An admin of the install sets it; you can also add its address by hand.' }];
}

// ------------------------------------------------------------------------------------------------ sealing
const box = (s: { keyId: string; dataKey: Buffer; data: Buffer }): Box => ({ k: s.keyId, w: s.dataKey.toString('base64'), d: s.data.toString('base64') });
export type SecretKind = 'bearer' | 'client' | 'access' | 'refresh';
export const secretContext = (org: string, id: string, kind: SecretKind) => `${org}/connector/${id}/${kind}`;
async function keyring(): Promise<Keyring> {
  const state = await loadKeyring();
  if (!state.ok) throw new DocumentKeyError('Connectors can’t be signed in to yet: this server’s encryption key isn’t installed. Nothing was saved. Ask the Vitals OS administrator.', state.reason);
  return state.ring;
}
export const sealText = async (org: string, id: string, kind: SecretKind, plain: string) => box(seal(await keyring(), Buffer.from(plain, 'utf8'), secretContext(org, id, kind)));
export async function openText(org: string, id: string, kind: SecretKind, b: Box) {
  const plain = unseal(await keyring(), { keyId: b.k, dataKey: Buffer.from(b.w, 'base64'), data: Buffer.from(b.d, 'base64') }, secretContext(org, id, kind));
  try { return plain.toString('utf8'); } finally { plain.fill(0); }
}

// ------------------------------------------------------------------------------------------------ MCP over streamable HTTP
/** The JSON-RPC answer with this id, from a JSON body or a server-sent event stream. */
export function rpcAnswer(res: SafeAnswer, id: number): Row | null {
  const type = res.headers['content-type'] ?? '';
  const messages: unknown[] = [];
  if (type.startsWith('text/event-stream')) {
    for (const event of res.body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) try { messages.push(JSON.parse(data)); } catch { /* not JSON: skipped */ }
    }
  } else if (res.body.trim()) {
    try { const m = JSON.parse(res.body); messages.push(...(Array.isArray(m) ? m : [m])); } catch { return null; }
  }
  return (messages.find((m) => !!m && typeof m === 'object' && (m as Row).id === id) as Row | undefined) ?? null;
}

export type Session = { url: string; token: string | null; sessionId: string | null; protocol: string; next: number };
const headersFor = (s: Session, first = false): Record<string, string> => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  'User-Agent': 'VitalsOS-Connectors/1.0', ...(s.token ? { Authorization: `Bearer ${s.token}` } : {}), ...(s.sessionId ? { 'Mcp-Session-Id': s.sessionId } : {}),
  ...(first ? {} : { 'MCP-Protocol-Version': s.protocol }) });

async function rpc(f: Fetcher, s: Session, method: string, params: Row, first = false): Promise<Row> {
  const id = s.next++;
  let res: SafeAnswer;
  try { res = await f(s.url, { method: 'POST', headers: headersFor(s, first), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }); }
  catch (e) { throw outbound(e); }
  if (res.status === 401 || res.status === 403) throw new ConnectorError(409, 'The app no longer accepts this connection. An admin signs in to it again in Settings → Connectors.', 'needs_auth');
  if (res.status === 404 && s.sessionId) throw new ConnectorError(502, 'The app ended the session. Try again.', 'session');
  if (res.status >= 400) throw new ConnectorError(502, `The app refused the request (HTTP ${res.status}).`, 'http');
  if (first) s.sessionId = res.headers['mcp-session-id'] ?? null;
  const answer = rpcAnswer(res, id);
  if (!answer) throw new ConnectorError(502, 'The app did not answer as an MCP server does.', 'protocol');
  if (answer.error) throw new ConnectorError(502, `The app answered with an error: ${String((answer.error as Row).message ?? 'unknown').slice(0, 200)}`, 'rpc');
  return (answer.result ?? {}) as Row;
}

/** Open a session: initialize, then the initialized notification (stateless servers ignore the session id). */
export async function openSession(f: Fetcher, url: string, token: string | null): Promise<Session> {
  const s: Session = { url, token, sessionId: null, protocol: PROTOCOL, next: 1 };
  const init = await rpc(f, s, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'vitals-os', title: 'Vitals OS', version: '1.0.0' } }, true);
  if (typeof init.protocolVersion === 'string') s.protocol = init.protocolVersion;
  try { await f(url, { method: 'POST', headers: headersFor(s), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }); } catch { /* a notification needs no answer */ }
  return s;
}

/** A server's tool as Vitals OS keeps it: words capped, the input schema kept when small, read-only only when the server says so. */
export function toolOf(t: Row): Tool | null {
  const name = String(t.name ?? '');
  if (!TOOL.test(name)) return null;
  const a = (t.annotations ?? {}) as Row;
  const schema = t.inputSchema && typeof t.inputSchema === 'object' && JSON.stringify(t.inputSchema).length <= 16000 ? t.inputSchema as Row : { type: 'object' };
  return { name, title: String(t.title ?? a.title ?? name).slice(0, 120), description: String(t.description ?? '').slice(0, 1000), inputSchema: schema,
    readOnly: a.readOnlyHint === true, destructive: a.readOnlyHint !== true && a.destructiveHint !== false };
}

export async function listTools(f: Fetcher, url: string, token: string | null): Promise<Tool[]> {
  const s = await openSession(f, url, token);
  const out: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await rpc(f, s, 'tools/list', cursor ? { cursor } : {});
    for (const t of (Array.isArray(r.tools) ? r.tools : []) as Row[]) { const x = toolOf(t); if (x && !out.some((o) => o.name === x.name)) out.push(x); }
    cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
    if (!cursor || out.length >= 300) break;
  }
  return out.slice(0, 300);
}

export type CallResult = { isError: boolean; text: string };
/** One tool call; the answer as text (text parts joined, other parts named, structured content as JSON), capped at 100 KB. */
export async function callTool(f: Fetcher, url: string, token: string | null, name: string, args: Row): Promise<CallResult> {
  const s = await openSession(f, url, token);
  const r = await rpc(f, s, 'tools/call', { name, arguments: args });
  const parts = (Array.isArray(r.content) ? r.content : []) as Row[];
  const text = parts.map((p) => p.type === 'text' ? String(p.text ?? '') : p.type === 'resource' ? JSON.stringify(p.resource ?? {}) : `[${String(p.type ?? 'part')}]`).join('\n')
    || (r.structuredContent ? JSON.stringify(r.structuredContent) : '');
  return { isError: r.isError === true, text: text.slice(0, 100_000) };
}

// ------------------------------------------------------------------------------------------------ OAuth 2.1
type AuthServer = { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string | null; scopes: string[] };
const json = (res: SafeAnswer): Row | null => { try { const x = JSON.parse(res.body); return x && typeof x === 'object' ? x as Row : null; } catch { return null; } };
const httpsUrl = (x: unknown) => { try { const u = new URL(String(x)); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };

/** Where the MCP server says its authorization server is (RFC 9728), then that server's metadata (RFC 8414 / OIDC). */
export async function discover(f: Fetcher, mcpUrl: string): Promise<AuthServer> {
  const u = new URL(mcpUrl);
  const tries: string[] = [];
  try {
    const probe = await f(mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'vitals-os', version: '1.0.0' } } }) });
    const m = /resource_metadata="([^"]+)"/.exec(probe.headers['www-authenticate'] ?? '');
    if (m && httpsUrl(m[1])) tries.push(m[1]);
  } catch (e) { throw outbound(e); }
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  tries.push(`${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`);
  let servers: string[] = [], scopes: string[] = [];
  for (const t of [...new Set(tries)]) {
    try {
      const r = await f(t, { headers: { Accept: 'application/json' } });
      const meta = r.status === 200 ? json(r) : null;
      if (meta && Array.isArray(meta.authorization_servers) && meta.authorization_servers.length) {
        servers = (meta.authorization_servers as unknown[]).map(httpsUrl).filter((x): x is string => !!x);
        scopes = Array.isArray(meta.scopes_supported) ? (meta.scopes_supported as unknown[]).map(String).slice(0, 40) : [];
        break;
      }
    } catch { /* the next place */ }
  }
  const issuer = servers[0] ?? u.origin;
  const iu = new URL(issuer), ipath = iu.pathname === '/' ? '' : iu.pathname.replace(/\/$/, '');
  for (const t of [`${iu.origin}/.well-known/oauth-authorization-server${ipath}`, `${iu.origin}/.well-known/openid-configuration${ipath}`, `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`]) {
    try {
      const r = await f(t, { headers: { Accept: 'application/json' } });
      const meta = r.status === 200 ? json(r) : null;
      const authorizationEndpoint = httpsUrl(meta?.authorization_endpoint), tokenEndpoint = httpsUrl(meta?.token_endpoint);
      if (!meta || !authorizationEndpoint || !tokenEndpoint) continue;
      const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported as string[] : ['S256'];
      if (!methods.includes('S256')) throw new ConnectorError(400, 'This app’s sign-in does not support PKCE (S256), which Vitals OS requires.', 'pkce');
      return { issuer: String(meta.issuer ?? issuer), authorizationEndpoint, tokenEndpoint, registrationEndpoint: httpsUrl(meta.registration_endpoint),
        scopes: scopes.length ? scopes : Array.isArray(meta.scopes_supported) ? (meta.scopes_supported as unknown[]).map(String).slice(0, 40) : [] };
    } catch (e) { if (e instanceof ConnectorError) throw e; }
  }
  throw new ConnectorError(400, 'This app does not publish OAuth sign-in details. Use a token from the app instead.', 'no_oauth');
}

const form = (x: Record<string, string | undefined>) => new URLSearchParams(Object.entries(x).filter(([, v]) => v !== undefined) as [string, string][]).toString();
export const pkce = () => { const verifier = randomBytes(48).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };

/** Register Vitals OS at the app's authorization server (RFC 7591): a public client, PKCE only. */
export async function register(f: Fetcher, as: AuthServer, redirectUri: string): Promise<{ clientId: string; clientSecret: string | null }> {
  if (!as.registrationEndpoint) throw new ConnectorError(400, 'This app does not let apps register themselves. Use a token from the app instead.', 'no_registration');
  const r = await f(as.registrationEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_name: 'Vitals OS', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', client_uri: new URL(redirectUri).origin }) }).catch((e) => { throw outbound(e); });
  const out = json(r);
  if (r.status >= 300 || !out || typeof out.client_id !== 'string') throw new ConnectorError(502, 'The app refused to register Vitals OS for sign-in.', 'registration');
  return { clientId: out.client_id, clientSecret: typeof out.client_secret === 'string' ? out.client_secret : null };
}

async function tokenCall(f: Fetcher, endpoint: string, body: Record<string, string | undefined>, clientId: string, clientSecret: string | null) {
  const r = await f(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
    ...(clientSecret ? { Authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}` } : {}) },
    body: form({ ...body, client_id: clientId }) }).catch((e) => { throw outbound(e); });
  const t = json(r);
  if (r.status !== 200 || !t || typeof t.access_token !== 'string') return null;
  return { access: t.access_token, refresh: typeof t.refresh_token === 'string' ? t.refresh_token : null,
    expiresAt: new Date(Date.now() + Math.max(60, Math.min(Number(t.expires_in) || 3600, 30 * 86400)) * 1000).toISOString(),
    scopes: typeof t.scope === 'string' ? t.scope.split(' ').filter(Boolean) : null };
}

// ------------------------------------------------------------------------------------------------ the model
type Connector = { id: string; appKey: string | null; label: string; url: string; authKind: 'oauth' | 'bearer' | 'none'; status: string; tools: Tool[]; toolsAt: string | null;
  enabledTools: string[]; autoTools: string[]; peopleAccess: string; aiAccess: string; aiAgents: string[]; lastError: string | null; createdAt: string; updatedAt: string };
const SELECT = `select id,app_key "appKey",label,url,auth_kind "authKind",status,tools,tools_at "toolsAt",enabled_tools "enabledTools",auto_tools "autoTools",
  people_access "peopleAccess",ai_access "aiAccess",ai_agents "aiAgents",last_error "lastError",created_at "createdAt",updated_at "updatedAt" from pulse.mcp_connector`;
const iso = (x: unknown) => x === null || x === undefined ? null : new Date(x as string).toISOString();
const connectorOut = (r: Row): Connector => ({ ...(r as unknown as Connector), toolsAt: iso(r.toolsAt), createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!,
  tools: (r.tools as Tool[]) ?? [], aiAgents: ((r.aiAgents as string[]) ?? []).map(String) });

async function orgOf(c: PoolClient) { return String((await c.query('select pulse.current_org() o')).rows[0].o); }
export async function getConnector(c: PoolClient, id: string): Promise<Connector> {
  const r = (await c.query(`${SELECT} where id=$1 and status<>'removed'`, [connectorId(id)])).rows[0];
  return r ? connectorOut(r) : fail(404, 'No such connector in this company');
}
export async function listConnectors(c: PoolClient): Promise<Connector[]> {
  return (await c.query(`${SELECT} where status<>'removed' order by app_key is null, label`)).rows.map(connectorOut);
}

/** The token to call the server with: a bearer token, or the OAuth access token (refreshed when it is about to end). */
export async function accessToken(c: PoolClient, f: Fetcher, k: Connector): Promise<string | null> {
  if (k.authKind === 'none') return null;
  const org = await orgOf(c);
  let s = (await c.query('select pulse.mcp_connector_secret($1,$2) s', ['read', k.id])).rows[0].s as Row;
  if (k.authKind === 'bearer') return s.bearer ? openText(org, k.id, 'bearer', s.bearer as Box) : fail(409, 'This connector has no token yet. An admin adds it in Settings → Connectors.');
  if (!s.access) throw new ConnectorError(409, 'Nobody has signed in to this app yet. An admin signs in from Settings → Connectors.', 'needs_auth');
  if (Date.parse(String(s.accessExpiresAt)) - Date.now() > 60_000) return openText(org, k.id, 'access', s.access as Box);
  // About to end: refresh under the row's lock, so two calls never spend one refresh token twice.
  s = (await c.query('select pulse.mcp_connector_secret($1,$2) s', ['lock', k.id])).rows[0].s as Row;
  if (Date.parse(String(s.accessExpiresAt)) - Date.now() > 60_000) return openText(org, k.id, 'access', s.access as Box);
  const o = (s.oauth ?? {}) as Row;
  if (!s.refresh || !o.tokenEndpoint) throw new ConnectorError(409, 'The sign-in to this app ended. An admin signs in again in Settings → Connectors.', 'needs_auth');
  const secret = s.clientSecret ? await openText(org, k.id, 'client', s.clientSecret as Box) : null;
  const t = await tokenCall(f, String(o.tokenEndpoint), { grant_type: 'refresh_token', refresh_token: await openText(org, k.id, 'refresh', s.refresh as Box), resource: k.url }, String(o.clientId), secret);
  if (!t) throw new ConnectorError(409, 'The sign-in to this app ended. An admin signs in again in Settings → Connectors.', 'needs_auth');
  await c.query('select pulse.mcp_connector_secret($1,$2,$3)', ['tokens', k.id, JSON.stringify({ access: await sealText(org, k.id, 'access', t.access), accessExpiresAt: t.expiresAt,
    ...(t.refresh ? { refresh: await sealText(org, k.id, 'refresh', t.refresh) } : {}), ...(t.scopes ? { scopes: t.scopes } : {}) })]);
  return t.access;
}

/** Read the server's tools again (admins); new tools start switched off. */
export async function refreshTools(c: PoolClient, f: Fetcher, id: string): Promise<Connector> {
  const k = await getConnector(c, id);
  try {
    const tools = await listTools(f, k.url, await accessToken(c, f, k));
    const names = new Set(tools.map((t) => t.name));
    await c.query(`update pulse.mcp_connector set tools=$2,tools_at=now(),status='connected',last_error=null,enabled_tools=$3,auto_tools=$4 where id=$1`,
      [k.id, JSON.stringify(tools), k.enabledTools.filter((n) => names.has(n)), k.autoTools.filter((n) => names.has(n))]);
  } catch (e) {
    if (!(e instanceof ConnectorError)) throw e;
    await c.query(`update pulse.mcp_connector set status=$2,last_error=$3 where id=$1`, [k.id, e.reason === 'needs_auth' ? 'needs_auth' : 'error', e.message.slice(0, 300)]);
  }
  return getConnector(c, k.id);
}

const field = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';
/** Add a connector (admins). A token is sealed at once; OAuth waits for an admin's sign-in. Nothing is called for OAuth yet. */
export async function addConnector(c: PoolClient, f: Fetcher, b: Row, person: string): Promise<Connector> {
  const featured = b.appKey ? featuredApps().find((a) => a.key === b.appKey) ?? fail(400, 'Unknown featured app') : null;
  const raw = featured?.url ?? field(b.url, 500);
  let url: string;
  try { const u = new URL(raw); if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password || u.hash) throw new Error('x'); url = u.href; }
  catch { return fail(400, 'Give the app’s MCP address: https://… (port 443, no user name)'); }
  const authKind = featured ? 'oauth' : (['oauth', 'bearer', 'none'] as const).find((x) => x === b.authKind) ?? fail(400, 'Choose how Vitals OS signs in: OAuth, a token or none');
  const token = field(b.token, 4000);
  if (authKind === 'bearer' && token.length < 8) fail(400, 'Paste the app’s token (8 characters or more)');
  const label = field(b.label, 80) || featured?.name || new URL(url).hostname;
  let id: string;
  try {
    id = (await c.query(`insert into pulse.mcp_connector(org_id,app_key,label,url,auth_kind,created_by) values(pulse.current_org(),$1,$2,$3,$4,$5) returning id`,
      [featured?.key ?? null, label, url, authKind, person])).rows[0].id;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '23505') fail(409, 'This app is already connected');
    if (code === '42501') fail(403, 'Company admins connect apps');
    throw e;
  }
  if (authKind === 'bearer') await c.query('select pulse.mcp_connector_secret($1,$2,$3)', ['bearer', id, JSON.stringify({ bearer: await sealText(await orgOf(c), id, 'bearer', token) })]);
  if (authKind !== 'oauth') return refreshTools(c, f, id);
  return getConnector(c, id);
}

/** Change what a connector offers and to whom (admins). */
export async function updateConnector(c: PoolClient, id: string, b: Row): Promise<Connector> {
  const k = await getConnector(c, id);
  const names = new Set(k.tools.map((t) => t.name));
  const list = (x: unknown) => Array.isArray(x) ? [...new Set(x.map(String))].filter((n) => names.has(n)) : undefined;
  const enabled = list(b.enabledTools) ?? k.enabledTools;
  const auto = (list(b.autoTools) ?? k.autoTools).filter((n) => enabled.includes(n) && !k.tools.find((t) => t.name === n)?.readOnly);
  const people = b.peopleAccess === undefined ? k.peopleAccess : ['admins', 'leadership', 'staff'].includes(String(b.peopleAccess)) ? String(b.peopleAccess) : fail(400, 'People: admins, leadership or all staff');
  const ai = b.aiAccess === undefined ? k.aiAccess : ['none', 'chosen', 'all'].includes(String(b.aiAccess)) ? String(b.aiAccess) : fail(400, 'AI employees: none, chosen or all');
  const agents = b.aiAgents === undefined ? k.aiAgents : Array.isArray(b.aiAgents) && b.aiAgents.every((x) => UUID.test(String(x))) ? [...new Set(b.aiAgents.map(String))].slice(0, 100) : fail(400, 'Choose AI employees from the list');
  if (agents.length && (await c.query(`select count(*)::int n from pulse.person where id=any($1) and side='agent'`, [agents])).rows[0].n !== agents.length) fail(400, 'Choose AI employees from the list');
  const label = field(b.label, 80) || k.label;
  await c.query(`update pulse.mcp_connector set label=$2,enabled_tools=$3,auto_tools=$4,people_access=$5,ai_access=$6,ai_agents=$7 where id=$1`, [k.id, label, enabled, auto, people, ai, agents]);
  if (typeof b.token === 'string' && k.authKind === 'bearer') {
    if (b.token.trim().length < 8) fail(400, 'Paste the app’s token (8 characters or more)');
    await c.query('select pulse.mcp_connector_secret($1,$2,$3)', ['bearer', k.id, JSON.stringify({ bearer: await sealText(await orgOf(c), k.id, 'bearer', b.token.trim()) })]);
  }
  return getConnector(c, k.id);
}

/** Remove (admins): the secrets are forgotten; the ledger and the calls stay. */
export async function removeConnector(c: PoolClient, id: string): Promise<void> {
  const k = await getConnector(c, id);
  await c.query('select pulse.mcp_connector_secret($1,$2)', ['forget', k.id]);
  await c.query(`update pulse.mcp_connector set status='removed',enabled_tools='{}',auto_tools='{}' where id=$1`, [k.id]);
}

/** Start an admin's OAuth sign-in: the app's metadata, Vitals OS registered there, PKCE and a one-use state. */
export async function startSignIn(c: PoolClient, f: Fetcher, id: string, redirectUri: string): Promise<{ url: string }> {
  const k = await getConnector(c, id);
  if (k.authKind !== 'oauth') fail(400, 'This connector signs in with a token');
  const as = await discover(f, k.url);
  const org = await orgOf(c);
  const reg = await register(f, as, redirectUri);
  await c.query('select pulse.mcp_connector_secret($1,$2,$3)', ['client', k.id, JSON.stringify({
    oauth: { issuer: as.issuer, authorizationEndpoint: as.authorizationEndpoint, tokenEndpoint: as.tokenEndpoint, clientId: reg.clientId, redirectUri, scopes: as.scopes },
    clientSecret: reg.clientSecret ? await sealText(org, k.id, 'client', reg.clientSecret) : null })]);
  const { verifier, challenge } = pkce(), state = randomBytes(24).toString('base64url');
  await c.query('select pulse.mcp_connector_secret($1,$2,$3)', ['begin', k.id, JSON.stringify({ stateHash: sessionHash(state), verifier, redirectUri })]);
  const url = new URL(as.authorizationEndpoint);
  url.search = new URLSearchParams({ response_type: 'code', client_id: reg.clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256',
    resource: k.url, ...(as.scopes.length ? { scope: as.scopes.join(' ') } : {}) }).toString();
  return { url: url.href };
}

/** The app sent the admin back: swap the code (once, same admin, 10 minutes), seal the tokens, read the tools. */
export async function finishSignIn(c: PoolClient, f: Fetcher, b: Row): Promise<Connector> {
  const state = field(b.state, 200), code = field(b.code, 2000);
  if (!state) fail(400, 'The sign-in came back without its state. Start again.');
  const a = (await c.query('select pulse.mcp_connector_take($1) a', [sessionHash(state)])).rows[0].a as Row | null;
  if (!a) fail(400, 'This sign-in is no longer valid. Start again from Settings → Connectors.');
  const id = String(a!.connectorId);
  if (b.error || !code) { await c.query(`update pulse.mcp_connector set status='needs_auth',last_error=$2 where id=$1`, [id, `Sign-in not completed: ${field(b.error, 100) || 'no code'}`]); return getConnector(c, id); }
  const k = await getConnector(c, id), org = await orgOf(c);
  const s = (await c.query('select pulse.mcp_connector_secret($1,$2) s', ['read', id])).rows[0].s as Row;
  const o = (s.oauth ?? {}) as Row;
  const secret = s.clientSecret ? await openText(org, id, 'client', s.clientSecret as Box) : null;
  const t = await tokenCall(f, String(o.tokenEndpoint), { grant_type: 'authorization_code', code, redirect_uri: String(a!.redirectUri), code_verifier: String(a!.verifier), resource: k.url },
    String(o.clientId), secret);
  if (!t) fail(502, 'The app did not accept the sign-in. Start again.');
  await c.query('select pulse.mcp_connector_secret($1,$2,$3)', ['tokens', id, JSON.stringify({ signedIn: true, access: await sealText(org, id, 'access', t!.access), accessExpiresAt: t!.expiresAt,
    ...(t!.refresh ? { refresh: await sealText(org, id, 'refresh', t!.refresh) } : {}), scopes: t!.scopes ?? (o.scopes as string[] | undefined) ?? [] })]);
  return refreshTools(c, f, id);
}

export type UsableTool = { connectorId: string; connector: string; name: string; title: string; description: string; inputSchema: Row; writes: boolean; needsConfirm: boolean };
/** The tools the viewer may use: connectors they may use (people by role, AI employees by name; decided in the database), enabled tools only. */
export async function usableTools(c: PoolClient): Promise<UsableTool[]> {
  const rows = (await c.query(`${SELECT} where status='connected' and pulse.mcp_can_use(id) order by label`)).rows.map(connectorOut);
  return rows.flatMap((k) => k.tools.filter((t) => k.enabledTools.includes(t.name)).map((t) => ({ connectorId: k.id, connector: k.label, name: t.name, title: t.title,
    description: t.description, inputSchema: t.inputSchema, writes: !t.readOnly, needsConfirm: !t.readOnly && !k.autoTools.includes(t.name) })));
}

export type ToolAnswer = { outcome: 'ok' | 'tool_error' | 'needs_confirm' | 'failed'; text: string; callId: string | null; writes: boolean };
/** Use one tool, audited. A writing tool needs confirm unless an admin allowed it to run on its own; readOnly asks for a
 *  reading tool only (connectors.read). Refusals before the call (not allowed, unknown tool) are errors and change nothing. */
export async function useTool(c: PoolClient, f: Fetcher, input: { connectorId: string; tool: string; args: unknown; confirm: boolean; via: 'screen' | 'api' | 'assistant'; readOnly?: boolean }): Promise<ToolAnswer> {
  const id = connectorId(input.connectorId);
  if (!(await c.query('select pulse.mcp_can_use($1) ok', [id])).rows[0].ok) fail(403, 'You may not use this connector. Its admin chooses who may.');
  const k = await getConnector(c, id);
  const t = k.tools.find((x) => x.name === input.tool);
  if (!t || !k.enabledTools.includes(t.name)) fail(404, `This connector has no tool “${String(input.tool).slice(0, 80)}” switched on`);
  const writes = !t!.readOnly;
  if (input.readOnly && writes) fail(403, 'This tool changes things in the app: use it with the connectors.write area');
  const args = input.args === undefined || input.args === null ? {} : input.args;
  if (typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 65536) fail(400, 'Arguments are one JSON object of up to 64 KB');
  const log = async (outcome: ToolAnswer['outcome'], ms: number | null, detail: string | null) =>
    String((await c.query('select pulse.mcp_tool_call_log($1,$2,$3,$4,$5,$6,$7,$8) id', [id, t!.name, input.via === 'screen' ? 'screen' : input.via, writes, input.confirm, outcome, ms, detail])).rows[0].id);
  if (writes && !input.confirm && !k.autoTools.includes(t!.name)) {
    return { outcome: 'needs_confirm', writes, callId: await log('needs_confirm', null, null),
      text: `“${t!.title}” changes things in ${k.label}. Ask the person first, then call again with confirm true.` };
  }
  const start = Date.now();
  try {
    const r = await callTool(f, k.url, await accessToken(c, f, k), t!.name, args as Row);
    return { outcome: r.isError ? 'tool_error' : 'ok', writes, text: r.text, callId: await log(r.isError ? 'tool_error' : 'ok', Date.now() - start, r.isError ? r.text.slice(0, 300) : null) };
  } catch (e) {
    if (!(e instanceof ConnectorError) && !(e instanceof DocumentKeyError)) throw e;
    if (e instanceof ConnectorError && e.reason === 'needs_auth') await c.query(`update pulse.mcp_connector set status='needs_auth',last_error=$2 where id=$1 and pulse.mcp_admin()`, [id, e.message.slice(0, 300)]);
    return { outcome: 'failed', writes, text: e.message, callId: await log('failed', Date.now() - start, e.message.slice(0, 300)) };
  }
}

// ------------------------------------------------------------------------------------------------ screens
const real: Fetcher = (url, init) => safeFetch(url, init);
/** The address the admin opened (the web sends it as x-pulse-host), so they come back where their session lives. */
export function returnAddress(req: FastifyRequest) {
  const raw = req.headers['x-pulse-host'], host = normaliseHost(raw);
  return new URL(CALLBACK, host ? publicOrigin(host, undefined, typeof raw === 'string' ? raw : undefined) : companyOrigin()).href;
}
const body = { type: 'object' } as const;
export function registerMcpConnectorRoutes(app: FastifyInstance, { tx, fetcher = real }: { tx: Tx; fetcher?: Fetcher }) {
  const must = (v: Parameters<typeof admin>[0]) => {
    if (!admin(v)) fail(403, 'Company admins manage connectors');
    if (!v.person) fail(403, 'A shared login cannot change connectors');
  };
  app.get('/api/v0/mcp-connectors', req => tx(req, async (c, v) => {
    must(v);
    const agents = (await c.query(`select p.id,p.display_name name from pulse.person p where p.side='agent' and p.status='active' order by p.display_name`)).rows;
    return { connectors: await listConnectors(c), featured: featuredApps(), agents, callback: returnAddress(req) };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/mcp-connectors/:id/ledger', req => tx(req, async (c, v) => {
    must(v);
    const id = connectorId(req.params.id);
    const events = (await c.query(`select id,action,detail,actor_name "actorName",at from pulse.mcp_connector_event where connector_id=$1 order by at desc limit 100`, [id])).rows;
    const calls = (await c.query(`select t.id,t.tool,t.actor_kind "actorKind",p.display_name actor,t.via,t.writes,t.confirmed,t.outcome,t.ms,t.at from pulse.mcp_tool_call t
      left join pulse.person p on p.id=t.actor_id where t.connector_id=$1 order by t.at desc limit 100`, [id])).rows;
    return { events, calls };
  }));
  app.post<{ Body: Row }>('/api/v0/mcp-connectors', { schema: { body } }, req => tx(req, async (c, v) => { must(v); return { connector: await addConnector(c, fetcher, req.body ?? {}, v.person!) }; }));
  app.post<{ Body: Row }>('/api/v0/mcp-connectors/callback', { schema: { body } }, req => tx(req, async (c, v) => { must(v); return { connector: await finishSignIn(c, fetcher, req.body ?? {}) }; }));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/mcp-connectors/:id', { schema: { body } }, req => tx(req, async (c, v) => { must(v); return { connector: await updateConnector(c, req.params.id, req.body ?? {}) }; }));
  app.post<{ Params: { id: string } }>('/api/v0/mcp-connectors/:id/refresh', req => tx(req, async (c, v) => { must(v); return { connector: await refreshTools(c, fetcher, req.params.id) }; }));
  app.post<{ Params: { id: string } }>('/api/v0/mcp-connectors/:id/sign-in', req => tx(req, async (c, v) => { must(v); return startSignIn(c, fetcher, req.params.id, returnAddress(req)); }));
  app.post<{ Params: { id: string } }>('/api/v0/mcp-connectors/:id/remove', req => tx(req, async (c, v) => { must(v); await removeConnector(c, req.params.id); return { ok: true }; }));
  // People use the tools they may (decided in the database), from the screens.
  app.get('/api/v0/mcp-tools', req => tx(req, async c => ({ tools: await usableTools(c) })));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/mcp-connectors/:id/call', { schema: { body } }, req => tx(req, async c =>
    useTool(c, fetcher, { connectorId: req.params.id, tool: field(req.body?.tool, 128), args: req.body?.arguments, confirm: req.body?.confirm === true, via: 'screen' })));
}
