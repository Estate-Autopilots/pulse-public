// SELLER-ONBOARD: a people intake's cards confirmed through the API, on a disposable tenant with synthetic people only
// (tests/core/test_people_intake.py builds it and checks the database afterwards). Mail goes to the in-memory sink
// (PULSE_CI=1); nothing is sent anywhere. Prints one JSON line: { checks, group }.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { testMail } from '../dist/auth-mail.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const T = JSON.parse(process.env.TEST_IDS);
let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const ok = (v, label) => { assert.ok(v, label); checks++; };
async function call(path, body, who) {
  const r = await app.inject({ url: `/api/v0/${path}`, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': `${who}@people.example` }, ...(body === undefined ? {} : { payload: body }) });
  let data; try { data = r.json(); } catch { data = r.body; }
  return { status: r.statusCode, data };
}

try {
  // 1. The card: each row as People has it now, for whoever may confirm.
  let r = await call(`people-intake/batches/${T.corrected}`, undefined, 'owner');
  eq(r.status, 200, `the card reads: ${JSON.stringify(r.data)}`);
  const card = r.data;
  eq([card.state, card.canDecide, card.intake.groupName], ['preview', true, 'Synthetic sales team'], 'an approver may confirm it');
  const row = Object.fromEntries(card.rows.map((x) => [x.name, x]));
  eq([row['Ruvin Synthetic'].action, row['Ruvin Synthetic'].manager?.name], ['add', 'Synthetic Director'], 'a new person, their manager found in People');
  eq([row['Synthetic Existing'].action, row['Synthetic Existing'].match?.how, row['Synthetic Existing'].manager?.row], ['update', 'phone', 1], 'someone already in People found by number; their manager is row 1');
  eq(row['Amit Synthetic'].action, 'add', 'someone not active is still kept');
  ok(row['Amit Synthetic'].problems.some((p) => p.code === 'inactive'), 'and it says so');
  eq((await call(`people-intake/batches/${T.corrected}`, undefined, 'outsider')).status, 404, 'someone outside the chat does not see the list');
  eq((await call(`people-intake/batches/${T.corrected}/confirm`, {}, 'outsider')).status, 403, 'nor confirm it');
  eq((await call(`people-intake/batches/${T.list}/confirm`, {}, 'owner')).status, 409, 'a list a corrected copy replaced cannot be confirmed');
  eq((await call(`people-intake/batches/${T.list}`, undefined, 'owner')).data.state, 'superseded', 'it says it was replaced');

  // 2. Confirmed: People's own add and edit, the group with its first steps pinned, the testers, the invitations.
  r = await call(`people-intake/batches/${T.corrected}/confirm`, { skip: [] }, 'owner');
  eq(r.status, 200, `confirm: ${JSON.stringify(r.data)}`);
  const res = r.data;
  eq([res.added, res.updated, res.skipped], [2, 1, 0], 'two added, one updated');
  ok(res.group?.id && !res.groupNote, 'the group is made');
  eq(res.testers, { label: 'Sales App', count: 1, sent: true }, 'only the active person with a Gmail on Android goes on the testers list');
  eq(res.alreadyIn, 1, 'the person who already signs in is not invited again');
  eq(res.invites.people.map((x) => [x.name, x.mailed]), [['Ruvin Synthetic', false]], 'one invitation: mail is off here, so a private link');
  ok(res.invites.people[0].link.includes('/login/set-password#'), 'the set-password link');
  ok(res.invites.people[0].whatsapp.startsWith('https://wa.me/919876543210?text=Hello%20Ruvin'), 'ready to send on WhatsApp to their number');
  eq((await call(`people-intake/batches/${T.corrected}/confirm`, {}, 'owner')).status, 409, 'a list is added once');
  const after = (await call(`people-intake/batches/${T.corrected}`, undefined, 'collector')).data;
  eq([after.state, after.decidedBy, after.result.invites.links, 'people' in after.result.invites], ['applied', 'Synthetic Owner', 1, false], 'the card says who added them; links are never kept');

  // 3. The other page, confirmed by the other approver (who now runs the group too), with mail on: mailed.
  process.env.PULSE_GMAIL_SEND_ENABLED = '1'; process.env.RESEND_API_KEY = 'synthetic-test-key';
  r = await call(`people-intake/batches/${T.page2}/confirm`, {}, 'collector');
  eq([r.status, r.data.added, r.data.group?.id, r.data.groupNote], [200, 1, res.group.id, null], `the second page joins the same group: ${JSON.stringify(r.data)}`);
  eq(r.data.invites.people.map((x) => [x.name, x.mailed]), [['Neha Synthetic', true]], 'mailed this time');
  ok(testMail.some((m) => m.to === 'user-3acecfdd@gmail.com' && /Set your Pulse password: https:\/\/[^\s]+\/login\/set-password#/.test(m.body)), 'with the set-password link');
  delete process.env.PULSE_GMAIL_SEND_ENABLED; delete process.env.RESEND_API_KEY;

  // 4. Set aside.
  eq((await call(`people-intake/batches/${T.doc}/dismiss`, {}, 'outsider')).status, 403, 'only an approver sets a list aside');
  eq((await call(`people-intake/batches/${T.doc}/dismiss`, {}, 'collector')).status, 200, 'an approver does');
  eq((await call(`people-intake/batches/${T.doc}`, undefined, 'owner')).data.state, 'dismissed', 'and the card says so');
  eq((await call(`people-intake/batches/${T.doc}/confirm`, {}, 'owner')).status, 409, 'a list set aside is not added');

  // 5. The company's intakes, for its admins.
  r = await call('people-intake', undefined, 'owner');
  eq([r.status, r.data.intakes.length, r.data.intakes[0].groupName], [200, 1, 'Synthetic sales team'], 'listed');
  eq((await call('people-intake', undefined, 'outsider')).status, 403, 'not for everyone');
  console.log(JSON.stringify({ checks, group: res.group.id }));
} finally {
  await app.close();
  await pool.end();
}
