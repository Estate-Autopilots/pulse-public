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

  // ------------------------------------------------------------------------------------------------ QUOTE-FAST (18 Nov 2026)
  // Willow Lane: "quotation for 5 kW" for a named client took 24 minutes to reach the seller as a PDF. Here the AI employee's
  // runtime key asks in the Finance person's direct chat with it (the runtime names the chat and who asked).
  const A = W.agentKey;
  const as = async (token, method, url, payload, status = 200) => {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }, ...(payload ? { payload } : {}) });
    assert.equal(r.statusCode, status, `${method} ${url}: ${r.statusCode} ${r.body.slice(0, 600)}`); checks++; return r.json();
  };
  const person = async (email, method, url, payload, status = 200) => {
    const r = await app.inject({ method, url, headers: { 'cf-access-authenticated-user-email': email }, ...(payload ? { payload } : {}) });
    assert.equal(r.statusCode, status, `${method} ${url}: ${r.statusCode} ${r.body.slice(0, 600)}`); checks++; return r.json();
  };
  const sqlAs = async (viewer, q, args = []) => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('pulse.org_id',$1,true), set_config('pulse.viewer_id',$2,true)", [W.org, viewer]);
      const r = (await c.query(q, args)).rows; await c.query('commit'); return r;
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  };
  const posted = async () => sqlAs(W.finance, `select m.id,m.author_id::text author,m.body,m.attachments from pulse.chat_message m where m.channel_id=$1 and jsonb_array_length(m.attachments)>0 order by m.created_at`, [W.dm]);
  const chat = { chatId: W.dm, askedById: W.finance };

  // 9. Submitted at once (a known client, catalogue prices: no "Submit it for approval?"), and the answer says the PDF comes here.
  const t0 = Date.now();
  const fast = await as(A, 'POST', '/api/v1/billing/quotations/from-words', { client: 'TEST Desai Dairy', items: [{ words: '5 kW system' }], ...chat, lang: 'en' });
  eq(fast.status, 'submitted'); ok(!/Submit it for approval\?/.test(fast.reply) && /I will post the PDF here as soon as it is approved\.$/.test(fast.reply), fast.reply);
  const qid = fast.quotation.id;
  eq((await sql('select approval_to::text t from pulse.erp_document where id=$1', [qid]))[0].t, W.founder, 'its approver: the founder');
  // ... its approver is pinged (needs you, not a quiet "for your information") and the bell offers Approve.
  const notice = (await sqlAs(W.founder, "select priority,quiet from pulse.notification where person_id=$1 and event_type='billing.approval' and subject_id=$2", [W.founder, qid]))[0];
  eq(notice, { priority: 'needs_you', quiet: false });
  const bell = await person(W.founderEmail, 'GET', '/api/v0/notices');
  const card = bell.rows.find((x) => x.eventType === 'billing.approval' && x.subjectId === qid);
  ok(card && card.group === 'action' && card.actions[0]?.key === 'approve' && card.actions[0].path === `/api/v0/erp/documents/${qid}/issue`, JSON.stringify(card));
  // ... nothing in the chat while it is a draft, and a draft asked for is not posted.
  eq((await posted()).length, 0);
  eq(await as(A, 'POST', `/api/v1/billing/quotations/${qid}/to-chat`, { chatId: W.dm }), { status: 'draft', posted: 0 });
  // The one tap: the PDF is in the seller's chat, from the AI employee, with one line naming who approved it.
  await person(W.founderEmail, 'POST', card.actions[0].path, card.actions[0].body);
  const [pdf] = await posted();
  const num = (await sql('select number from pulse.erp_document where id=$1', [qid]))[0].number;
  ok(pdf && pdf.author === W.agent && pdf.attachments.length === 1 && pdf.attachments[0].mime === 'application/pdf' && /\.pdf$/.test(pdf.attachments[0].name), JSON.stringify(pdf));
  ok(pdf.body.startsWith(`${num} for TEST Desai Dairy is approved by Neha Founder: ₹`) && pdf.body.endsWith('Here is the PDF.'), pdf.body);
  const file = (await sqlAs(W.finance, 'select name,mime,octet_length(bytes) n,substring(bytes from 1 for 4) head from pulse.chat_file_read($1)', [pdf.attachments[0].id]))[0];
  ok(file && file.mime === 'application/pdf' && file.n > 1000 && Buffer.from(file.head).toString() === '%PDF', JSON.stringify({ ...file, head: null }));
  ok(Date.now() - t0 < 30000, `asked to PDF in ${Date.now() - t0} ms`);
  ok((await sql("select count(*)::int n from pulse.erp_event where subject_id=$1 and kind='pdf_to_chat'", [qid]))[0].n === 1, 'the trail says where the PDF went');
  const told = (await sqlAs(W.finance, "select count(*)::int n from pulse.notification where person_id=$1 and message_id=$2", [W.finance, pdf.id]))[0].n;
  eq(told, 1, 'the seller is notified of the PDF');
  // 10. Asked again ("give me the final quotation"): posted once per revision here, not again within minutes; never by a
  //     person's key, never into a chat the AI employee is not in.
  eq(await as(A, 'POST', `/api/v1/billing/quotations/${qid}/to-chat`, { chatId: W.dm }), { status: 'issued', posted: 0 });
  await as(A, 'POST', `/api/v1/billing/quotations/${qid}/to-chat`, { chatId: W.elsewhere }, 403);
  await as(T, 'POST', `/api/v1/billing/quotations/${qid}/to-chat`, { chatId: W.dm }, 403);
  // A person's own chat with the AI employee is not one the model can name: the runtime fills chatId, and a person's key is ignored.
  const mine = await words({ client: 'TEST Desai Dairy', items: [{ words: '3 kW system' }], ...chat, lang: 'en' });
  eq(mine.status, 'drafted', 'a person drafting is not submitted for them');

  // 10b. An AI employee that cannot give the approver a task (standard access): the draft stays, with the offer, as before.
  const plain = await as(W.plainKey, 'POST', '/api/v1/billing/quotations/from-words', { client: 'TEST Desai Dairy', items: [{ words: '5 kW system' }, { words: 'installation' }],
    chatId: W.plainDm, askedById: W.finance, lang: 'en' });
  eq(plain.status, 'drafted'); eq(plain.quotation.status, 'draft'); ok(/Submit it for approval\?$/.test(plain.reply), plain.reply);

  // 11. The company's rule (off by default; leadership or an admin only; its change kept in the trail).
  await assert.rejects(sqlAs(W.finance, 'update pulse.erp_settings set quote_auto_approve=true,quote_auto_limit=20000000'), /Only leadership or an admin/); checks++;
  await sql('update pulse.erp_settings set quote_approval=true,quote_auto_approve=true,quote_auto_limit=20000000');
  ok((await sql("select actor::text a,detail from pulse.erp_event where subject_type='settings' and kind='quote_auto_approve' order by at desc limit 1"))[0]?.a === W.founder, 'who switched it on');
  const ruled = await as(A, 'POST', '/api/v1/billing/quotations/from-words', { client: 'TEST Desai Dairy', items: [{ words: '3 kW system' }, { words: 'installation' }], ...chat, lang: 'en' });
  eq(ruled.status, 'approved'); ok(!!ruled.quotation.number && ruled.quotation.status === 'issued' && ruled.pdfInChat === true, JSON.stringify(ruled.quotation));
  ok(/Approved at once by the company's rule \(catalogue prices, no discount, up to ₹2,00,000\)\. The PDF is in this chat\.$/.test(ruled.reply), ruled.reply);
  const trail = (await sql('select kind,actor::text a from pulse.erp_event where subject_id=$1 order by at', [ruled.quotation.id])).map((e) => e.kind);
  ok(trail.includes('issued') && trail.includes('approved_by_rule') && trail.includes('pdf_to_chat'), trail.join(','));
  const last = (await posted()).at(-1);
  ok(last.body.startsWith(`${ruled.quotation.number} for TEST Desai Dairy is approved: ₹`), last.body);
  // ... not over the limit, not a discount, not a price of its own, not the AI deciding by any other door.
  const big = await as(A, 'POST', '/api/v1/billing/quotations/from-words', { client: 'TEST Desai Dairy', items: [{ words: '12 kW system' }], ...chat, lang: 'en' });
  eq(big.status, 'submitted'); eq(big.quotation.status, 'draft');
  const off = await as(A, 'POST', '/api/v1/billing/quotations/from-words', { client: 'TEST Desai Dairy', items: [{ words: '3 kW system', discountPercent: 2 }], ...chat, lang: 'en' });
  eq(off.quotation.status, 'draft'); ok(off.status !== 'approved', off.status);
  await as(A, 'POST', `/api/v1/billing/quotations/${off.quotation.id}/approve`, { confirm: true }, 403);
  await assert.rejects(sqlAs(W.agent, 'select pulse.erp_document_issue($1)', [off.quotation.id]), /approv|Billing|leadership/i); checks++;
  const justDraft = await as(A, 'POST', '/api/v1/billing/quotations/from-words', { client: 'TEST Desai Dairy', items: [{ words: '5 kW system' }, { words: 'ACDB' }], submit: false, ...chat, lang: 'en' });
  eq(justDraft.status, 'drafted'); eq(justDraft.quotation.status, 'draft');
  await sql('update pulse.erp_settings set quote_approval=false,quote_auto_approve=false');

  console.log(JSON.stringify({ ok: true, checks }));
} finally { await app.close(); await pool.end(); }
