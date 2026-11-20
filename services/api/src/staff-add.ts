// HR-AGENT (owner, 20 Nov 2026, Lab #1: "Yes, based on some approval giver."): an AI employee never adds a staff member
// itself. Its add_person tool files a request (migration 2493, pulse.staff_add_request_file) and answers "waiting for
// approval" with the request id; the company's named approvers (HR → Policies → New staff approvers; none named = its
// admins) see it on My desk → Approvals. Approve adds the person with People → Add person's own function (addPerson, as
// the approver, in the same transaction) and the database writes the Audit row naming the AI, the approver and the
// request. Decline needs a reason, which goes back to the AI. Requests end after 7 days.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';
import { addPerson } from './records.js';
import { defineV1Operation, v1Fail, type Closed, type V1Context } from './v1.js';

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const value = async <T = unknown>(c: PoolClient, sql: string, args: unknown[] = []): Promise<T> => (await c.query(sql, args)).rows[0]?.v as T;
const mustId = (id: string) => { if (!UUID.test(id)) fail(404, 'Request not found'); };
const own = (v: Viewer) => { if (!v.person) fail(403, 'Use your own Pulse account'); };

/** Approve: People → Add person's own function adds them, as the approver; then the request is closed with its Audit row.
 *  One transaction: if adding fails, nothing changes and the request still waits. */
export async function approveStaffAdd(c: PoolClient, v: Viewer, id: string) {
  own(v);
  const fields = await value<Record<string, string>>(c, 'select pulse.staff_add_request_claim($1) v', [id]);
  const added = await addPerson(c, v, fields);
  const request = await value<Record<string, unknown>>(c, 'select pulse.staff_add_request_done($1,$2) v', [id, added.id]);
  return { request, personId: added.id, ...(added.account ? { account: added.account } : {}) };
}

export function registerStaffAddRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // HR → Policies → New staff approvers: who approves a new staff member an AI asks to add (admins change it).
  app.get('/api/v0/hr/staff-add-approvers', req => tx(req, async (c, v) => {
    own(v);
    if (!(await value<boolean>(c, "select pulse.viewer_is('admin','hr','leadership') v"))) fail(403, 'HR and admins see who approves new staff');
    const setting = await value<Record<string, unknown>>(c, 'select pulse.staff_add_approvers() v');
    const choices = (await c.query(`select p.id,p.display_name name,pp.role from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id
      where p.side='staff' and p.status='active' and pulse.hr_is_staff(p.id) order by p.display_name`)).rows;
    return { ...setting, choices };
  }));
  app.post<{ Body: { people?: unknown } }>('/api/v0/hr/staff-add-approvers', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    own(v);
    // Who may change it is checked before the body (as the database does): a non-admin is refused, never told the body is wrong.
    if (!(await value<boolean>(c, "select pulse.viewer_is('admin') v"))) fail(403, 'Only an admin chooses who approves new staff');
    const people = Array.isArray(req.body?.people) ? req.body.people.map(String) : fail(400, 'Choose the approvers');
    if (people.some(p => !UUID.test(p))) fail(400, 'Choose approvers from the list');
    return value(c, 'select pulse.staff_add_approvers_set($1::uuid[]) v', [people]);
  }));
  // My desk → Approvals: requests to add staff (the database shows each to its approvers, HR, admins and leadership).
  app.get('/api/v0/people/add-requests', req => tx(req, async (c, v) => {
    if (!v.person) return { rows: [] };
    return { rows: await value(c, 'select pulse.staff_add_requests() v') };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/people/add-requests/:id/approve', req => tx(req, async (c, v) => {
    mustId(req.params.id);
    return approveStaffAdd(c, v, req.params.id);
  }));
  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>('/api/v0/people/add-requests/:id/decline', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    mustId(req.params.id); own(v);
    return { request: await value(c, 'select pulse.staff_add_request_decline($1,$2) v', [req.params.id, String(req.body?.reason ?? '')]) };
  }));
}

// ------------------------------------------------------------------------------------------------ API v1 / MCP
const object = (properties: Closed['properties'], required = Object.keys(properties)): Closed =>
  ({ type: 'object', additionalProperties: false, properties, required });
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' };
const str = { type: 'string' }, maybe = { type: ['string', 'null'] };
const who = object({ id: uuid, name: str });
const REQUEST = object({ requestId: uuid, status: { enum: ['waiting_for_approval', 'approved', 'declined', 'expired'] }, name: str, role: str,
  team: maybe, pod: maybe, startDate: maybe, email: maybe, note: maybe, createdAt: str, expiresAt: str, requestedBy: who,
  approvers: { type: 'array', items: who }, decidedBy: { ...who, type: ['object', 'null'] }, decidedAt: maybe, declineReason: maybe,
  personId: maybe, canDecide: { type: 'boolean' }, message: str });
const ANSWER = object({ request: REQUEST });
const ai = (ctx: V1Context) => { if (ctx.principal.kind !== 'ai') v1Fail(403, 'Only an AI employee asks to add staff this way. People add staff in People → Add person.'); };
const read = async (ctx: V1Context, sql: string, args: unknown[]) => ({ request: (await ctx.client.query(sql, args)).rows[0]?.v as unknown });

defineV1Operation({ operationId: 'requestAddPerson', method: 'POST', path: '/api/v1/people/add-requests', scope: 'people.write',
  summary: 'An AI employee asks to add a staff member; a named approver must approve before anyone is added',
  body: object({ name: { type: 'string', minLength: 1, maxLength: 80 }, role: { type: 'string', minLength: 1, maxLength: 80 },
    team: { type: 'string', maxLength: 60 }, pod: { type: 'string', maxLength: 40 },
    startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, email: { type: 'string', maxLength: 120 }, note: { type: 'string', maxLength: 500 } },
  ['name', 'role']),
  response: ANSWER,
  available: async ctx => ctx.principal.kind === 'ai',
  authorize: async ctx => ai(ctx),
  mcp: { name: 'add_person', title: 'Ask to add a staff member', idempotent: true,
    description: 'Asks the company\'s approver to add a new staff member (name, role, and if known team, pod, startDate YYYY-MM-DD, work email, a note). It never adds them itself: it answers status waiting_for_approval with the requestId and who was asked. Nothing is created until an approver presses Approve; a decline comes with a reason; a request nobody decides ends after 7 days. Check the outcome with get_add_person_request and tell the person who asked.' },
  handler: async (ctx, { body }) => read(ctx, 'select pulse.staff_add_request_file($1) v', [JSON.stringify(body ?? {})]),
});

defineV1Operation({ operationId: 'getAddPersonRequest', method: 'GET', path: '/api/v1/people/add-requests/{requestId}', scope: 'people.read',
  summary: 'Reads a request to add a staff member: waiting, approved (with the new person), declined (with the reason) or expired',
  params: object({ requestId: uuid }),
  response: ANSWER,
  available: async ctx => ctx.principal.kind === 'ai' || ctx.principal.kind === 'person',
  mcp: { name: 'get_add_person_request', title: 'Check a request to add staff',
    description: 'Reads a request made with add_person by its requestId: status waiting_for_approval, approved (personId of the new person), declined (declineReason) or expired, with a plain message to pass on.' },
  handler: async (ctx, { params }) => {
    if (ctx.principal.kind !== 'ai' && ctx.principal.kind !== 'person') v1Fail(403, 'Sign in as a person or an AI employee to do this');
    return read(ctx, 'select pulse.staff_add_request_read($1) v', [params.requestId]);
  },
});
