// EST-2811: "Sign in with Pulse" (OAuth 2.1 + PKCE, rotation, replay revocation) and the people/admin operations over
// HTTP and MCP, on real tenant RLS with synthetic people only. Run by tests/core/test_api_v1_people.py.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { testMail } from '../dist/auth-mail.js';

const w = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 2 }), app = createApp(pool, pool);
const REDIRECT = 'https://claude.example/api/mcp/auth_callback';
const b64 = b => Buffer.from(b).toString('base64url');
const json = r => { try { return r.json(); } catch { return r.body; } };

async function register(name = 'Synthetic Claude', method) {
  const r = await app.inject({ method: 'POST', url: '/api/v0/oauth/register', payload: { client_name: name, redirect_uris: [REDIRECT], ...(method ? { token_endpoint_auth_method: method } : {}) } });
  assert.equal(r.statusCode, 201, r.body); return r.json();
}
/** One full browser round: consent facts, approval and the code, as the person signed in through Access. */
async function code(client, email, scope) {
  const verifier = b64(randomBytes(32)), challenge = createHash('sha256').update(verifier).digest('base64url');
  const ask = { client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', ...(scope ? { scope } : {}) };
  const headers = { 'cf-access-authenticated-user-email': email };
  const facts = await app.inject({ url: '/api/v0/oauth/authorize?' + new URLSearchParams(ask), headers });
  assert.equal(facts.statusCode, 200, facts.body); assert.equal(facts.json().app.name, client.client_name); assert.equal(facts.json().returnsTo, 'claude.example');
  const decided = await app.inject({ method: 'POST', url: '/api/v0/oauth/authorize', headers, payload: { ...ask, approve: true } });
  assert.equal(decided.statusCode, 200, decided.body);
  const back = new URL(decided.json().redirect); assert.equal(back.origin + back.pathname, REDIRECT); assert.equal(back.searchParams.get('state'), 'st8');
  return { code: back.searchParams.get('code'), verifier };
}
const basic = c => 'Basic ' + Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64');
const token = (c, payload) => app.inject({ method: 'POST', url: '/api/v0/oauth/token', headers: c.client_secret ? { authorization: basic(c) } : {}, payload: { ...payload, ...(c.client_secret ? {} : { client_id: c.client_id }) } });
async function connect(c, email, scope) {
  const { code: value, verifier } = await code(c, email, scope);
  const r = await token(c, { grant_type: 'authorization_code', code: value, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(r.statusCode, 200, r.body); assert.match(r.headers['cache-control'], /no-store/);
  return { ...r.json(), code: value, verifier };
}
const api = (t, url, payload, method = payload ? 'POST' : 'GET') => app.inject({ method, url, headers: { authorization: `Bearer ${t}`, ...(payload ? { 'idempotency-key': crypto.randomUUID() } : {}) }, ...(payload ? { payload } : {}) });
const rpcHeaders = t => ({ authorization: `Bearer ${t}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' });
async function rpc(t, method, params = {}, extra = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { ...rpcHeaders(t), ...extra }, payload: { jsonrpc: '2.0', id: 1, method, params } });
  if (r.statusCode !== 200) return { status: r.statusCode, value: json(r) };
  const value = r.body.split('\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5))).find(v => v.id === 1);
  return { status: 200, value: value.result ?? value };
}

try {
  // ---------------------------------------------------------------- registration rules
  for (const bad of [{ client_name: 'Pulse', redirect_uris: [REDIRECT] }, { client_name: 'X', redirect_uris: ['http://evil.example/cb'] },
    { client_name: 'X', redirect_uris: ['https://a.example/cb#frag'] }, { client_name: 'X', redirect_uris: [REDIRECT], grant_types: ['client_credentials'] }]) {
    const r = await app.inject({ method: 'POST', url: '/api/v0/oauth/register', payload: bad });
    assert.equal(r.statusCode, 400, JSON.stringify(bad)); assert.match(r.json().error, /^invalid_/);
  }
  const claude = await register(), cli = await register('Synthetic CLI', 'none');
  assert.match(claude.client_secret, /^pcs_/); assert.equal(cli.client_secret, undefined);
  // A client that never registered, or a return address it did not register, is a screen error (never a redirect).
  const stranger = await app.inject({ url: '/api/v0/oauth/authorize?' + new URLSearchParams({ client_id: claude.client_id, redirect_uri: 'https://evil.example/cb', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' }), headers: { 'cf-access-authenticated-user-email': w.hrEmail } });
  assert.equal(stranger.statusCode, 400); assert.equal(stranger.json().redirect, undefined);
  assert.equal((await app.inject({ url: '/api/v0/oauth/authorize?client_id=' + claude.client_id })).statusCode, 401, 'consent needs a Pulse sign-in');

  // ---------------------------------------------------------------- code, PKCE, replay and rotation
  const first = await code(claude, w.hrEmail);
  assert.equal((await token(claude, { grant_type: 'authorization_code', code: first.code, code_verifier: b64(randomBytes(32)), redirect_uri: REDIRECT })).json().error, 'invalid_grant', 'wrong verifier');
  assert.equal((await token(claude, { grant_type: 'authorization_code', code: first.code, code_verifier: first.verifier, redirect_uri: REDIRECT })).json().error, 'invalid_grant', 'a code works once, even after a failed try');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v0/oauth/token', headers: { authorization: 'Basic ' + Buffer.from(claude.client_id + ':wrong').toString('base64') }, payload: { grant_type: 'refresh_token', refresh_token: 'prt_x' } })).statusCode, 401);
  const replayed = await connect(claude, w.hrEmail);
  assert.equal((await api(replayed.access_token, '/api/v1/people/me')).statusCode, 200);
  assert.equal((await token(claude, { grant_type: 'authorization_code', code: replayed.code, code_verifier: replayed.verifier, redirect_uri: REDIRECT })).json().error, 'invalid_grant');
  assert.equal((await api(replayed.access_token, '/api/v1/people/me')).statusCode, 401, 'a replayed code ends the connection it made');
  const hr = await connect(claude, w.hrEmail);
  const rotated = await token(claude, { grant_type: 'refresh_token', refresh_token: hr.refresh_token });
  assert.equal(rotated.statusCode, 200, rotated.body); assert.notEqual(rotated.json().refresh_token, hr.refresh_token);
  const hrToken = rotated.json().access_token;
  assert.equal((await api(hr.access_token, '/api/v1/people/me')).statusCode, 200, 'the earlier access token lives out its hour');

  // ---------------------------------------------------------------- HR operations as HR, through the app
  const me = (await api(hrToken, '/api/v1/people/me')).json();
  assert.equal(me.id, w.hr); assert.ok(me.roles.includes('hr')); assert.equal(me.app, 'Synthetic Claude');
  const found = (await api(hrToken, '/api/v1/people?query=editor%20one')).json().items;
  assert.deepEqual(found.map(p => p.id), [w.editor]);
  const fix = await api(hrToken, `/api/v1/people/${w.editor}/corrections`, { field: 'joinedOn', value: '2026-08-01', reason: 'Offer letter says 1 August' });
  assert.equal(fix.statusCode, 200, fix.body); assert.equal(fix.json().changed, true); assert.equal(fix.json().to, '2026-08-01');
  const again = (await api(hrToken, `/api/v1/people/${w.editor}/corrections`, { field: 'joinedOn', value: '2026-08-01', reason: 'Offer letter says 1 August' })).json();
  assert.equal(again.changed, false);
  const card = (await api(hrToken, `/api/v1/people/${w.editor}`)).json();
  assert.equal(card.person.joinedOn, '2026-08-01');
  assert.deepEqual({ ...card.changes[0], at: undefined }, { field: 'joinedOn', from: null, to: '2026-08-01', by: 'Project Lead', reason: 'Offer letter says 1 August', via: 'Synthetic Claude', at: undefined });
  assert.equal((await api(hrToken, `/api/v1/people/${w.editor}/corrections`, { field: 'managerId', value: w.editor, reason: 'Loop test only' })).statusCode, 400, 'no reporting loops');
  assert.equal((await api(hrToken, `/api/v1/people/${w.editor}/corrections`, { field: 'joinedOn', value: '2026-08-01', reason: 'no' })).statusCode, 400, 'a reason is required');
  const undo = await api(hrToken, `/api/v1/people/me/changes/${fix.json().changeId}/undo`, {});
  assert.equal(undo.statusCode, 200, undo.body); assert.equal(undo.json().status, 'undone');
  assert.equal((await api(hrToken, `/api/v1/people/${w.editor}`)).json().person.joinedOn, null);
  const mine = (await api(hrToken, '/api/v1/people/me/changes')).json().items;
  assert.equal(mine[0].status, 'undone'); assert.equal(mine[0].app, 'Synthetic Claude');

  const email = await api(hrToken, `/api/v1/people/${w.editor}/corrections`, { field: 'workEmail', value: 'Editor.One@Synthetic.example', reason: 'Work mailbox created' });
  assert.equal(email.json().to, 'editor.one@synthetic.example');
  const sent = testMail.length;
  const otp = await api(hrToken, `/api/v1/people/${w.editor}/one-time-password`, {});
  assert.equal(otp.statusCode, 200, otp.body); assert.equal(otp.json().to, 'ed•••@synthetic.example'); assert.equal(JSON.stringify(otp.json()).includes('password":'), false);
  const mail = testMail.at(-1); assert.equal(testMail.length, sent + 1); assert.equal(mail.to, 'editor.one@synthetic.example');
  assert.match(mail.body, /One-time password: [A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}/);
  assert.equal((await api(hrToken, `/api/v1/people/${w.editor}/sign-in-email`, { kind: 'invite' })).statusCode, 200);
  assert.equal(testMail.length, sent + 2);

  const roster = await api(hrToken, '/api/v1/people/onboarding?stuck=true');
  assert.equal(roster.statusCode, 200, roster.body); assert.ok(roster.json().items.every(i => i.stuck.length > 0));
  const group = await api(hrToken, '/api/v1/chats/groups', { name: 'Synthetic everyone', allActiveStaff: true });
  assert.equal(group.statusCode, 200, group.body); assert.ok(group.json().members >= 4);
  const removed = (await api(hrToken, `/api/v1/chats/groups/${group.json().groupId}/members`, { remove: [w.editor2] })).json();
  assert.deepEqual(removed.removed, [w.editor2]);
  assert.equal((await api(hrToken, `/api/v1/people/me/changes/${removed.changeId}/undo`, {})).statusCode, 200);
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [w.org, w.hr]);
    assert.equal((await c.query('select 1 from pulse.chat_member where channel_id=$1 and person_id=$2', [group.json().groupId, w.editor2])).rowCount, 1, 'undo puts the member back');
  } finally { await c.query('rollback'); c.release(); }

  // ---------------------------------------------------------------- staff see only their own tools
  const editor = await connect(cli, w.editorEmail, 'people.read people.write search.read chats.write');
  assert.equal(editor.scope, 'people.read people.write search.read chats.write');
  for (const [url, body] of [[`/api/v1/people/${w.hr}/corrections`, { field: 'department', value: 'Ops', reason: 'Trying as staff' }],
    [`/api/v1/people/${w.hr}/one-time-password`, {}], ['/api/v1/people/onboarding', null]])
    assert.equal((await api(editor.access_token, url, body ?? undefined)).statusCode, 403, url);
  assert.equal((await api(editor.access_token, '/api/v1/events/bug-reports')).statusCode, 403, 'events.read was never granted');
  assert.equal((await api(editor.access_token, `/api/v1/people/${w.hr}`)).json().person.phone, null, 'phones are HR\'s');
  const staffTools = (await rpc(editor.access_token, 'tools/list')).value.tools.map(t => t.name).sort();
  assert.deepEqual(staffTools, ['change_group_members', 'create_group', 'fetch', 'get_person', 'list_my_changes', 'search', 'search_people', 'undo_change', 'whoami']);

  // ---------------------------------------------------------------- MCP as HR: annotations, flat arguments, replay
  const init = await rpc(hrToken, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } });
  assert.match(init.value.instructions, /undone for 7 days/);
  const tools = Object.fromEntries((await rpc(hrToken, 'tools/list')).value.tools.map(t => [t.name, t]));
  for (const name of ['whoami', 'search', 'fetch', 'search_people', 'get_person', 'list_onboarding', 'correct_person_field', 'issue_one_time_password', 'send_sign_in_email', 'create_group', 'list_my_changes', 'undo_change'])
    assert.ok(tools[name], name);
  assert.deepEqual(tools.issue_one_time_password.annotations, { title: 'Issue a one-time password', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  assert.equal(tools.search.annotations.readOnlyHint, true); assert.equal(tools.correct_person_field.inputSchema.properties.requestId.minLength, 8);
  assert.deepEqual(tools.correct_person_field.inputSchema.required.sort(), ['field', 'personId', 'reason', 'value']);
  const args = { personId: w.editor, field: 'department', value: 'Post production', reason: 'Moved teams in October', requestId: 'synthetic-dept-1' };
  const once = await rpc(hrToken, 'tools/call', { name: 'correct_person_field', arguments: args });
  const twice = await rpc(hrToken, 'tools/call', { name: 'correct_person_field', arguments: args });
  assert.equal(once.value.isError, undefined, JSON.stringify(once.value)); assert.deepEqual(twice.value.structuredContent, once.value.structuredContent, 'the same requestId replays');
  assert.equal((await rpc(hrToken, 'tools/call', { name: 'correct_person_field', arguments: { ...args, value: 'Other' } })).value._meta.httpStatus, 409);
  assert.equal((await rpc(hrToken, 'tools/call', { name: 'correct_person_field', arguments: { ...args, surprise: 1 } })).value._meta.httpStatus, 400);
  const results = (await rpc(hrToken, 'tools/call', { name: 'search', arguments: { query: 'editor one' } })).value.structuredContent.results;
  assert.equal(results[0].id, 'person:' + w.editor); assert.match(results[0].url, /\/people\//);
  const doc = (await rpc(hrToken, 'tools/call', { name: 'fetch', arguments: { id: results[0].id } })).value.structuredContent;
  assert.equal(JSON.parse(doc.text).department, 'Post production'); assert.equal(doc.metadata.kind, 'person');

  // ---------------------------------------------------------------- revocation
  const r = await app.inject({ method: 'POST', url: '/api/v0/oauth/revoke', headers: { authorization: basic(claude) }, payload: { token: rotated.json().refresh_token } });
  assert.equal(r.statusCode, 200);
  assert.equal((await api(hrToken, '/api/v1/people/me')).statusCode, 401, 'revoking the refresh token ends the connection');
  const reuse = await token(claude, { grant_type: 'refresh_token', refresh_token: hr.refresh_token });
  assert.equal(reuse.json().error, 'invalid_grant');
  console.log('OAuth + people/admin operations: consent, PKCE, replay, rotation, revocation, HR/staff split, MCP annotations and replay, undo pass');
} finally { await app.close(); await pool.end(); }
