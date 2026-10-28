// EST-2811 end to end: the maintained MCP SDK client discovers Pulse's authorization server from the /mcp 401,
// registers itself, gets a code through the consent screen, exchanges it with PKCE and calls tools, through the
// web layer's own handlers (apps/web/app/lib/oauth-web.mjs, api/proxy.mjs) in front of the real API on real RLS.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { createApp } from '../dist/app.js';

const w = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 2 }), app = createApp(pool, pool);
const apiAddress = await app.listen({ host: '127.0.0.1', port: 0 });
process.env.PULSE_API_URL = apiAddress;
const { createApiProxy, v0ProxyOptions, v1BearerProxy } = await import('../../../apps/web/app/api/proxy.mjs');
const web = await import('../../../apps/web/app/lib/oauth-web.mjs');
const v0 = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn: 'access', own: true, name: null, status: 'active', rehearsal: false }) });
const path = p => ({ params: Promise.resolve({ path: p }) });

// The same few lines as app/mcp/route.ts, app/oauth/mcp/*/route.ts and the .well-known rewrites.
async function route(request) {
  const url = new URL(request.url), origin = web.publicOrigin(request.headers);
  if (url.pathname === '/mcp') {
    const r = await v1BearerProxy(request, path(['mcp']));
    if (r.status !== 401) return r;
    const h = new Headers(r.headers); h.set('www-authenticate', web.challenge(origin, request.headers.has('authorization')));
    return new Response(r.body, { status: 401, headers: h });
  }
  if (['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) return web.discovery(web.protectedResource(origin));
  if (['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'].includes(url.pathname)) return web.discovery(web.authorizationServer(origin));
  if (url.pathname === '/oauth/mcp/authorize' && request.method === 'GET') {
    const r = await v0(request, path(['oauth', 'authorize'])), data = await r.json();
    return r.ok ? web.consentPage(data, url.searchParams) : web.html('refused', String(data.error), r.status);
  }
  if (url.pathname === '/oauth/mcp/authorize') {
    const form = new URLSearchParams(await request.text()), body = Object.fromEntries([...form].filter(([k]) => k !== 'decision'));
    const r = await v0(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify({ ...body, approve: form.get('decision') === 'approve' }) }), path(['oauth', 'authorize']));
    return web.returnPage((await r.json()).redirect);
  }
  const action = /^\/oauth\/mcp\/(register|token|revoke)$/.exec(url.pathname)?.[1];
  return action ? web.forwardOAuth(request, action) : new Response(null, { status: 404 });
}
const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const r = await route(new Request('http://' + req.headers.host + req.url, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
process.env.PULSE_PUBLIC_URL = origin;

// An OAuth client provider as Claude's would hold it; "the browser" is the HR person approving on the consent screen.
let client, tokens, verifier, code;
const provider = {
  redirectUrl: 'https://claude.example/api/mcp/auth_callback',
  clientMetadata: { client_name: 'Synthetic Claude', redirect_uris: ['https://claude.example/api/mcp/auth_callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post' },
  clientInformation: () => client, saveClientInformation: c => { client = c; },
  tokens: () => tokens, saveTokens: t => { tokens = t; },
  saveCodeVerifier: v => { verifier = v; }, codeVerifier: () => verifier,
  redirectToAuthorization: async authorizationUrl => {
    const browser = { 'cf-access-authenticated-user-email': w.hrEmail };
    const consent = await (await fetch(authorizationUrl, { headers: browser })).text();
    assert.match(consent, /Synthetic Claude wants to use Pulse as you/);
    const form = new URLSearchParams([...consent.matchAll(/name="([a-z_]+)" value="([^"]*)"/g)].map(m => [m[1], m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&')]));
    form.set('decision', 'approve');
    const back = await (await fetch(origin + '/oauth/mcp/authorize', { method: 'POST', headers: { ...browser, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: form })).text();
    code = new URL(/url=([^"]+)"/.exec(back)[1].replace(/&amp;/g, '&')).searchParams.get('code');
  },
};
try {
  const challenge = await fetch(origin + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(challenge.status, 401); assert.match(challenge.headers.get('www-authenticate'), /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  let transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { authProvider: provider });
  await assert.rejects(new Client({ name: 'synthetic', version: '1' }).connect(transport), UnauthorizedError);
  assert.match(code, /^poc_/); assert.match(client.client_id, /^pcl_/);
  await transport.finishAuth(code);
  assert.match(tokens.access_token, /^pat_/); assert.match(tokens.refresh_token, /^prt_/);
  const mcp = new Client({ name: 'synthetic', version: '1' });
  transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { authProvider: provider });
  await mcp.connect(transport);
  const names = (await mcp.listTools()).tools.map(t => t.name);
  for (const name of ['whoami', 'search', 'fetch', 'correct_person_field', 'list_onboarding']) assert.ok(names.includes(name), name);
  const me = await mcp.callTool({ name: 'whoami', arguments: {} });
  assert.equal(me.structuredContent.id, w.hr); assert.equal(me.structuredContent.app, 'Synthetic Claude');
  const found = await mcp.callTool({ name: 'search_people', arguments: { query: 'editor two' } });
  assert.deepEqual(found.structuredContent.items.map(p => p.id), [w.editor2]);
  await mcp.close();
  console.log('MCP SDK client: 401 challenge → discovery → registration → consent → PKCE token → tools/list → tools/call pass');
} finally { server.close(); await app.close(); await pool.end(); }
