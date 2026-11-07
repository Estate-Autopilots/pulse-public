// API-PLATFORM-2 (owner, 5 Nov 2026: "complete control of Pulse through the API, agents, tier-wise access"): the
// AI-employee admin API (migration 1596; design in docs/api/PLATFORM.md section 6). Company admins only, with their own
// key (an AI member's, an app's or a runner's key is refused by the database: it acts as an AI member, never an admin):
// create and list AI employees, set their tools, profile and daily budget, a monthly token cap, make and revoke their bot
// keys (the areas each may use), and read their activity. Every change is on the app ledger as ai_employee.*.
import { createHash, randomBytes } from 'node:crypto';
import { staffUsername } from './records.js';
import { defineV1Operation, v1Fail, type V1Context } from './v1.js';
import { V1_SCOPES } from './service-key.js';
import { bool, change, confirmed, int, maybe, object, one, str, text, uuid, type Row } from './v1-kit.js';

const AGENT = object({ id: uuid, employeeId: maybe, name: str, title: maybe, status: { enum: ['on', 'paused', 'off'] }, lane: maybe,
  tools: { type: 'array', items: str }, ownerId: { type: ['string', 'null'] }, dailyTokenBudget: { type: ['integer', 'null'] },
  monthlyTokenCap: { type: ['integer', 'null'] }, tokensThisMonth: int, liveKeys: int });
const KEY = object({ id: uuid, name: str, scopes: { type: 'array', items: str }, createdAt: str, expiresAt: str, lastUsedAt: { type: ['string', 'null'] }, live: bool });
const ONE = object({ agentId: uuid });
const CAP = { type: ['integer', 'null'], minimum: 1000, maximum: 100_000_000_000 };
const TOOLS = { type: 'array', maxItems: 6, uniqueItems: true, items: { enum: ['chats', 'tasks', 'memory', 'board', 'drive', 'web'] } };

const n = (v: unknown) => v === null || v === undefined ? null : Number(v);
const agentOut = (a: Row) => ({ id: String(a.id), employeeId: (a.employeeId as string) ?? null, name: String(a.name), title: (a.title as string) ?? null,
  status: String(a.status) as 'on', lane: (a.lane as string) ?? null, tools: (a.tools as string[]) ?? [], ownerId: (a.ownerId as string) ?? null,
  dailyTokenBudget: n(a.dailyTokenBudget), monthlyTokenCap: n(a.monthlyTokenCap), tokensThisMonth: Number(a.tokensThisMonth ?? 0), liveKeys: Number(a.liveKeys ?? 0) });
const keyOut = (k: Row) => ({ id: String(k.id), name: String(k.name), scopes: (k.scopes as string[]) ?? [], createdAt: String(k.createdAt), expiresAt: String(k.expiresAt),
  lastUsedAt: k.lastUsedAt === null || k.lastUsedAt === undefined ? null : String(k.lastUsedAt), live: k.live === true });

/** A person's own key, and the database's admin check (pulse.ai_employee_admin). */
const admin = async (ctx: V1Context, agent: string | null = null) => {
  if (ctx.principal.kind !== 'person') v1Fail(403, 'Company admins manage AI employees with their own key');
  await one(ctx, 'select pulse.ai_employee_admin($1) v', [agent]);
};
const list = async (ctx: V1Context) => ((await one<Row[]>(ctx, 'select pulse.ai_employee_list() v')) ?? []).map(agentOut);
const find = async (ctx: V1Context, id: string) => (await list(ctx)).find(a => a.id === id) ?? v1Fail(404, 'No such AI employee');

defineV1Operation({ operationId: 'listAiEmployees', method: 'GET', path: '/api/v1/people/ai-employees', scope: 'people.read',
  summary: 'The company\'s AI employees (company admins): status, tools, budgets, this month\'s tokens and live keys',
  response: object({ items: { type: 'array', items: AGENT } }),
  mcp: { name: 'list_ai_employees', title: 'List AI employees', description: 'Lists the company\'s AI employees (company admins only): id, name, role, on/paused/off, tools, daily token budget, monthly token cap, tokens used this month and live bot keys.' },
  handler: async ctx => { await admin(ctx); return { items: await list(ctx) }; },
});

defineV1Operation({ operationId: 'createAiEmployee', method: 'POST', path: '/api/v1/people/ai-employees', scope: 'people.write',
  summary: 'Add an AI employee (company admins); it gets its company ID, no key until you make one',
  body: object({ name: text(80), title: text(120), lane: { enum: ['quick', 'thinking'] }, ownerId: uuid, tools: TOOLS, monthlyTokenCap: CAP }, ['name', 'title']),
  response: object({ aiEmployee: AGENT }), authorize: ctx => admin(ctx),
  mcp: { name: 'create_ai_employee', title: 'Add an AI employee', description: 'Adds an AI employee (company admins only): name, title (its role), lane quick or thinking (default quick), ownerId (the person it reports to; default you), optional tools and monthlyTokenCap. It has no key until create_ai_employee_key.' },
  handler: async (ctx, { body }) => {
    const b = body as Row, name = String(b.name).trim();
    const username = await staffUsername(ctx.client, ctx.tenantId, name);
    const owner = (b.ownerId as string) ?? await one<string>(ctx, 'select pulse.current_viewer()::text v');
    const id = await one<string>(ctx, 'select pulse.agent_create($1) v', [JSON.stringify({ name, title: String(b.title).trim(), ownerId: owner, lane: b.lane ?? 'quick', username })]);
    if (b.tools !== undefined) await one(ctx, 'select pulse.agent_settings_save($1,$2) v', [id, JSON.stringify({ tools: b.tools })]);
    if (b.monthlyTokenCap !== undefined && b.monthlyTokenCap !== null) await one(ctx, 'select pulse.ai_employee_cap_set($1,$2) v', [id, b.monthlyTokenCap]);
    await change(ctx, 'ai_employee.create', id, { title: b.title, lane: b.lane ?? 'quick' });
    return { aiEmployee: await find(ctx, id) };
  },
});

defineV1Operation({ operationId: 'updateAiEmployee', method: 'PATCH', path: '/api/v1/people/ai-employees/{agentId}', scope: 'people.write',
  summary: 'Change an AI employee (company admins): tools, title, lane, daily token budget, monthly token cap (null removes it)', params: ONE,
  body: { ...object({ tools: TOOLS, title: text(120), lane: { enum: ['quick', 'thinking'] }, dailyTokenBudget: { type: 'integer', minimum: 1000, maximum: 2_000_000 }, monthlyTokenCap: CAP }, []), minProperties: 1 },
  response: object({ aiEmployee: AGENT }), authorize: (ctx, input) => admin(ctx, input.params.agentId),
  mcp: { name: 'update_ai_employee', title: 'Change an AI employee', description: 'Changes an AI employee (company admins only): tools (the full list it may use), title, lane, dailyTokenBudget (1,000 to 2,000,000), monthlyTokenCap (tokens a month; null removes the cap). Only the fields sent change.' },
  handler: async (ctx, { params, body }) => {
    const b = body as Row, settings = Object.fromEntries(['tools', 'title', 'lane', 'dailyTokenBudget'].filter(k => b[k] !== undefined)
      .map(k => [k, k === 'dailyTokenBudget' ? String(b[k]) : b[k]]));
    if (Object.keys(settings).length) {
      await one(ctx, 'select pulse.agent_settings_save($1,$2) v', [params.agentId, JSON.stringify(settings)]);
      await change(ctx, 'ai_employee.update', params.agentId, settings);
    }
    if (b.monthlyTokenCap !== undefined) await one(ctx, 'select pulse.ai_employee_cap_set($1,$2) v', [params.agentId, b.monthlyTokenCap]);
    return { aiEmployee: await find(ctx, params.agentId) };
  },
});

const COUNT = (k: string) => object({ [k]: str, count: int });
defineV1Operation({ operationId: 'getAiEmployeeActivity', method: 'GET', path: '/api/v1/people/ai-employees/{agentId}/activity', scope: 'people.read',
  summary: 'What an AI employee did (company admins): API calls by operation and status, refusals, ledger writes, runs and tokens this month', params: ONE,
  query: object({ days: { type: 'string', pattern: '^(?:[1-9]|[1-8][0-9]|90)$' } }, []),
  response: object({ since: str, calls: { type: 'array', items: object({ operationId: maybe, status: int, count: int }) }, refused: int,
    writes: { type: 'array', items: COUNT('action') }, lastCallAt: { type: ['string', 'null'] }, runsThisMonth: int, tokensThisMonth: int, monthlyTokenCap: { type: ['integer', 'null'] } }),
  mcp: { name: 'get_ai_employee_activity', title: 'Read an AI employee\'s activity', description: 'An AI employee\'s activity over the last days (1 to 90, default 7; company admins only): its API calls by operation and status, how many were refused, its writes on the ledger by action, its runs and tokens this month against its monthly cap.' },
  handler: async (ctx, { params, query }) => {
    await admin(ctx, params.agentId);
    const a = await one<Row>(ctx, 'select pulse.ai_employee_activity($1,$2) v', [params.agentId, Number(query.days ?? 7)]);
    return { since: String(a.since), calls: ((a.calls as Row[]) ?? []).map(c => ({ operationId: (c.operationId as string) ?? null, status: Number(c.status), count: Number(c.count) })),
      refused: Number(a.refused ?? 0), writes: ((a.writes as Row[]) ?? []).map(w => ({ action: String(w.action), count: Number(w.count) })),
      lastCallAt: a.lastCallAt ? String(a.lastCallAt) : null, runsThisMonth: Number(a.runsThisMonth ?? 0), tokensThisMonth: Number(a.tokensThisMonth ?? 0), monthlyTokenCap: n(a.monthlyTokenCap) };
  },
});

defineV1Operation({ operationId: 'listAiEmployeeKeys', method: 'GET', path: '/api/v1/people/ai-employees/{agentId}/keys', scope: 'people.read',
  summary: 'An AI employee\'s live bot keys and the areas each may use (company admins); never a secret', params: ONE, response: object({ items: { type: 'array', items: KEY } }),
  mcp: { name: 'list_ai_employee_keys', title: 'List an AI employee\'s keys', description: 'Lists an AI employee\'s live bot keys (company admins only): name, the areas (scopes) each may use, expiry and last use. Never a secret.' },
  handler: async (ctx, { params }) => { await admin(ctx, params.agentId); return { items: ((await one<Row[]>(ctx, 'select pulse.ai_employee_keys($1) v', [params.agentId])) ?? []).map(keyOut) }; },
});

defineV1Operation({ operationId: 'createAiEmployeeKey', method: 'POST', path: '/api/v1/people/ai-employees/{agentId}/keys', scope: 'people.write',
  summary: 'Make a bot key for an AI employee with the areas it may use (company admins); the secret is shown once', params: ONE,
  body: object({ name: text(60), scopes: { type: 'array', minItems: 1, maxItems: 40, uniqueItems: true, items: { enum: [...V1_SCOPES] } }, days: { type: 'integer', minimum: 1, maximum: 365 } }, ['name', 'scopes', 'days']),
  response: object({ key: KEY, token: { type: 'string', pattern: '^pbk_' } }), authorize: (ctx, input) => admin(ctx, input.params.agentId),
  mcp: { name: 'create_ai_employee_key', title: 'Make an AI employee key', description: 'Makes a bot key (pbk_) for an AI employee (company admins only): name, scopes (the areas it may use, within your plan), days (1 to 365). Answers the secret once: store it in the bot\'s secret settings, never in chat.' },
  handler: async (ctx, { params, body }) => {
    const b = body as Row, token = `pbk_${randomBytes(32).toString('base64url')}`;
    const id = await one<string>(ctx, 'select pulse.ai_employee_key_issue($1,$2,$3,$4,$5) v',
      [params.agentId, String(b.name).trim(), b.scopes, b.days, createHash('sha256').update(token).digest('hex')]);
    const key = ((await one<Row[]>(ctx, 'select pulse.ai_employee_keys($1) v', [params.agentId])) ?? []).find(k => k.id === id) ?? v1Fail(404, 'No such key of this AI employee');
    return { key: keyOut(key), token };
  },
});

defineV1Operation({ operationId: 'revokeAiEmployeeKey', method: 'DELETE', path: '/api/v1/people/ai-employees/{agentId}/keys/{keyId}', scope: 'people.write',
  summary: 'Revoke one of an AI employee\'s bot keys at once (company admins)', params: object({ agentId: uuid, keyId: uuid }),
  query: object({ confirm: { enum: ['true', 'false'] } }, []), response: object({ revoked: bool }), authorize: (ctx, input) => admin(ctx, input.params.agentId),
  mcp: { name: 'revoke_ai_employee_key', title: 'Revoke an AI employee key', destructive: true, description: 'Revokes one of an AI employee\'s bot keys at once (company admins only); whatever uses it stops. Send confirm true only after the person agreed.' },
  handler: async (ctx, { params, query }) => {
    confirmed(query.confirm === 'true' ? { confirm: true } : {}, 'revoke this key at once; whatever uses it stops');
    return { revoked: await one<boolean>(ctx, 'select pulse.ai_employee_key_revoke($1,$2) v', [params.agentId, params.keyId]) };
  },
});
