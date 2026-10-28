// CONNECT acceptance (0953, services/api/src/connect.ts): client connections between organisations on one Pulse.
// An organisation's leader sends a client request (pre-filled) → the client opens the link signed out, makes a Pulse
// account and sets up their organisation from it → both organisations see the connection, the referral is recorded,
// each side's contact has a seat in the other → a group with the client and a task for them → the client sees the group
// in their own Chats ("with …"), opens the shared space, replies and finishes the task → the inviter sees it; and back:
// the client gives a task to the inviter's contact. Isolation: the client's seat sees only what was shared.
//
// Against a running API (pulse-dev): CONNECT_BASE=http://127.0.0.1:3203 CONNECT_OWNER=user-668d21b6@estateautopilots.com node …
// In the core suite (tests/core/test_connect.py): the built app with the synthetic world (TEST_* variables).
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const BASE = process.env.CONNECT_BASE ?? null;
let app = null, pool = null, OWNER;
if (BASE) OWNER = process.env.CONNECT_OWNER ?? 'user-668d21b6@estateautopilots.com';
else {
  const { Pool } = await import('pg'); const { createApp } = await import('../dist/app.js');
  pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); app = createApp(pool, pool);
  const P = JSON.parse(process.env.TEST_PEOPLE); OWNER = `${process.env.CONNECT_OWNER_KEY ?? 'kedab'}@${process.env.TEST_DOMAIN}`; void P;
}
const run = Date.now().toString(36).slice(-5);
const PASSWORD = 'Connect-test-pass-9';
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
/** who: 'owner' (Access identity), { token } a session, or null (signed out). */
const call = async (who, url, payload, method = payload ? 'POST' : 'GET') => {
  const headers = { 'x-pulse-client-ip': `10.9.${run.length}.${checks % 250}`, 'user-agent': 'connect-runner Chrome on Linux', ...(payload ? { 'content-type': 'application/json' } : {}) };
  if (who === 'owner') headers['cf-access-authenticated-user-email'] = OWNER;
  else if (who?.token) headers['x-pulse-session'] = who.token;
  if (app) { const r = await app.inject({ url, method, headers, ...(payload ? { payload } : {}) }); return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body }; }
  const r = await fetch(BASE + url, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  const text = await r.text(); let data = text; try { data = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, data };
};
const must = async (who, url, payload) => { const r = await call(who, url, payload); assert.equal(r.status, 200, `${JSON.stringify(who)?.slice(0, 40)} ${url}: ${JSON.stringify(r.data).slice(0, 500)}`); checks++; return r.data; };
const refused = async (who, url, payload, status) => { const r = await call(who, url, payload); eq(r.status, status, `${url} should answer ${status}: ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
const tokenOf = (link) => new URL(link).hash.slice(1);
const report = { run, checks: 0 };

try {
  // ------------------------------------------------------------------------------------------- the inviting side
  let mine = await must('owner', '/api/v0/connections');
  ok(mine.canInvite, 'the owner may send client requests');
  const company = `Synthetic Skyline ${run}`;
  const made = await must('owner', '/api/v0/connections/requests', { company, contact: 'Rila Testwala', email: `rila.${run}@example.test`, phone: '+91 90000 00000',
    project: 'Website and lead capture', summary: 'Closed 23 Oct: 3-month retainer, website + lead capture, weekly calls.' });
  ok(/\/invited#[A-Za-z0-9_-]{43}$/.test(made.link), `a client link: ${made.link}`);
  eq(made.email.sent, false, 'nothing is e-mailed'); ok(made.email.body.includes(made.link), 'the e-mail preview carries the link');
  const token = tokenOf(made.link);
  mine = await must('owner', '/api/v0/connections');
  ok(mine.requests.some((q) => q.id === made.id && q.status === 'open'), 'the request waits in the list');

  // A person without the right is refused; a bad link is a 404 signed out.
  await refused(null, '/api/v0/auth/connect-peek', { token: 'x'.repeat(43) }, 404);
  const peek = await must(null, '/api/v0/auth/connect-peek', { token });
  eq([peek.company, peek.contact, peek.project], [company, 'Rila Testwala', 'Website and lead capture'], 'the link shows the pre-filled details');
  ok(peek.from && peek.poc, 'and who invites, with their point of contact');

  // ------------------------------------------------------------------------------------------- the client accepts
  await refused(null, '/api/v0/auth/connect-join', { token, name: 'Rila Testwala', handle: `rila${run}`, password: 'short', mode: 'new' }, 400);
  const joined = await must(null, '/api/v0/auth/connect-join', { token, name: 'Rila Testwala', handle: `rila${run}`, email: `rila.${run}@example.test`, password: PASSWORD,
    mode: 'new', orgName: company, orgHandle: `skyline${run}` });
  // CLIENT-PORTAL (1020): a client's link lands them in the inviter's client space; their own new organisation is in
  // their account, and the rest of this flow runs from there.
  ok(joined.newOrg && joined.token && joined.home === '/client', `the client's organisation is set up and they land in the client space: ${JSON.stringify(joined).slice(0, 200)}`);
  const own = (await must({ token: joined.token }, '/api/v0/account')).orgs.find((o) => o.kind === 'staff' && o.name === company);
  ok(own, 'their own organisation is in their account');
  const client = { token: (await must({ token: joined.token }, '/api/v0/account/switch', { org: own.id })).token }; const clientOrg = own.id;
  await refused(null, '/api/v0/auth/connect-join', { token, name: 'Someone Else', handle: `else${run}`, password: PASSWORD, mode: 'individual' }, 400); // used once
  await refused(null, '/api/v0/auth/connect-peek', { token }, 404);

  // Both organisations see the connection and each other's contacts.
  const theirView = (await must(client, '/api/v0/connections')).connections;
  eq(theirView.length, 1, 'the client sees one connection');
  const cc = theirView[0];
  ok(!cc.weInvited && cc.other.name === peek.from, 'with the organisation that invited them');
  ok(cc.theirs.length === 1 && cc.ours.length === 1 && cc.ours[0].me, 'their contact is seated here, and the client is seated there');
  mine = await must('owner', '/api/v0/connections');
  const conn = mine.connections.find((c) => c.other.org === clientOrg);
  ok(conn && conn.weInvited && conn.other.name === company, 'the inviter sees the client organisation');
  ok(conn.theirs.length === 1 && conn.theirs[0].name === 'Rila Testwala', 'with the client contact seated in the inviter');
  ok(mine.requests.find((q) => q.id === made.id).status === 'accepted', 'the request is accepted');
  const seat = conn.theirs[0].person;

  // ------------------------------------------------------------------------------------------- shared work
  const group = await must('owner', `/api/v0/connections/${conn.id}/groups`, { name: `${company} · launch`, memberIds: [seat] });
  await refused('owner', `/api/v0/connections/${conn.id}/groups`, { name: 'Team only', memberIds: [mine.team[0]?.id ?? seat].filter((x) => x !== seat) }, 400);
  await must('owner', `/api/v0/chats/${group.id}/messages`, { body: `Welcome aboard, Rila! (${run})`, clientId: crypto.randomUUID() });
  const task = await must('owner', `/api/v0/connections/${conn.id}/tasks`, { title: `Share the brand assets ${run}`, assigneeId: seat, notes: 'Logo, colours, fonts' });
  await refused('owner', `/api/v0/connections/${conn.id}/tasks`, { title: 'Not theirs', assigneeId: mine.me }, 400);
  await refused('owner', `/api/v0/connections/00000000-0000-4000-8000-000000000000/tasks`, { title: 'Nowhere', assigneeId: seat }, 404);

  // The client sees the group in their own organisation's Chats, from the other organisation.
  const elsewhere = (await must(client, '/api/v0/connections/shared-chats')).chats;
  ok(elsewhere.some((s) => s.ref === group.id && s.hostOrg === conn.other.org || s.ref === group.id), 'the group is listed in the client\'s own Chats');
  // AUTH-UNIFY (1291): a switch moves the session it is sent with, so the seat opens in a second sign-in (another browser).
  const second = { token: (await must(null, '/api/v0/auth/account-sign-in', { login: `rila${run}`, password: PASSWORD })).token };
  const inEA = await must(second, '/api/v0/account/switch', { org: cc.other.org });
  const seatSession = { token: inEA.token };
  eq(inEA.kind, 'client', 'the client opens the shared space as a client');
  const chats = await must(seatSession, '/api/v0/chats');
  const row = chats.channels.find((c) => c.id === group.id);
  ok(row && row.withOrg === peek.from, `the group says "with ${peek.from}": ${JSON.stringify(row)?.slice(0, 200)}`);
  const msgs = await must(seatSession, `/api/v0/chats/${group.id}/messages`);
  ok(JSON.stringify(msgs).includes(`Welcome aboard, Rila! (${run})`), 'the client reads the inviter\'s message');
  await must(seatSession, `/api/v0/chats/${group.id}/messages`, { body: `Thanks! Sending the assets today. (${run})`, clientId: crypto.randomUUID() });
  const t = await must(seatSession, `/api/v0/tasks/${task.id}`);
  ok(JSON.stringify(t).includes(`Share the brand assets ${run}`), 'the client opens the task given to them');
  const moved = await must(seatSession, `/api/v0/tasks/${task.id}/move`, { status: 'done', note: 'Uploaded to the group' });
  ok(['done', 'in_review'].includes(moved.status), `the client finishes it: ${moved.status}`);

  // Isolation: the seat sees only what was shared.
  for (const url of ['/api/v0/people', '/api/v0/connections', '/api/v0/clients', '/api/v0/finance']) {
    const r = await call(seatSession, url); ok(r.status === 403 || r.status === 404, `${url} is closed to the client seat (${r.status})`);
  }
  const list = await must(seatSession, '/api/v0/chats');
  ok(list.channels.every((c) => c.id === group.id || c.kind === 'direct'), `the seat's chat list holds only the shared group: ${list.channels.map((c) => c.name).join(', ')}`);

  // The inviter sees the reply and the finished task.
  mine = await must('owner', '/api/v0/connections');
  const after = mine.connections.find((c) => c.id === conn.id);
  const sharedTask = after.shared.find((s) => s.ref === task.id), sharedGroup = after.shared.find((s) => s.ref === group.id);
  ok(['done', 'in_review'].includes(sharedTask?.status), `the inviter sees the task done: ${sharedTask?.status}`);
  ok(sharedGroup?.last?.includes('Sending the assets today'), `and the client's reply: ${sharedGroup?.last}`);

  // ------------------------------------------------------------------------------------------- and back
  const theirs = (await must(client, '/api/v0/connections')).connections[0];
  const back = await must(client, `/api/v0/connections/${theirs.id}/tasks`, { title: `Send the signed proposal ${run}`, assigneeId: theirs.theirs[0].person });
  mine = await must('owner', '/api/v0/connections');
  const reverse = mine.connections.find((c) => c.id === conn.id).shared.find((s) => s.ref === back.id);
  ok(reverse && !reverse.here && reverse.hostName === company, 'the inviter\'s contact sees the client\'s task to them, in the client organisation');

  // ------------------------------------------------------------------------------------------- CONNECT 2 (FEATURES-1024)
  // The inviter's ordinary Create form offers the client's contact and gives them work through the connection.
  const opts = await must('owner', '/api/v0/work/options');
  const contactOpt = opts.people.find((p) => p.connectionId === conn.id);
  ok(contactOpt && contactOpt.org === company, `the client's contact is in Who does it, with their organisation: ${JSON.stringify(contactOpt)?.slice(0, 160)}`);
  const viaForm = await must('owner', '/api/v0/work/tasks', { title: `Approve the floor plan ${run}`, assigneeId: contactOpt.id });
  ok(viaForm.assigned && viaForm.connection?.id === conn.id, `Create gives it at once, through the connection: ${JSON.stringify(viaForm).slice(0, 200)}`);
  mine = await must('owner', '/api/v0/connections');
  ok(mine.connections.find((c) => c.id === conn.id).shared.some((s) => s.ref === viaForm.id), 'and it is shared with the client');
  // Ending it: gone on both sides, the client's seat leaves the shared group, and it cannot be ended twice.
  await must('owner', `/api/v0/connections/${conn.id}/end`, {});
  ok(!(await must('owner', '/api/v0/connections')).connections.some((c) => c.id === conn.id), 'ended: gone from the inviter');
  ok(!(await must(client, '/api/v0/connections')).connections.some((c) => c.id === theirs.id), 'ended: gone from the client');
  const gone = await call(seatSession, `/api/v0/chats/${group.id}/messages`);
  ok(gone.status !== 200 || !JSON.stringify(gone.data).includes('Welcome aboard'), `the seat no longer reads the shared group (${gone.status})`);
  await refused('owner', `/api/v0/connections/${conn.id}/end`, {}, 404);

  report.connection = conn.id; report.clientOrg = clientOrg; report.group = group.id; report.task = task.id;
  report.checks = checks; report.ok = true;
  console.log(JSON.stringify(report));
} finally {
  const out = process.env.CONNECT_REPORT ?? process.env.TEST_REPORT; if (out) await writeFile(out, JSON.stringify({ ...report, checks }));
  await pool?.end();
}
