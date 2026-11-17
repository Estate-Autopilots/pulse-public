// AGREEMENTS round 14 Nov (2091) through the API (tests/core/test_agreements_offers.py): HR drafts an offer, a founder
// approves and sends it; People → Agreements lists it with where it stands (no amounts) for HR and founders only; the
// person it is for (an active member: someone new added in Pulse is active; a candidate not yet in Pulse uses the link) finds it in the acceptance view as their letter's key terms, a partial or reordered tick list is refused, the
// full one accepts it in Pulse, and the signed copy of the letter is theirs to open. Synthetic people and figures only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { chmod, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool), R = JSON.parse(process.env.TEST_ROLES);
const keyFile = join(process.env.TEST_KEY_DIR, 'document-master.key');
await writeFile(keyFile, `comp-2026-11 ${randomBytes(32).toString('base64')}\n`, { mode: 0o600 }); await chmod(keyFile, 0o600); process.env.PULSE_DOCUMENT_KEY_FILE = keyFile;
const call = async (path, body, as = 'hr', raw = false) => {
  const r = await app.inject({ url: path.startsWith('/') ? path : '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': `${as}@comp.example` }, ...(body === undefined ? {} : { payload: body }) });
  if (raw) return { status: r.statusCode, body: r.rawPayload, type: r.headers['content-type'] };
  let data; try { data = r.json(); } catch { data = r.body; } return { status: r.statusCode, data };
};
try {
  const today = (await call('comp/people')).data.today;
  const offer = { person: R.person, role: 'Synthetic editor', startOn: today, payType: 'salary', figures: { monthly: 42000 }, probationDays: 90, noticeDays: 15, terms: 'Synthetic terms of work.' };
  const id = (await call('comp/offers', offer)).data.id; assert.ok(id, 'HR drafts the offer');
  assert.equal((await call(`comp/offers/${id}/propose`, {})).status, 200);
  assert.ok((await call(`comp/offers/${id}/decide`, { action: 'approve' }, 'founder')).data.letterId, 'a founder approves; the letter is filed');
  let ws = await call('agreements/people');
  assert.equal(ws.status, 200, JSON.stringify(ws.data));
  assert.deepEqual(ws.data.offers.map((o) => [o.name, o.status, o.role]), [['Synthetic Person', 'approved', 'Synthetic editor']]);
  assert.ok(!JSON.stringify(ws.data).includes('4200000'), 'no amounts in People → Agreements');
  assert.equal((await call('agreements/people', undefined, 'other')).status, 403, 'a member sees no offers');
  const before = await call('agreements/policies?due=1', undefined, 'person');
  assert.equal(before.status, 200, JSON.stringify(before.data));
  assert.deepEqual(before.data.due.filter((d) => d.type === 'offer'), [], 'nothing waits before it is sent');
  assert.equal((await call(`comp/offers/${id}/send`, { link: false }, 'founder2')).status, 200, 'a founder sends it (no link: answered in Pulse)');
  ws = await call('agreements/people', undefined, 'founder');
  assert.equal(ws.data.offers[0].status, 'sent'); assert.ok(ws.data.offers[0].sentAt);
  // The person's acceptance view: the letter's words as key terms.
  const sent = await call('agreements/policies?due=1', undefined, 'person');
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const due = sent.data.due.filter((d) => d.type === 'offer');
  assert.equal(due.length, 1, 'the offer waits for the person');
  const o = due[0];
  assert.equal(o.id, id); assert.equal(o.title, 'Offer of employment'); assert.equal(o.letter, undefined, 'the letter itself stays on the server');
  assert.deepEqual(o.terms.map((t) => t.title), ['Your role and start date', 'Your pay', 'Probation and notice', 'Other terms']);
  assert.match(o.terms[0].text, /role of Synthetic editor/); assert.match(o.terms[1].text, /₹42,000 a month/); assert.match(o.terms[1].text, /\| Part \| Pay \|/); assert.match(o.terms[1].text, /\*\*Total\*\* \| \*\*₹42,000 a month · ₹[\d,]+ a year\*\*/);
  assert.equal(o.terms[3].text, 'Synthetic terms of work.'); assert.match(o.closing.text, /open until/);
  const keys = o.terms.map((t) => t.key);
  assert.equal((await call(`agreements/offers/${id}/accept`, { terms: keys.slice(1) }, 'person')).status, 409, 'every term');
  assert.equal((await call(`agreements/offers/${id}/accept`, { terms: [...keys].reverse() }, 'person')).status, 409, 'in order');
  assert.equal((await call(`agreements/offers/${id}/accept`, { terms: keys }, 'other')).status, 404, 'only the person it is for');
  const ok = await call(`agreements/offers/${id}/accept`, { terms: keys }, 'person');
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.via, 'steps'); assert.ok(ok.data.letterId);
  assert.equal((await call(`agreements/offers/${id}/accept`, { terms: keys }, 'person')).status, 404, 'answered once');
  assert.deepEqual((await call('agreements/policies?due=1', undefined, 'person')).data.due.filter((d) => d.type === 'offer'), []);
  // The pay in force is the accepted offer; the signed copy is the person's to open.
  const page = (await call(`comp/people/${R.person}`)).data;
  assert.equal(page.inForce?.figures?.monthly, 4200000);
  const pdf = await call(`/api/v0/comp/letters/${ok.data.letterId}/pdf`, undefined, 'person', true);
  assert.equal(pdf.status, 200); assert.match(String(pdf.type), /pdf/); assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
  ws = await call('agreements/people');
  assert.deepEqual([ws.data.offers[0].status, ws.data.offers[0].answerVia, ws.data.offers[0].signedLetterId], ['accepted', 'pulse', ok.data.letterId]);
  // The signed copy is in the person's HR documents (Documents → Letters made in Pulse), for HR and for the person; names
  // and dates only, never an amount; anyone else gets an empty list.
  const docs = await call(`agreements/people/${R.person}/letters`);
  assert.equal(docs.status, 200, JSON.stringify(docs.data));
  assert.ok(docs.data.letters.some((l) => l.id === ok.data.letterId && l.kind === 'offer'), 'HR sees the signed copy');
  assert.ok(!JSON.stringify(docs.data).includes('4200000') && !JSON.stringify(docs.data).includes('42,000'), 'no amounts in the list');
  assert.ok((await call(`agreements/people/${R.person}/letters`, undefined, 'person')).data.letters.some((l) => l.id === ok.data.letterId), 'the person sees it');
  assert.deepEqual((await call(`agreements/people/${R.person}/letters`, undefined, 'other')).data, { letters: [] }, 'someone else sees none');
  console.log('agreements-offer-runner: passed');
} catch (e) {
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
