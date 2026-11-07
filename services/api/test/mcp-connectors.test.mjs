// CONNECTORS-CONTRACTS: connected apps' outbound guard (https on 443, public addresses only, pinned, no redirects) and
// the MCP client (streamable HTTP, JSON or event-stream answers, OAuth discovery). Synthetic servers only; nothing leaves.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { OutboundError, outboundUrl, publicAddresses, safeFetch } from '../dist/safe-fetch.js';
import { callTool, discover, featuredApps, listTools, rpcAnswer, toolOf } from '../dist/mcp-connectors.js';

const resolver = (map) => async (host) => { if (!(host in map)) throw new Error('ENOTFOUND'); return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 })); };
const refused = async (p, kind) => assert.rejects(p, (e) => e instanceof OutboundError && e.kind === kind);

test('only https on 443 to public addresses, like webhooks', async () => {
  for (const raw of ['http://mcp.example.com/mcp', 'https://mcp.example.com:8443/mcp', 'https://user:pw@mcp.example.com/mcp', 'https://mcp.example.com/mcp#x', 'not a url'])
    assert.throws(() => outboundUrl(raw), (e) => e instanceof OutboundError && e.kind === 'destination');
  const dns = resolver({ 'public.example': ['93.184.216.34'], 'inside.example': ['10.0.0.5'], 'mixed.example': ['93.184.216.34', '127.0.0.1'],
    'v6.example': ['2606:2800:220:1:248:1893:25c8:1946'], 'mapped.example': ['::ffff:127.0.0.1'], 'meta.example': ['169.254.169.254'] });
  assert.equal((await publicAddresses('public.example', dns))[0].address, '93.184.216.34');
  assert.equal((await publicAddresses('v6.example', dns)).length, 1);
  for (const host of ['inside.example', 'mixed.example', 'mapped.example', 'meta.example', '127.0.0.1', '[::1]', '192.168.1.10'])
    await refused(publicAddresses(host, dns), 'destination');
  await refused(publicAddresses('nowhere.example', dns), 'dns');
});

test('the connection is pinned to the address checked and redirects are refused', async () => {
  const dns = resolver({ 'mcp.example.com': ['93.184.216.34'] });
  let seen;
  const send = (url, options, onResponse) => {
    seen = options;
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = options.headers['X-Case'] === 'redirect' ? 302 : 200;
      res.headers = { 'content-type': 'application/json' };
      res.destroy = () => {};
      onResponse(res);
      res.emit('data', Buffer.from('{"ok":true}'));
      res.emit('end');
    };
    return req;
  };
  const r = await safeFetch('https://mcp.example.com/mcp', { method: 'POST', body: '{}', headers: { 'X-Case': 'ok' } }, dns, send);
  assert.equal(r.status, 200);
  assert.equal(r.body, '{"ok":true}');
  await new Promise((done) => seen.lookup('mcp.example.com', {}, (err, address) => { assert.equal(address, '93.184.216.34'); done(); }));
  assert.equal(seen.agent, false);
  await refused(safeFetch('https://mcp.example.com/mcp', { headers: { 'X-Case': 'redirect' } }, dns, send), 'redirect');
});

// A synthetic MCP server: answers initialize, tools/list (two pages, one as an event stream) and tools/call.
function server({ auth = null } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const msg = init.body ? JSON.parse(init.body) : null;
    const reply = (result, stream = false) => ({ status: 200, headers: { 'content-type': stream ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'synthetic-session' },
      body: stream ? `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n` : JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) });
    if (url.includes('/.well-known/oauth-protected-resource')) return { status: 200, headers: {}, body: JSON.stringify({ resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://auth.example.com'], scopes_supported: ['things:read'] }) };
    if (url.includes('/.well-known/oauth-authorization-server')) return { status: 200, headers: {}, body: JSON.stringify({ issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token', registration_endpoint: 'https://auth.example.com/register',
      code_challenge_methods_supported: ['S256'] }) };
    if (auth && init.headers?.Authorization !== `Bearer ${auth}`) return { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"' }, body: '' };
    if (!msg?.id) return { status: 202, headers: {}, body: '' };
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synthetic' } });
    if (msg.method === 'tools/list' && !msg.params.cursor) return reply({ tools: [{ name: 'list_things', description: 'Lists things', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }], nextCursor: 'p2' });
    if (msg.method === 'tools/list') return reply({ tools: [{ name: 'add_thing', title: 'Add a thing', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } }, { name: 'bad name!' }] }, true);
    if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: `called ${msg.params.name} with ${JSON.stringify(msg.params.arguments)}` }], isError: false }, true);
    return { status: 400, headers: {}, body: '' };
  };
  return { f, calls };
}

test('lists tools across pages; only tools the server marks read-only count as reading', async () => {
  const { f, calls } = server({ auth: 'synthetic-token' });
  const tools = await listTools(f, 'https://mcp.example.com/mcp', 'synthetic-token');
  assert.deepEqual(tools.map((t) => [t.name, t.readOnly]), [['list_things', true], ['add_thing', false]]);
  assert.equal(calls.filter((c) => JSON.parse(c.init.body ?? '{}').method === 'tools/list').at(-1).init.headers['Mcp-Session-Id'], 'synthetic-session');
  assert.equal(calls.at(-1).init.headers['MCP-Protocol-Version'], '2025-06-18');
  assert.equal(toolOf({ name: 'x', annotations: { readOnlyHint: false, destructiveHint: false } }).destructive, false);
  await assert.rejects(listTools(f, 'https://mcp.example.com/mcp', 'wrong'), (e) => e.reason === 'needs_auth');
});

test('calls a tool and reads an event-stream answer', async () => {
  const { f } = server();
  const r = await callTool(f, 'https://mcp.example.com/mcp', null, 'add_thing', { name: 'Synthetic' });
  assert.deepEqual(r, { isError: false, text: 'called add_thing with {"name":"Synthetic"}' });
  assert.equal(rpcAnswer({ status: 200, headers: { 'content-type': 'application/json' }, body: '[{"jsonrpc":"2.0","id":2,"result":{}},{"jsonrpc":"2.0","id":3,"result":{"x":1}}]' }, 3).result.x, 1);
  assert.equal(rpcAnswer({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>' }, 1), null);
});

test('OAuth sign-in details come from the server\'s own metadata', async () => {
  const { f } = server({ auth: 'synthetic-token' });
  const as = await discover(f, 'https://mcp.example.com/mcp');
  assert.deepEqual([as.authorizationEndpoint, as.tokenEndpoint, as.registrationEndpoint, as.scopes],
    ['https://auth.example.com/authorize', 'https://auth.example.com/token', 'https://auth.example.com/register', ['things:read']]);
});

test('Sales X-Ray is the first featured app, and only over https', () => {
  assert.equal(featuredApps({ PULSE_SALES_XRAY_URL: 'https://salesxray.example.com/' })[0].url, 'https://salesxray.example.com/v1/mcp');
  assert.equal(featuredApps({ PULSE_SALES_XRAY_URL: 'http://127.0.0.1:8000/' })[0].url, null);
  assert.equal(featuredApps({})[0].key, 'sales-xray');
});
