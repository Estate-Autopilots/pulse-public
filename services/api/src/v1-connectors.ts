// CONNECTORS-CONTRACTS (owner, 6 Nov 2026): the tools of the apps a company connected (Settings → Connectors,
// mcp-connectors.ts), over API v1, so AI employees (their bot keys), people's tokens, MCP clients such as Claude and
// ChatGPT, and the `pulse` CLI use them from the same definitions. Area `connectors`: connectors.read uses tools the app
// marks read-only; connectors.write uses any switched-on tool, and a writing tool needs confirm true unless the
// company's admin let it run on its own. Who may use which connector is the database's (pulse.mcp_can_use: people by
// role, AI employees by name), inside the key's own areas. Every call is audited (pulse.mcp_tool_call).
import { safeFetch } from './safe-fetch.js';
import { usableTools, useTool, type Fetcher } from './mcp-connectors.js';
import { defineV1Operation, v1Fail, type V1Context, type V1Input } from './v1.js';
import { bool, maybe, object, str, text, uuid } from './v1-kit.js';

const fetcher: Fetcher = (url, init) => safeFetch(url, init);
const TOOL = object({ connectorId: uuid, connector: str, name: str, title: str, description: str, inputSchemaJson: str, writes: bool, needsConfirm: bool });
const ANSWER = object({ outcome: { enum: ['ok', 'tool_error', 'needs_confirm', 'failed'] }, text: str, callId: maybe, writes: bool });
const ARGS = { type: 'string', maxLength: 65536, description: 'The tool\'s arguments as one JSON object (see inputSchemaJson from list_connector_tools), e.g. {"query":"acme"}.' };
/** Who may use the connector is the database's, checked again on every attempt (replays too). */
const mayUse = async (ctx: V1Context, { params }: V1Input) => {
  if (!(await ctx.client.query('select pulse.mcp_can_use($1) ok', [params.connectorId])).rows[0]?.ok) v1Fail(403, 'You may not use this connector. Its company admin chooses who may.');
};
const parse = (raw: unknown) => { if (raw === undefined || raw === '') return {}; try { return JSON.parse(String(raw)); } catch { return null; } };

defineV1Operation({ operationId: 'listConnectorTools', method: 'GET', path: '/api/v1/connectors/tools', scope: 'connectors.read',
  summary: 'The tools of the apps this company connected that you may use',
  response: object({ items: { type: 'array', items: TOOL } }),
  mcp: { name: 'list_connector_tools', title: 'List connected app tools',
    description: 'Lists the tools of the apps this company connected (Settings → Connectors) that you may use: the app, the tool\'s name, what it does, its input schema (JSON), whether it changes things (writes) and whether it needs confirm true. Use them with use_connector_tool.' },
  handler: async (ctx) => ({ items: (await usableTools(ctx.client)).map(({ inputSchema, ...t }) => ({ ...t, inputSchemaJson: JSON.stringify(inputSchema) })) }),
});

defineV1Operation({ operationId: 'readWithConnector', method: 'POST', path: '/api/v1/connectors/{connectorId}/read', scope: 'connectors.read',
  summary: 'Use a read-only tool of a connected app',
  params: object({ connectorId: uuid }), body: object({ tool: text(128), arguments: ARGS }, ['tool']), response: ANSWER,
  authorize: mayUse,
  mcp: { name: 'read_with_connector', title: 'Read with a connected app',
    description: 'Calls one read-only tool (writes false in list_connector_tools) of a connected app with its arguments as a JSON string, and returns its answer as text. Every call is recorded.', idempotent: true },
  handler: async (ctx, { params, body }) => {
    const b = body as { tool: string; arguments?: string }, args = parse(b.arguments);
    if (args === null) return { outcome: 'failed', text: 'The arguments are not valid JSON.', callId: null, writes: false };
    return useTool(ctx.client, fetcher, { connectorId: params.connectorId, tool: b.tool, args, confirm: false, via: 'api', readOnly: true });
  },
});

defineV1Operation({ operationId: 'useConnectorTool', method: 'POST', path: '/api/v1/connectors/{connectorId}/use', scope: 'connectors.write',
  summary: 'Use any switched-on tool of a connected app (a writing tool needs confirm true unless the admin allowed it)',
  params: object({ connectorId: uuid }),
  body: object({ tool: text(128), arguments: ARGS, confirm: { type: 'boolean', description: 'true once the person agreed to what a writing tool will change. Without it a writing tool answers needs_confirm and changes nothing.' } }, ['tool']),
  response: ANSWER, authorize: mayUse,
  mcp: { name: 'use_connector_tool', title: 'Use a connected app',
    description: 'Calls one tool of a connected app (from list_connector_tools) with its arguments as a JSON string. A tool that changes things answers needs_confirm unless confirm is true or the company\'s admin let it run on its own: ask the person first. Every call is recorded.', destructive: true },
  handler: async (ctx, { params, body }) => {
    const b = body as { tool: string; arguments?: string; confirm?: boolean }, args = parse(b.arguments);
    if (args === null) return { outcome: 'failed', text: 'The arguments are not valid JSON.', callId: null, writes: false };
    return useTool(ctx.client, fetcher, { connectorId: params.connectorId, tool: b.tool, args, confirm: b.confirm === true, via: 'api' });
  },
});
