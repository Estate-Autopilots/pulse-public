// BHARATA-2: draft_quotation over API v1 (POST /api/v1/billing/quotations/from-words) on real PostgreSQL and tenant row
// security. Run by tests/core/test_bharata_draft_words.py. Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const { createApp } = await import('../dist/app.js');

const W = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 4 }), app = createApp(pool, pool);
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const token = async (email, scopes) => {
  const r = await app.inject({ method: 'POST', url: '/api/v0/api-tokens', headers: { 'cf-access-authenticated-user-email': email }, payload: { name: 'BHARATA-2 (synthetic)', scopes, days: 7 } });
  assert.equal(r.statusCode, 201, r.body); return r.json().token;
};
let T;
const words = async (payload, status = 200) => {
  const r = await app.inject({ method: 'POST', url: '/api/v1/billing/quotations/from-words', headers: { authorization: `Bearer ${T}`, 'idempotency-key': randomUUID() }, payload });
  assert.equal(r.statusCode, status, `${r.statusCode} ${r.body.slice(0, 600)}`); checks++;
  return r.json();
};
const sql = async (q, args = []) => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('pulse.org_id',$1,true), set_config('pulse.viewer_id',$2,true)", [W.org, W.founder]);
    const r = (await c.query(q, args)).rows; await c.query('commit'); return r;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
};
const codes = async (id) => (await sql(`select i.code,l.qty::float8 qty,l.rate::float8 rate,l.discount_percent::float8 disc from pulse.erp_line l left join pulse.erp_item i on i.id=l.item_id
  where l.document_id=$1 order by l.position`, [id])).map((l) => `${l.code ?? 'free'}x${l.qty}@${l.rate / 100}${l.disc ? `-${l.disc}%` : ''}`);
const drafts = async () => Number((await sql("select count(*)::int n from pulse.erp_document where doc_type='quotation'"))[0].n);
const clients = async () => Number((await sql('select count(*)::int n from pulse.client'))[0].n);

try {
  // Leadership asks for approval (the approval task goes to another approver: a Finance person here).
  T = await token(W.founderEmail, ['billing.read', 'billing.write', 'companies.read', 'companies.write']);
  const STD = [{ words: '5 kW system' }, { words: '10-year warranty' }, { words: 'installation' }, { words: 'transport', priceRupees: 2500 }];

  // 1. A new client, typed: added once, the catalogue matched (the warranty takes the system's size), transport at the
  //    stated price, the answer with lines, total and link.
  const a = await words({ client: 'TEST Mifos Traders', newClient: true, city: 'Pune', items: STD, lang: 'en' });
  eq(a.status, 'drafted'); ok(a.client.created && a.client.name === 'TEST Mifos Traders', JSON.stringify(a.client));
  eq(await codes(a.quotation.id), ['TS-5.0x1@140000', 'AO-EXW7-5.0x1@18000', 'SV-INSTALLx1@12500', 'SV-DELIVERYx1@2500']);
  ok(a.quotation.url.endsWith(`/erp/documents/${a.quotation.id}`) && a.reply.includes(a.quotation.url), a.reply);
  ok(/Draft quotation for TEST Mifos Traders \(new client, added\)/.test(a.reply) && /Total ₹[\d,]+ incl\. GST/.test(a.reply) && /Submit it for approval\?/.test(a.reply), a.reply);
  eq(a.quotation.status, 'draft'); eq(a.quotation.waitingFor, null);

  // 2. The same request again: the same draft, not a second one (and not a second client).
  const [d0, c0] = [await drafts(), await clients()];
  const again = await words({ client: 'TEST Mifos Traders', newClient: true, items: STD, lang: 'en' });
  eq(again.status, 'existing'); eq(again.quotation.id, a.quotation.id); eq([await drafts(), await clients()], [d0, c0]);
  ok(/existing draft/.test(again.reply), again.reply);

  // 3. A voice note's new client: its name is confirmed before anything is written.
  const heard = await words({ client: 'TEST Gokhale Clinic', newClient: true, items: STD, heardByVoice: true, lang: 'hi' });
  eq(heard.status, 'ask'); eq(heard.quotation, null); ok(/TEST Gokhale Clinic/.test(heard.reply) && /सही/.test(heard.reply), heard.reply);
  eq([await drafts(), await clients()], [d0, c0], 'nothing written before the name is confirmed');
  const confirmed = await words({ client: 'TEST Gokhale Clinic', newClient: true, confirmNewClient: true, items: STD, lang: 'hi' });
  eq(confirmed.status, 'drafted'); ok(confirmed.client.created, 'added once confirmed'); ok(/के लिए ड्राफ्ट कोटेशन/.test(confirmed.reply), confirmed.reply);

  // 3b. WL-FOLLOWUP (17 Nov 2026): a colleague's name is never a new client, even said "new" and confirmed (Willow Lane: a
  //     voice note "assign <colleague> a task" became a client named after the colleague and a draft quotation).
  const mateName = (await sql('select display_name n from pulse.person where id=$1', [W.founder]))[0].n;
  const [d2, c2] = [await drafts(), await clients()];
  const mate = await words({ client: mateName, newClient: true, confirmNewClient: true, items: STD, heardByVoice: true, lang: 'en' });
  eq(mate.status, 'ask'); eq(mate.quotation, null); ok(mate.reply.includes(`${mateName} is a colleague here, not a client`), mate.reply);
  eq([await drafts(), await clients()], [d2, c2], 'no client and no quotation for a colleague');

  // 4. A misheard existing client ("Desideri" for Desai Dairy), nobody said "new": that client, said so in the answer.
  const near = await words({ client: 'TEST Desideri', items: [{ words: '12 kW system' }, { words: 'installation' }, { words: 'transport', priceRupees: 6000 }], heardByVoice: true, lang: 'en' });
  eq(near.status, 'drafted'); eq(near.client.id, W.desai); ok(!near.client.created, 'no second client');
  ok(/I took “TEST Desideri” as TEST Desai Dairy/.test(near.reply), near.reply);
  eq(await codes(near.quotation.id), ['TS-12.0x1@310000', 'SV-INSTALLx1@12500', 'SV-DELIVERYx1@6000']);
  // ... and said "new": it asks which, writes nothing.
  const newNear = await words({ client: 'TEST Desideri', newClient: true, items: STD, lang: 'en' });
  eq(newNear.status, 'ask'); ok(/Did you mean TEST Desai Dairy\?/.test(newNear.reply) && /A new client named TEST Desideri/.test(newNear.reply), newNear.reply);

  // 5. Nothing guessed: an item the catalogue lacks, a size it does not sell (a misheard "1.5 kW"), no client named.
  const d1 = await drafts();
  const missing = await words({ client: 'TEST Desai Dairy', items: [{ words: '5 kW system' }, { words: 'diesel generator' }], lang: 'mr' });
  eq(missing.status, 'ask'); ok(/diesel generator/.test(missing.reply) && /किंमत/.test(missing.reply), missing.reply);
  const size = await words({ client: 'TEST Desai Dairy', items: [{ words: '1.5 kW solar system' }], lang: 'en' });
  eq(size.status, 'ask'); ok(/no 1\.5 kW option/.test(size.reply) && /TS-3\.0/.test(size.reply) && !/₹/.test(size.reply), size.reply);
  const who = await words({ items: STD, lang: 'en' });
  eq(who.status, 'ask'); ok(/Which client is this for\?/.test(who.reply), who.reply);
  eq(await drafts(), d1, 'no draft from a question');
  // ... and a price the person states for something not in the catalogue is a line of its own.
  const own = await words({ client: 'TEST Desai Dairy', items: [{ words: '3 kW system' }, { words: 'diesel generator', priceRupees: 45000, gstPercent: 18 }], lang: 'en' });
  eq(own.status, 'drafted'); eq(await codes(own.quotation.id), ['TS-3.0x1@95000', 'freex1@45000']);

  // 6. "Same as last time": the client's last approved quotation, its lines and its own prices.
  const approve = async (id) => sql('select pulse.erp_document_issue($1) r', [id]);
  await approve(near.quotation.id);
  const same = await words({ client: 'TEST Desai Dairy', sameAsLast: true, lang: 'en' });
  eq(same.status, 'drafted'); ok(same.quotation.id !== near.quotation.id, 'a new draft');
  eq(await codes(same.quotation.id), ['TS-12.0x1@310000', 'SV-INSTALLx1@12500', 'SV-DELIVERYx1@6000']);
  ok(/Same lines as /.test(same.reply), same.reply);
  const none = await words({ client: 'TEST Mifos Traders', sameAsLast: true, lang: 'en' });
  eq(none.status, 'ask'); ok(/no approved quotation yet/.test(none.reply), none.reply);

  // 7. A draft changed (two systems, a discount with its reason), then submitted for approval.
  const changed = await words({ draftId: a.quotation.id, items: [{ words: '5 kW system', qty: 2, discountPercent: 4 }, { words: '10-year warranty', qty: 2 }, { words: 'installation', qty: 2 }, { words: 'transport', priceRupees: 2500 }],
    notes: 'Repeat buyer: 4% off', lang: 'en' });
  eq(changed.status, 'updated'); eq(changed.quotation.id, a.quotation.id);
  eq(await codes(a.quotation.id), ['TS-5.0x2@140000-4%', 'AO-EXW7-5.0x2@18000', 'SV-INSTALLx2@12500', 'SV-DELIVERYx1@2500']);
  eq((await sql('select notes from pulse.erp_document where id=$1', [a.quotation.id]))[0].notes, 'Repeat buyer: 4% off');
  const sub = await words({ draftId: a.quotation.id, submit: true, lang: 'en' });
  eq(sub.status, 'submitted'); ok(typeof sub.submittedTo === 'string' && sub.reply.includes(`Submitted to ${sub.submittedTo} for approval.`), sub.reply);
  ok(!!(await sql('select task_id from pulse.erp_document where id=$1', [a.quotation.id]))[0].task_id, 'its approval task');
  const twice = await words({ draftId: a.quotation.id, submit: true, lang: 'en' });
  eq(twice.status, 'existing'); ok(/already waiting for .+ approval/.test(twice.reply), twice.reply);
  // An approved quotation is not changed here.
  await words({ draftId: near.quotation.id, items: STD }, 409);

  // 8. Fields it does not know are refused by name (the API contract stays exact).
  const bad = await app.inject({ method: 'POST', url: '/api/v1/billing/quotations/from-words', headers: { authorization: `Bearer ${T}`, 'idempotency-key': randomUUID() },
    payload: { client: 'TEST Desai Dairy', items: [{ words: '5 kW system', price: 100 }] } });
  eq(bad.statusCode, 400);
  console.log(JSON.stringify({ ok: true, checks }));
} finally { await app.close(); await pool.end(); }
