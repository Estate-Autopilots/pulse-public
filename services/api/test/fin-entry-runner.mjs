// FIN-ENTRY acceptance on a disposable tenant (tests/core/test_fin_entry.py): who may add and see entries, add →
// appears in the live totals, quick add (and the /expense save seam), GST and receipt checks, the approval limit,
// edit / delete / restore with the history, the WhatsApp suggestions (confirm, set aside, back), settings.
import assert from 'node:assert/strict'; import { Pool } from 'pg'; import { writeFile } from 'node:fs/promises'; import { randomBytes } from 'node:crypto';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), owner = new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const app = createApp(pool, pool); const R = JSON.parse(process.env.TEST_ROLES); const ORG = process.env.PULSE_ORG_ID;
let checks = 0; const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; }; const ok = (v, m) => { assert.ok(v, m); checks++; };
async function call(path, body, as = 'founder') {
 const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': as + '@fin.example' }, ...(body === undefined ? {} : { payload: body }) });
 let data; try { data = r.json(); } catch { data = r.rawPayload; } return { status: r.statusCode, data, raw: r.rawPayload, type: r.headers['content-type'] };
}
async function own(sql, args = []) { const c = await owner.connect(); try { await c.query('begin'); await c.query('set local role pulse_owner'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]); const r = await c.query(sql, args); await c.query('commit'); return r.rows; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } }
const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), randomBytes(64)]).toString('base64');
const today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10), month = today.slice(0, 7);
try {
 // Who: leadership and the Finance role write; anyone else is refused and sees nothing.
 eq((await call('finance/entries', undefined, 'staff')).status, 403, 'a staff member without Finance cannot open entries');
 eq((await call('finance/entries', { kind: 'expense', amount: '100', date: today }, 'staff')).status, 403, 'nor add one');
 let r = await call('finance/entries/options', undefined, 'fin');
 eq([r.status, r.data.canWrite, r.data.canApprove], [200, true, false], 'the Finance role writes but does not approve');
 // Add → in the totals.
 const live0 = (await call('finance/live')).data;
 r = await call('finance/entries', { kind: 'expense', amount: '5,000', gst: '762.71', date: today, category: 'Ad spend', accountFrom: 'HDFC current', vendor: 'Meta', files: [{ name: 'receipt.jpg', data: JPEG }] }, 'fin');
 eq([r.status, r.data.amountMinor, r.data.gstMinor, r.data.status, r.data.files.length], [200, 500000, 76271, 'approved', 1], 'an expense with GST and a receipt photo');
 const first = r.data.id;
 const file = await call(`finance/entries/files/${r.data.files[0].id}`, undefined, 'founder');
 eq([file.status, file.type.startsWith('image/jpeg'), file.raw.length > 64], [200, true, true], 'the receipt opens');
 r = await call(`finance/entries?month=${month}`, undefined, 'founder');
 eq([r.data.totals.moneyOut, r.data.entries.length], [500000, 1], 'it is in the Entries totals for its month');
 if (live0?.model) { const m = (await call('finance/live')).data.model; ok(m.expenses.months.find((x) => x.month === month).manual >= 5000, 'and in the live model costs for that month'); eq(m.manual.moneyOut, 5000, 'marked as entered in Pulse'); }
 // Checks in plain words.
 eq((await call('finance/entries', { kind: 'expense', amount: '100', gst: '200', date: today }, 'fin')).data.error, 'GST must be a rupee figure no larger than the amount', 'GST above the amount');
 eq((await call('finance/entries', { kind: 'transfer', amount: '100', date: today, accountFrom: 'Cash', accountTo: 'Cash' }, 'fin')).status, 400, 'a transfer needs two accounts');
 eq((await call('finance/entries', { kind: 'expense', amount: '100', date: today, files: [{ name: 'x.exe', data: 'data:application/octet-stream;base64,TVqQAAMAAAAEAAAA' }] }, 'fin')).status, 400, 'a receipt must be a photo or PDF');
 // The approval limit: the Finance role above ₹50,000 waits; it does not count until leadership approves.
 r = await call('finance/entries', { kind: 'bill', amount: '80000', date: today, vendor: 'Landlord', category: 'Rent & office', dueDate: today }, 'fin');
 eq([r.data.status, r.data.billStatus], ['pending', 'unpaid'], 'a bill above the limit waits for approval');
 const big = r.data.id;
 eq((await call(`finance/entries/${big}/decide`, { decision: 'approve' }, 'fin')).status, 403, 'the Finance role cannot approve');
 eq((await call(`finance/entries?month=${month}`)).data.totals.pending, 1, 'one waiting');
 r = await call(`finance/entries/${big}/decide`, { decision: 'approve' }, 'founder');
 eq([r.status, r.data.status, r.data.decidedBy], [200, 'approved', 'Synthetic Founder'], 'leadership approves');
 eq((await call(`finance/entries?month=${month}`)).data.totals.moneyOut, 8500000, 'now it counts');
 r = await call(`finance/entries/${big}`, { kind: 'bill', amount: '90000', date: today, vendor: 'Landlord' }, 'fin');
 eq(r.data.status, 'pending', 'a changed amount above the limit goes back for approval');
 r = await call('finance/entries', { kind: 'expense', amount: '200000', date: today }, 'founder');
 eq(r.data.status, 'approved', 'leadership\'s own entry counts at once');
 // Edit, delete with a reason, restore, history.
 r = await call(`finance/entries/${first}`, { kind: 'expense', amount: '5500', date: today, category: 'Ad spend', vendor: 'Meta ads' }, 'fin');
 eq([r.data.amountMinor, r.data.vendor], [550000, 'Meta ads'], 'edited');
 eq((await call(`finance/entries/${first}/delete`, {}, 'fin')).status, 400, 'a delete needs a reason');
 eq((await call(`finance/entries/${first}/delete`, { reason: 'Duplicate of the bank line' }, 'fin')).status, 200, 'deleted with a reason');
 eq((await call(`finance/entries?status=deleted`)).data.entries.map((e) => e.id), [first], 'it is under Deleted, out of the list');
 eq((await call(`finance/entries/${first}/restore`, {}, 'fin')).data.deleted, false, 'restored');
 r = await call(`finance/entries/${first}`);
 eq(r.data.history.map((h) => h.action), ['created', 'edited', 'deleted', 'restored'], 'the history keeps every step');
 ok(r.data.history[1].changes.some((c) => c.field === 'Amount' && c.from === 500000 && c.to === 550000), 'with the amount before and after');
 const ev = await own('select count(*)::int n from pulse.fin_entry_event where entry_id=$1', [first]); eq(ev[0].n, 4, 'stored in the database');
 // Quick add and the /expense seam.
 r = await call('finance/entries/parse', { text: '₹5,000 Facebook ads 14 Apr from HDFC' }, 'fin');
 eq([r.data.amountMinor, r.data.accountFrom, r.data.category, r.data.vendor], [500000, 'HDFC current', 'Ad spend', 'Facebook ads'], 'the quick-add line is understood');
 r = await call('finance/entries/quick', { text: '/expense uber 450 yesterday', save: true, from: 'chat' }, 'fin');
 eq([r.status, r.data.saved.source, r.data.saved.amountMinor, r.data.href.startsWith('/finance?tab=entries&entry=')], [200, 'chat', 45000, true], '/expense from Chats saves and links to the entry');
 r = await call('finance/entries/quick', { text: '/expense lunch', save: true }, 'fin');
 eq([r.data.saved, r.data.parsed.missing], [null, ['amount']], 'without an amount nothing is saved; the form opens instead');
 eq((await call('finance/entries/quick', { text: '/expense 100', save: true }, 'staff')).status, 403, 'only Finance and leadership');
 // WhatsApp suggestions (rows the finance worker copies from the index).
 const sha = 'a'.repeat(64), sha2 = 'b'.repeat(64);
 await own("insert into pulse.fin_wa_screen(org_id,sha256,amount,amounts,sent_at,sender,sender_role,message_text,group_title) values($1,$2,29951.84,'{29951.84}',now()-interval '2 days','Opinem','colleague','Funds added','Pod - 2 Alidig Vamok | Bunenu Putig'),($1,$3,1200,'{1200}',now()-interval '3 days','Client','client','Paid','Pod-1 | Synthetic Client')", [ORG, sha, sha2]);
 r = await call('finance/entries/whatsapp', undefined, 'fin');
 eq([r.data.total, r.data.rows[0].suggestion.kind, r.data.rows[0].suggestion.category, r.data.rows[0].suggestion.amountMinor], [2, 'expense', 'Ad spend', 2995184], 'found in WhatsApp, with a suggested entry');
 r = await call('finance/entries', { kind: 'expense', amount: '29951.84', date: today, category: 'Ad spend', whatsapp: sha }, 'fin');
 eq([r.status, r.data.source, r.data.sourceRef], [200, 'whatsapp', sha], 'confirmed as an entry');
 eq((await call('finance/entries', { kind: 'expense', amount: '29951.84', date: today, whatsapp: sha }, 'fin')).status, 409, 'never twice');
 eq((await call(`finance/entries/whatsapp/${sha2}/dismiss`, {}, 'fin')).status, 200, 'another set aside');
 eq((await call('finance/entries/whatsapp', undefined, 'fin')).data.total, 0, 'nothing left to check');
 eq((await call('finance/entries/whatsapp?show=dismissed', undefined, 'fin')).data.total, 1, 'the set-aside one is kept');
 await call(`finance/entries/${r.data.id ?? (await own("select id from pulse.fin_entry where source_ref=$1", [sha]))[0].id}/delete`, { reason: 'Test' }, 'fin');
 eq((await call('finance/entries/whatsapp', undefined, 'fin')).data.total, 1, 'deleting its entry puts the screenshot back');
 // Settings: leadership only.
 eq((await call('finance/entries/settings', { approvalMinor: 1000000 }, 'fin')).status, 403, 'the Finance role cannot change the limit');
 r = await call('finance/entries/settings', { approvalMinor: 1000000, categories: 'Ad spend\nTravel\nClient payment', accounts: ['HDFC current', 'Cash'] }, 'founder');
 eq([r.data.approvalMinor, r.data.categories.length, r.data.accounts], [1000000, 3, ['HDFC current', 'Cash']], 'leadership sets the limit, categories and accounts');
 eq((await call('finance/entries', { kind: 'expense', amount: '15000', date: today }, 'fin')).data.status, 'pending', 'the new limit applies at once');
 await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks }));
 console.log(`fin-entry: ${checks} checks`);
} finally { await pool.end(); await owner.end(); }
