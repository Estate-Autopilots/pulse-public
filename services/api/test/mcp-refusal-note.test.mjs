// AI-FIX (19 Nov 2026, BUG-CENSUS BC-007): POST /api/v1/mcp answered 400 to 528 calls in 14 days on production (people's
// connected apps, each the first call of a connection) and nothing said why. Every refusal now carries its reason, the
// JSON-RPC method, the protocol version asked for and the client's product name, for the server's telemetry row; never
// arguments. A bare Fastify app with a stand-in adapter: no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerMcp } from '../dist/mcp.js';
import { requestNote, clientProduct } from '../dist/request-notes.js';

const app = Fastify({ logger: false });
const notes = [];
app.addHook('onResponse', async (request, reply) => { notes.push({ status: reply.statusCode, note: requestNote(request) }); });
registerMcp(app, {
  errorHandler: (e, _request, reply) => reply.code(e.status ?? e.statusCode ?? 500).send({ detail: e.message }),
  settled: async () => {}, list: async () => [], call: async () => { throw new Error('no tools here'); },
});
const post = (body, headers = {}, url = '/api/v1/mcp') => app.inject({ method: 'POST', url, payload: body,
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'claude-code/9.9.1 (cli; node 24)', ...headers } });

test('the SDK refusing a protocol version it does not speak says so, with the method, version and client', async () => {
  notes.length = 0;
  const r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': '2099-01-01' });
  assert.equal(r.statusCode, 400);
  const { note } = notes.at(-1);
  assert.match(note.mcp, /Unsupported protocol version: 2099-01-01/);
  assert.equal(note.rpc, 'tools/list'); assert.equal(note.version, '2099-01-01'); assert.equal(note.client, 'claude-code/9.9.1');
  assert.ok(note.mcp.length <= 160);
});

test('a message the SDK cannot read, and this endpoint\'s own refusals, say why too', async () => {
  notes.length = 0;
  assert.equal((await post({ jsonrpc: '2.0', id: 2, nonsense: true })).statusCode, 400);
  assert.match(notes.at(-1).note.mcp, /Invalid JSON-RPC message/);
  assert.equal((await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, {}, '/api/v1/mcp?x=1')).statusCode, 400);
  assert.equal(notes.at(-1).note.mcp, 'Unknown MCP query parameter');
  assert.equal((await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { 'mcp-session-id': 'abc' })).statusCode, 400);
  assert.match(notes.at(-1).note.mcp, /stateless/);
});

test('an accepted call carries no note, and the client name is only its product', async () => {
  notes.length = 0;
  const r = await post({ jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(r.statusCode, 200);
  assert.equal(notes.at(-1).note, undefined);
  assert.equal(clientProduct('Mozilla/5.0 (X11; Linux x86_64) secret@example.com'), 'Mozilla/5.0');
  assert.equal(clientProduct(undefined), '-');
  await app.close();
});
