// MCP is a protocol adapter over the v1 executor, never an HTTP loopback or a second domain/auth path.
import { Readable } from 'node:stream';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, JSONRPCRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { v1Fail, type V1Operation } from './v1.js';

type Adapter = {
  errorHandler: (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => unknown;
  settled: (request: FastifyRequest) => Promise<void>;
  list: (request: FastifyRequest, reply: FastifyReply) => Promise<V1Operation[]>;
  call: (request: FastifyRequest, reply: FastifyReply, name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
};
const schema = (op: V1Operation) => ({ type: 'object' as const, additionalProperties: false,
  properties: { ...(op.params ? { params: op.params } : {}), ...(op.query ? { query: op.query } : {}), ...(op.body ? { body: op.body } : {}),
    ...(op.method !== 'GET' ? { idempotencyKey: { type: 'string', pattern: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' } } : {}) },
  required: [...(op.params ? ['params'] : []), ...(op.body ? ['body'] : [])] });

export function registerMcp(app: FastifyInstance, adapter: Adapter) {
  app.route({ method: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD'], url: '/api/v1/mcp', exposeHeadRoute: false,
    errorHandler: adapter.errorHandler, handler: async (request, reply) => {
      // The proxy carries the caller's address and Origin, never a browser's identity.
      const origin = request.headers.origin, host = request.headers['x-pulse-host'] ?? request.headers.host;
      if (origin) {
        let safe = false;
        try { const url = new URL(origin); safe = url.origin === origin && url.host === host && ['https:', 'http:'].includes(url.protocol); } catch { /* refused */ }
        if (!safe) v1Fail(403, 'MCP Origin is not this install');
      }
      if (Object.keys(request.query as object).length) v1Fail(400, 'Unknown MCP query parameter');
      if (request.headers['mcp-session-id']) v1Fail(400, 'This MCP endpoint is stateless; omit Mcp-Session-Id');
      if (Array.isArray(request.body)) v1Fail(400, 'Send one JSON-RPC message; batches are not supported');
      // Calls spend exactly one operation budget/audit receipt. Discovery and lifecycle spend one transport receipt.
      const toolCall = JSONRPCRequestSchema.safeParse(request.body).success && CallToolRequestSchema.safeParse(request.body).success;
      const tools = toolCall && request.method === 'POST' ? [] : await adapter.list(request, reply);
      if (request.method !== 'POST') return reply.header('allow', 'POST').code(405).send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use POST; no standalone stream or session is retained' } });
      const server = new Server({ name: 'pulse', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(op => ({
        name: op.operationId, description: op.summary, inputSchema: schema(op), annotations: { readOnlyHint: op.method === 'GET' },
      })) }));
      // Let the SDK's tools/call wrapper report InvalidParams before its strict parameter parsing.
      server.setRequestHandler(CallToolRequestSchema.pick({ method: true }).passthrough(), async incoming => {
        const { params } = CallToolRequestSchema.parse(incoming);
        // The shared executor validates operation inputs, preserving the HTTP denial order and wording.
        return adapter.call(request, reply, params.name, params.arguments ?? {});
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      // Hold the HTTP headers until the single operation has its rate/denial receipt, then stream the SDK body.
      let sent!: () => void;
      const answered = new Promise<void>(resolve => { sent = resolve; }), send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        try { await send(message, options); } finally { if ('result' in message || 'error' in message) sent(); }
      };
      let completed = false, disconnected = reply.raw.destroyed, cleanup: Promise<void> | undefined;
      const close = () => cleanup ??= (async () => {
        await server.close();
        if (disconnected) await adapter.settled(request);
      })();
      const disconnect = () => { disconnected = true; if (completed) void close(); };
      // Attach before the SDK or executor awaits. A lost client does not cancel the transaction.
      reply.raw.once('close', disconnect); reply.raw.once('error', disconnect);
      try {
        await server.connect(transport);
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
        const incoming = new Request(`http://pulse.invalid/api/v1/mcp`, { method: 'POST', headers, body: JSON.stringify(request.body) });
        const response = await transport.handleRequest(incoming);
        if (response.status === 200 && response.headers.get('content-type')?.startsWith('text/event-stream')) await answered;
        if (disconnected) return;
        reply.code(response.status);
        response.headers.forEach((value, key) => reply.header(key, value));
        reply.header('x-accel-buffering', 'no').header('cache-control', 'no-store');
        return response.body ? reply.send(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)) : reply.send();
      } catch (e) { await close(); throw e; }
      finally { completed = true; if (disconnected) await close(); }
    } });
}
