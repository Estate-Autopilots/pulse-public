// AI-FIX-3 (19 Nov 2026, BUG-CENSUS BC-020): Willow Lane's WAS server (its bhrātā bridge key) was answered 400 on every
// quotation-list poll since 10 Nov (144 in 3 days on production) and on 432 of 577 event polls, and nothing on our side
// said which field it sent: the v1 front door refused without a word in the server's telemetry row. Now:
// - every v1 refusal of a field notes the part, the field's path, the schema rule and the field's own name (never a value);
// - an unknown event type notes the type names (only [a-z.]);
// - every list WAS syncs each hour takes the platform's paging limit (listQuotations alone refused it).
// A synthetic world as test/v1.test.mjs: no database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createApp } from '../dist/app.js';
import { requestNote } from '../dist/request-notes.js';
import { defineV1Operation, refusedField, v1Operations } from '../dist/v1.js';

const ORG = '00000000-0000-4000-8000-000000000020', VIEWER = '00000000-0000-4000-8000-0000000000ee';
const SECRET = 'a'.repeat(43), APP = `psvc_00000000-0000-4000-8000-0000000000aa_${SECRET}`;
const closed = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
defineV1Operation({ operationId: 'fixtureRefusalNote', method: 'POST', path: '/api/v1/tasks/{taskId}/refusal-note', scope: 'tasks.write', summary: 'Fixture',
  params: closed({ taskId: { type: 'string', pattern: '^[0-9a-f-]{36}$' } }, ['taskId']),
  query: closed({ limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' } }),
  body: closed({ text: { type: 'string', maxLength: 20 }, lines: { type: 'array', items: closed({ qty: { type: 'integer' } }) } }, ['text']),
  authorize: async () => {}, response: closed({ ok: { type: 'boolean' } }, ['ok']), handler: async () => ({ ok: true }) });

const client = { release() {}, query: async (text, args) => {
  if (/v1_service_principal/.test(text)) return { rows: [{ v: args[1] === createHash('sha256').update(SECRET).digest('hex') && args.at(-1) === 'tasks.write' ? 'token' : null }] };
  if (text.includes('v1_replay')) return { rows: [{ v: null }] };
  if (text.includes('service_key_hash')) return { rows: [{ v: createHash('sha256').update(SECRET).digest('hex') }] };
  if (text.includes('current_viewer()')) return { rows: [{ id: VIEWER, actor: 'agent:synthetic' }] };
  return { rows: [] }; } };
const app = createApp({ query: async text => ({ rows: text.includes('host_org') ? [{ org_id: ORG, sign_in: 'password', status: 'active', rehearsal: false }] : [{ org_id: ORG }] }) },
  { connect: async () => client, query: async () => ({ rows: [] }) });
const notes = [];
app.addHook('onResponse', async (request, reply) => { notes.push({ status: reply.statusCode, note: requestNote(request) }); });
await app.ready();
const send = async (query, payload) => {
  const r = await app.inject({ method: 'POST', url: `/api/v1/tasks/00000000-0000-4000-8000-000000000001/refusal-note${query}`, payload,
    headers: { authorization: `Bearer ${APP}`, 'idempotency-key': ORG, 'user-agent': 'WAS-bridge/1.4 (node; secret@example.com)' } });
  return { status: r.statusCode, note: notes.at(-1).note, detail: r.json().detail };
};

test('a refused field is named on the call\'s telemetry note, with the rule that refused it and never its value', async () => {
  const extra = await send('?limit=5&since=2026-11-01T00:00:00Z', { text: 'hi' });
  assert.equal(extra.status, 400, extra.detail);
  assert.deepEqual(extra.note, { v1: 'query / additionalProperties since', client: 'WAS-bridge/1.4' });
  const range = await send('?limit=500', { text: 'hi' });
  assert.deepEqual([range.status, range.note.v1], [400, 'query /limit pattern']);
  const body = await send('', { text: 'hi', clientName: 'Rifob Mifos' });
  assert.deepEqual([body.status, body.note.v1], [400, 'body / additionalProperties clientName']);
  const deep = await send('', { text: 'hi', lines: [{ qty: 'two hundred' }] });
  assert.deepEqual([deep.status, deep.note.v1], [400, 'body /lines/0/qty type']);
  const long = await send('', { text: 'Rifob Mifos, Plot 14, Vapi' });
  assert.deepEqual([long.status, long.note.v1], [400, 'body /text maxLength']);
  const missing = await send('', {});
  assert.deepEqual([missing.status, missing.note.v1], [400, 'body / required text']);
  for (const n of notes) for (const secret of ['2026-11-01', '500', 'Rifob', 'two hundred', 'Vapi', 'secret@example.com']) {
    assert.ok(!JSON.stringify(n.note ?? {}).includes(secret), `${secret} in ${JSON.stringify(n.note)}`);
  }
  const fine = await send('?limit=5', { text: 'hi' });
  assert.deepEqual([fine.status, fine.note], [200, undefined]);
});

test('refusedField: part, path, rule and the field\'s own name, short', () => {
  assert.equal(refusedField('query', { instancePath: '', keyword: 'additionalProperties', params: { additionalProperty: 'cursor' } }), 'query / additionalProperties cursor');
  assert.equal(refusedField('params', { instancePath: '/documentId', keyword: 'pattern', params: { pattern: '^x$' } }), 'params /documentId pattern');
  assert.equal(refusedField('body'), 'body invalid');
  assert.ok(refusedField('query', { instancePath: '', keyword: 'additionalProperties', params: { additionalProperty: 'x'.repeat(300) } }).length < 80);
});

test('an unknown event type is refused with the type names on the note', async () => {
  const listEvents = v1Operations().find(op => op.operationId === 'listEvents');
  const noted = [];
  const ctx = { note: n => noted.push(n), keyScopes: async () => assert.fail('refused before any area is read') };
  await assert.rejects(listEvents.handler(ctx, { query: { types: 'quotation.created,quotation.approved,quotation.revised' } }), e => e.status === 400 || e.statusCode === 400);
  assert.deepEqual(noted, [{ v1: 'query /types unknown event type', types: 'quotation.approved,quotation.revised' }]);
});

test('every list Willow Lane\'s WAS server syncs each hour takes the platform\'s paging limit, and only 1 to 100', () => {
  const ajv = new Ajv2020({ strict: false });
  for (const id of ['listQuotations', 'listQuotes', 'listWorkflowRuns', 'listActivity', 'listEvents']) {
    const op = v1Operations().find(o => o.operationId === id);
    assert.ok(op?.query, id);
    const valid = ajv.compile(op.query);
    assert.ok(valid({ limit: '50' }), `${id} refuses limit: ${JSON.stringify(valid.errors)}`);
    for (const limit of ['0', '101', 'all']) assert.ok(!valid({ limit }), `${id} takes limit=${limit}`);
  }
  const quotations = ajv.compile(v1Operations().find(o => o.operationId === 'listQuotations').query);
  assert.ok(quotations({ status: 'draft', waiting: 'true', limit: '100' }));
  assert.ok(!quotations({ since: '2026-11-01' }), 'an unknown field is still refused');
});

test.after(() => app.close());
