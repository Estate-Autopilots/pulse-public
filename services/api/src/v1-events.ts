// API-PLATFORM-2 (owner, 5 Nov 2026: "complete control of Pulse through the API, agents, tier-wise access"): webhooks
// and events over API v1 (migration 1594; design in docs/api/PLATFORM.md section 3).
//  * Events are recorded by triggers on the records themselves, so a change made on a screen, through the API, by an AI
//    member or by a worker is one event. An event carries ids and short states only; details are read with a key.
//  * listEvents pages them (resume from nextCursor); GET /api/v1/events/stream (v1.ts) streams the same answers. A key
//    receives the events of the areas it holds (tasks.read for task.*, finance.read for expense.*, …), and each event's
//    record must be visible to the key's person or AI member, checked here as them on the call's transaction.
//  * Webhooks are company admins' (pulse.v1_webhook_admin in the database): register an https endpoint, choose the
//    events, see the delivery log, redeliver, send a test. The signing secret is shown once, when it is made. The
//    number of webhooks follows the company's API tier. Settings → API → Webhooks uses the /api/v0/webhooks routes below,
//    which call the same database functions.
//  * SSRF: an endpoint must be https on port 443 with a public host name; at registration the name is resolved and any
//    private, loopback, link-local (cloud metadata) or reserved address is refused, and every delivery resolves it
//    again and pins the checked address (safe-outbound.ts).
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { fail, type Tx } from './routes.js';
import { publicAddress } from './safe-outbound.js';
import { PAGE_QUERY, pageResponse, pageV1 } from './v1-paging.js';
import { defineV1Operation, v1Fail, type V1Context } from './v1.js';
import { bool, int, maybe, object, one, rows, str, text, uuid, type Row } from './v1-kit.js';
import type { V1Scope } from './service-key.js';

export const EVENT_TYPES = ['task.created', 'task.updated', 'task.completed', 'project.created', 'project.updated', 'project.deleted',
  'expense.created', 'expense.approved', 'expense.rejected', 'leave.requested', 'leave.decided',
  'quotation.issued', 'invoice.issued', 'invoice.paid', 'chat.message.posted'] as const;
const AREA: Record<string, V1Scope> = { task: 'tasks.read', project: 'projects.read', expense: 'finance.read', leave: 'hr.read',
  quotation: 'billing.read', invoice: 'billing.read', chat: 'chats.read' };
export const areaOf = (type: string) => AREA[type.split('.')[0]];

// ------------------------------------------------------------------------------------------------ endpoint safety
type Resolve = (host: string) => Promise<{ address: string }[]>;
let resolveHost: Resolve = host => lookup(host, { all: true, verbatim: true });
/** Tests swap the resolver so nothing leaves the machine. */
export const setWebhookResolver = (fn: Resolve) => { resolveHost = fn; };
/** null when the address may be registered; otherwise the sentence to show. */
export async function webhookUrlProblem(raw: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return 'Enter the full address, starting with https://'; }
  if (raw.length > 2048 || u.protocol !== 'https:' || u.username || u.password || u.hash || (u.port && u.port !== '443') || /\s/.test(raw)) {
    return 'Use an https:// address on the standard port, with no user name, password or # part';
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) return publicAddress(host) ? null : 'That address is not on the public internet';
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) return 'That address is not on the public internet';
  try {
    const found = await Promise.race([resolveHost(host), new Promise<never>((_, reject) => setTimeout(() => reject(Error('timeout')), 2000))]);
    if (found.some(a => !publicAddress(a.address))) return 'That address points to a private network';
  } catch { /* not resolvable yet: every delivery resolves and checks it again */ }
  return null;
}
export const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

// ------------------------------------------------------------------------------------------------ schemas
const TYPE = { enum: [...EVENT_TYPES] };
const TS = { type: ['string', 'null'] };
const WEBHOOK = object({ id: uuid, url: str, events: { type: 'array', items: str }, description: maybe, active: bool, disabledReason: maybe, secretHint: str,
  createdAt: str, createdBy: maybe, failingSince: TS, lastSuccessAt: TS, pending: int, failedToday: int });
const DELIVERY = object({ id: uuid, webhookId: uuid, eventId: uuid, eventType: str, status: { enum: ['pending', 'delivered', 'failed', 'cancelled'] }, attempts: int,
  nextAt: TS, lastStatus: { type: ['integer', 'null'] }, lastError: maybe, lastMs: { type: ['integer', 'null'] }, lastAttemptAt: TS, deliveredAt: TS,
  redeliveryOf: { type: ['string', 'null'] }, createdAt: str });
const DATA_KEYS = ['taskId', 'projectId', 'assigneeId', 'status', 'deleted', 'entryId', 'decidedBy', 'leaveId', 'personId', 'fromDate', 'toDate',
  'documentId', 'clientId', 'chatId', 'messageId', 'authorId', 'parentId', 'webhookId'];
const EVENT = object({ id: uuid, type: str, createdAt: str, subjectId: uuid,
  data: object(Object.fromEntries(DATA_KEYS.map(k => [k, k === 'deleted' ? bool : maybe])), []) });
const URL_FIELD = { type: 'string', minLength: 12, maxLength: 2048, pattern: '^https://' };
const EVENTS_FIELD = { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: TYPE };

const iso = (v: unknown) => v === null || v === undefined ? null : String(v);
const webhookOut = (w: Row) => ({ id: String(w.id), url: String(w.url), events: (w.events as string[]) ?? [], description: (w.description as string) ?? null,
  active: w.active === true, disabledReason: (w.disabledReason as string) ?? null, secretHint: String(w.secretHint), createdAt: String(w.createdAt),
  createdBy: (w.createdBy as string) ?? null, failingSince: iso(w.failingSince), lastSuccessAt: iso(w.lastSuccessAt), pending: Number(w.pending ?? 0), failedToday: Number(w.failedToday ?? 0) });
const deliveryOut = (d: Row) => ({ id: String(d.id), webhookId: String(d.webhookId), eventId: String(d.eventId), eventType: String(d.eventType), status: String(d.status),
  attempts: Number(d.attempts), nextAt: iso(d.nextAt), lastStatus: d.lastStatus === null || d.lastStatus === undefined ? null : Number(d.lastStatus),
  lastError: (d.lastError as string) ?? null, lastMs: d.lastMs === null || d.lastMs === undefined ? null : Number(d.lastMs), lastAttemptAt: iso(d.lastAttemptAt),
  deliveredAt: iso(d.deliveredAt), redeliveryOf: (d.redeliveryOf as string) ?? null, createdAt: String(d.createdAt) });

/** Webhooks are a company admin's (people only: an AI member holds no role, and the database refuses it). */
const admin = async (ctx: V1Context) => {
  if (ctx.principal.kind !== 'person') v1Fail(403, 'Company admins manage webhooks with their own key');
  if (!(await one<boolean>(ctx, "select pulse.viewer_is('admin') v"))) v1Fail(403, 'Company admins manage webhooks');
};
const checkUrl = async (url: unknown) => { if (typeof url === 'string') { const why = await webhookUrlProblem(url); if (why) v1Fail(400, why); } };

// ------------------------------------------------------------------------------------------------ events
/** Of these events, the ones whose records the principal may see, asked as them on this transaction. */
async function visible(ctx: V1Context, items: Row[]): Promise<Row[]> {
  const of = (prefix: string[]) => items.filter(e => prefix.includes(String(e.type).split('.')[0]));
  const ids = (list: Row[], key: string) => [...new Set(list.map(e => (e.data as Row)?.[key] as string).filter(Boolean))];
  const ok = new Set<string>();
  const add = (list: Row[]) => list.forEach(e => ok.add(String(e.id)));
  const tasks = of(['task']);
  if (tasks.length) {
    const seen = new Set((await rows(ctx, 'select id::text from pulse.task where id=any($1::uuid[])', [ids(tasks, 'taskId')])).map(r => String(r.id)));
    add(tasks.filter(e => seen.has(String((e.data as Row).taskId))));
  }
  const projects = of(['project']);
  if (projects.length) {
    const seen = new Set((await rows(ctx, 'select id::text from pulse.project where id=any($1::uuid[])', [ids(projects, 'projectId')])).map(r => String(r.id)));
    add(projects.filter(e => seen.has(String((e.data as Row).projectId))));
  }
  const chats = of(['chat']);
  if (chats.length) {
    const seen = new Set((await rows(ctx, 'select channel_id::text id from pulse.chat_member where person_id=pulse.current_viewer() and channel_id=any($1::uuid[])', [ids(chats, 'chatId')])).map(r => String(r.id)));
    add(chats.filter(e => seen.has(String((e.data as Row).chatId))));
  }
  if (of(['expense']).length && await one<boolean>(ctx, "select (select side from pulse.person where id=pulse.current_viewer()) in ('staff','agent') and pulse.fin_entry_can(false) v")) add(of(['expense']));
  if (of(['quotation', 'invoice']).length && await one<boolean>(ctx, "select pulse.viewer_is('admin','leadership') or pulse.erp_can(false) v")) add(of(['quotation', 'invoice']));
  const leave = of(['leave']);
  if (leave.length) {
    const everyone = await one<boolean>(ctx, "select pulse.viewer_is('hr','admin') v"), me = await one<string>(ctx, 'select pulse.current_viewer()::text v');
    add(leave.filter(e => everyone || (e.data as Row).personId === me));
  }
  return items.filter(e => ok.has(String(e.id)));
}

defineV1Operation({ operationId: 'listEvents', method: 'GET', path: '/api/v1/events', scope: 'events.read',
  summary: 'Events in your areas since a cursor (tasks, projects, expenses, leave, quotations and invoices, chat messages); kept 7 days',
  query: object({ cursor: { type: 'string', pattern: uuid.pattern }, limit: PAGE_QUERY.limit, types: { type: 'string', maxLength: 400, pattern: '^[a-z.]+(,[a-z.]+)*$' } }, []),
  response: pageResponse(EVENT),
  mcp: { name: 'list_events', title: 'Read what changed',
    description: 'Lists events since cursor (the nextCursor of your last call; omit it to start from the oldest kept, 7 days): task.created/updated/completed, project.created/updated/deleted, expense.created/approved/rejected, leave.requested/decided, quotation.issued, invoice.issued/paid, chat.message.posted. Each has ids only: read the record with its own tool. types narrows them (comma separated). You receive only the areas your key holds and records you may see. nextCursor is always set once events exist: keep it and ask again later.' },
  handler: async (ctx, { query }) => {
    const types = query.types ? query.types.split(',') : null;
    if (types?.some(t => !(EVENT_TYPES as readonly string[]).includes(t))) v1Fail(400, `Unknown event type; use ${EVENT_TYPES.join(', ')}`);
    const areas = [...new Set((await ctx.keyScopes!([...new Set(Object.values(AREA))])).map(s => s.split('.')[0]))];
    const limit = Number(query.limit ?? 100);
    let after = query.cursor ?? null; const items: Row[] = [];
    // Read past events the principal may not see, at most 5 pages, so a page is rarely empty while events remain.
    for (let round = 0; round < 5 && items.length < limit && areas.length; round++) {
      const batch = await one<Row[]>(ctx, 'select pulse.v1_events_after($1,$2,$3,$4) v', [after, areas, types, 100]);
      if (!batch.length) break;
      for (const e of await visible(ctx, batch)) if (items.length < limit) items.push(e);
      after = String(items.length >= limit ? items.at(-1)!.id : batch.at(-1)!.id);
      if (batch.length < 100) break;
    }
    const data = (d: unknown) => Object.fromEntries(Object.entries((d ?? {}) as Row).filter(([k]) => DATA_KEYS.includes(k))
      .map(([k, v]) => [k, typeof v === 'boolean' || v === null ? v : String(v)]));
    return { items: items.map(e => ({ id: String(e.id), type: String(e.type), createdAt: String(e.createdAt), subjectId: String(e.subjectId), data: data(e.data) })),
      nextCursor: after };
  },
});

// ------------------------------------------------------------------------------------------------ webhooks (admins)
const LIST = object({ items: { type: 'array', items: WEBHOOK }, eventTypes: { type: 'array', items: str }, limit: int, tier: str });
defineV1Operation({ operationId: 'listWebhooks', method: 'GET', path: '/api/v1/events/webhooks', scope: 'events.read',
  summary: 'Your company\'s webhooks (company admins), with the event types and how many your plan allows', response: LIST,
  mcp: { name: 'list_webhooks', title: 'List webhooks', description: 'Lists the company\'s webhooks (company admins only): address, events, on or off, deliveries waiting and failed today, and how many webhooks the plan allows.' },
  handler: async ctx => {
    await admin(ctx);
    const r = await one<Row>(ctx, 'select pulse.v1_webhook_list() v');
    return { items: (r.webhooks as Row[]).map(webhookOut), eventTypes: r.eventTypes as string[], limit: Number(r.limit), tier: String(r.tier) };
  },
});

defineV1Operation({ operationId: 'createWebhook', method: 'POST', path: '/api/v1/events/webhooks', scope: 'events.write',
  summary: 'Register a webhook (company admins); the signing secret is shown once',
  body: object({ url: URL_FIELD, events: EVENTS_FIELD, description: text(120, 0) }, ['url', 'events']),
  response: object({ webhook: WEBHOOK, secret: { type: 'string', pattern: '^whsec_' } }),
  authorize: admin,
  mcp: { name: 'create_webhook', title: 'Register a webhook',
    description: 'Registers an https address to receive events (company admins only): url (https, public), events (from list_webhooks eventTypes), optional description. Answers the signing secret once: each delivery carries X-Pulse-Signature: t=<unix seconds>,v1=<HMAC-SHA256 hex of "<t>.<body>" with that secret>.' },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    await checkUrl(b.url);
    const secret = newSecret();
    const w = await one<Row>(ctx, 'select pulse.v1_webhook_create($1,$2,$3,$4) v', [b.url, b.events, b.description ?? null, secret]);
    return { webhook: webhookOut(w), secret };
  },
});

const ONE = object({ webhookId: uuid });
defineV1Operation({ operationId: 'updateWebhook', method: 'PATCH', path: '/api/v1/events/webhooks/{webhookId}', scope: 'events.write',
  summary: 'Change a webhook: its address, events, description, or switch it on or off (company admins)', params: ONE,
  body: { ...object({ url: URL_FIELD, events: EVENTS_FIELD, description: text(120, 0), active: bool }, []), minProperties: 1 },
  response: object({ webhook: WEBHOOK }), authorize: admin,
  mcp: { name: 'update_webhook', title: 'Change a webhook', description: 'Changes a webhook (company admins only): url, events, description, or active false to pause it and true to switch it back on. Only the fields sent change.' },
  handler: async (ctx, { params, body }) => {
    await checkUrl((body as Row).url);
    return { webhook: webhookOut(await one<Row>(ctx, 'select pulse.v1_webhook_update($1,$2) v', [params.webhookId, JSON.stringify(body)])) };
  },
});

defineV1Operation({ operationId: 'deleteWebhook', method: 'DELETE', path: '/api/v1/events/webhooks/{webhookId}', scope: 'events.write',
  summary: 'Remove a webhook (company admins); deliveries still waiting are cancelled', params: ONE,
  query: object({ confirm: { enum: ['true', 'false'] } }, []), response: object({ deleted: bool }), authorize: admin,
  mcp: { name: 'delete_webhook', title: 'Remove a webhook', destructive: true,
    description: 'Removes a webhook (company admins only); deliveries still waiting are cancelled. Send confirm true only after the person agreed.' },
  handler: async (ctx, { params, query }) => {
    if (query.confirm !== 'true') v1Fail(409, 'Confirm first: remove this webhook and cancel its waiting deliveries. Ask the person, then send the same call with confirm=true.');
    return { deleted: await one<boolean>(ctx, 'select pulse.v1_webhook_delete($1) v', [params.webhookId]) };
  },
});

defineV1Operation({ operationId: 'sendWebhookTest', method: 'POST', path: '/api/v1/events/webhooks/{webhookId}/test', scope: 'events.write',
  summary: 'Send a test event (webhook.ping) to a webhook (company admins)', params: ONE, body: object({}, []),
  response: object({ delivery: DELIVERY }), authorize: admin,
  mcp: { name: 'send_webhook_test', title: 'Send a test event', description: 'Queues a webhook.ping event to one webhook (company admins only); see the result with list_webhook_deliveries.' },
  handler: async (ctx, { params }) => ({ delivery: deliveryOut(await one<Row>(ctx, 'select pulse.v1_webhook_ping($1) v', [params.webhookId])) }),
});

defineV1Operation({ operationId: 'listWebhookDeliveries', method: 'GET', path: '/api/v1/events/webhooks/{webhookId}/deliveries', scope: 'events.read',
  summary: 'The delivery log of a webhook: status, attempts, the answer\'s HTTP code and time (company admins)', params: ONE,
  query: object({ ...PAGE_QUERY, status: { enum: ['pending', 'delivered', 'failed', 'cancelled'] } }, []), response: pageResponse(DELIVERY),
  mcp: { name: 'list_webhook_deliveries', title: 'Read a webhook\'s delivery log',
    description: 'Lists a webhook\'s deliveries, oldest first (company admins only): status pending, delivered, failed or cancelled; attempts; the last HTTP code, error class and time taken. Pages of up to 100 with nextCursor.' },
  handler: async (ctx, input) => {
    await admin(ctx);
    return pageV1(ctx, 'listWebhookDeliveries', input, async (after, take) =>
      (await one<Row[]>(ctx, 'select pulse.v1_webhook_deliveries($1,$2,$3,$4) v', [input.params.webhookId, after, take, input.query.status ?? null])).map(deliveryOut));
  },
});

defineV1Operation({ operationId: 'redeliverWebhookDelivery', method: 'POST', path: '/api/v1/events/webhooks/{webhookId}/deliveries/{deliveryId}/redeliver', scope: 'events.write',
  summary: "Send one delivery's event again, as a new delivery (company admins)", params: object({ webhookId: uuid, deliveryId: uuid }), body: object({}, []),
  response: object({ delivery: DELIVERY }), authorize: admin,
  mcp: { name: 'redeliver_webhook_delivery', title: 'Redeliver an event', description: 'Sends the event of one delivery again as a new delivery (company admins only), for example after fixing the receiver.' },
  handler: async (ctx, { params }) => ({ delivery: deliveryOut(await one<Row>(ctx, 'select pulse.v1_webhook_redeliver($1,$2) v', [params.webhookId, params.deliveryId])) }),
});

// ------------------------------------------------------------------------------------------------ Settings → API → Webhooks
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function registerWebhookRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  type C = Parameters<Parameters<Tx>[1]>[0];
  const q = async (c: C, sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows[0]?.v;
  const admin = async (c: C, v: { person: string | null; side?: string; nativeDevice?: string }) => {
    if (!v.person || v.nativeDevice || (v.side && v.side !== 'staff') || (await q(c, "select pulse.viewer_is('admin') v")) !== true) fail(403, 'Company admins manage webhooks');
  };
  const idOf = (id: string) => UUID.test(id) ? id : fail(400, 'Choose a webhook');
  const list = async (c: C) => q(c, 'select pulse.v1_webhook_list() v');
  app.get('/api/v0/webhooks', req => tx(req, async (c, v) => { await admin(c, v); return list(c); }));
  app.post<{ Body: Record<string, unknown> }>('/api/v0/webhooks', async (req, reply) => {
    const result = await tx(req, async (c, v) => {
      await admin(c, v);
      const b = req.body ?? {};
      if (typeof b !== 'object' || Object.keys(b).some(k => !['url', 'events', 'description'].includes(k)) || typeof b.url !== 'string' || !Array.isArray(b.events)
        || !b.events.length || b.events.some(e => !(EVENT_TYPES as readonly unknown[]).includes(e)) || (b.description !== undefined && (typeof b.description !== 'string' || b.description.length > 120)))
        fail(400, 'Enter an https address and choose at least one event');
      const why = await webhookUrlProblem(String(b.url).trim()); if (why) fail(400, why);
      const secret = newSecret();
      const webhook = await q(c, 'select pulse.v1_webhook_create($1,$2,$3,$4) v', [String(b.url).trim(), [...new Set(b.events as string[])], b.description ?? null, secret]);
      return { webhook, secret, ...(await list(c)) };
    });
    return reply.header('cache-control', 'no-store').code(201).send(result);
  });
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/webhooks/:id', req => tx(req, async (c, v) => {
    await admin(c, v);
    const b = req.body ?? {};
    if (typeof b !== 'object' || !Object.keys(b).length || Object.keys(b).some(k => !['url', 'events', 'description', 'active'].includes(k))
      || (b.url !== undefined && typeof b.url !== 'string') || (b.active !== undefined && typeof b.active !== 'boolean')
      || (b.events !== undefined && (!Array.isArray(b.events) || !b.events.length || b.events.some(e => !(EVENT_TYPES as readonly unknown[]).includes(e)))))
      fail(400, 'Nothing to change');
    if (typeof b.url === 'string') { const why = await webhookUrlProblem(b.url.trim()); if (why) fail(400, why); }
    await q(c, 'select pulse.v1_webhook_update($1,$2) v', [idOf(req.params.id), JSON.stringify(b)]);
    return list(c);
  }));
  app.delete<{ Params: { id: string } }>('/api/v0/webhooks/:id', req => tx(req, async (c, v) => {
    await admin(c, v);
    await q(c, 'select pulse.v1_webhook_delete($1) v', [idOf(req.params.id)]);
    return list(c);
  }));
  app.post<{ Params: { id: string } }>('/api/v0/webhooks/:id/test', req => tx(req, async (c, v) => {
    await admin(c, v);
    return { delivery: await q(c, 'select pulse.v1_webhook_ping($1) v', [idOf(req.params.id)]) };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/webhooks/:id/deliveries', req => tx(req, async (c, v) => {
    await admin(c, v);
    // The newest 50 (the screen's log); the API pages the whole log.
    return { deliveries: await q(c, 'select pulse.v1_webhook_recent($1) v', [idOf(req.params.id)]) };
  }));
  app.post<{ Params: { id: string; delivery: string } }>('/api/v0/webhooks/:id/deliveries/:delivery/redeliver', req => tx(req, async (c, v) => {
    await admin(c, v);
    if (!UUID.test(req.params.delivery)) fail(400, 'Choose a delivery');
    return { delivery: await q(c, 'select pulse.v1_webhook_redeliver($1,$2) v', [idOf(req.params.id), req.params.delivery]) };
  }));
}
