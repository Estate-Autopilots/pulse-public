// ARTHA-FIX (17 Nov 2026, migration 2275): a Finance AI employee's tools over /api/v1/mcp on real PostgreSQL and row
// security (driven by tests/core/test_artha_fix.py): with the Finance role it reads the ledger, the Money records and the
// finance numbers, imports a bank statement someone attached in its group (preview, then confirm; repeats skipped), and a
// doc it writes in the group is shared with the group's people. Without the role the same calls are refused. Run from the
// repository root (the statement parser is tools/statement-parse.py). Synthetic people, accounts and figures only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const { TEST_KEY: key, TEST_KEY_PLAIN: plainKey, TEST_CHAT: chat, TEST_OTHER_CHAT: otherChat, TEST_FILE: file, TEST_PEOPLE: people } = process.env;
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 3 });
const app = createApp(pool, pool);
for (const level of ['info', 'warn', 'error']) app.log[level] = () => {};
app.log.child = () => app.log;

/** One JSON-RPC call, as services/coworker/pulse-tools.mjs mcpCall sends it (a JSON or an SSE answer). */
async function mcp(bearer, method, params = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/mcp', payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });
  let j = null;
  try { j = JSON.parse(r.body); } catch {
    const data = r.body.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean).at(-1);
    j = data ? JSON.parse(data) : null;
  }
  return { status: r.statusCode, j };
}
const tool = async (bearer, name, args = {}) => {
  const { status, j } = await mcp(bearer, 'tools/call', { name, arguments: args });
  assert.equal(status, 200, `${name}: ${JSON.stringify(j)}`);
  const text = (j?.result?.content ?? []).map(c => c.text).join('');
  let data = j?.result?.structuredContent ?? null;
  if (!data && text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { error: !!j?.result?.isError, data, text };
};
const ok = async (bearer, name, args) => { const r = await tool(bearer, name, args); assert.equal(r.error, false, `${name}: ${r.text}`); return r.data; };

try {
  const listed = await mcp(key, 'tools/list');
  assert.equal(listed.status, 200, JSON.stringify(listed.j));
  const names = new Set((listed.j?.result?.tools ?? []).map(t => t.name));
  for (const n of ['list_finance_entries', 'get_finance_numbers', 'list_money_records', 'import_bank_statement', 'create_doc']) assert.ok(names.has(n), `${n} is listed`);

  // The ledger and the numbers (the refusal the Finance AI employee met: "Finance entries are for leadership and the Finance role").
  const entries = await ok(key, 'list_finance_entries', {});
  assert.ok(Array.isArray(entries.items));
  const numbers = await ok(key, 'get_finance_numbers', { from: '2026-04', to: '2026-07' });
  assert.equal(numbers.months.length, 4); assert.equal(typeof numbers.totals.gstBilled, 'number'); assert.ok(numbers.notes.length > 0);
  // AI-FIX (BC-015): each paise figure is also said as people read it; counts (paidInvoices, payments) are not money.
  const said = (p) => `${p < 0 ? '-' : ''}₹${(Math.abs(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  for (const m of numbers.months) {
    assert.equal(m.inRupees.revenue, said(m.revenue), `${m.month}: revenue in rupees`); assert.equal(m.inRupees.gstBilled, said(m.gstBilled));
    assert.ok(!('paidInvoices' in m.inRupees) && !('payments' in m.inRupees), 'counts are not said as rupees');
  }
  assert.equal(numbers.totalsInRupees.gstBilled, said(numbers.totals.gstBilled)); assert.equal(numbers.totalsInRupees.net, said(numbers.totals.net));
  assert.equal(numbers.outstanding.baseRupees, said(numbers.outstanding.base)); assert.equal(numbers.outstanding.gstRupees, said(numbers.outstanding.gst));
  for (const c of numbers.categories) assert.equal(c.netRupees, said(c.net));

  // A statement attached in the group: preview first (nothing kept), then confirm; the same file again adds nothing.
  const preview = await ok(key, 'import_bank_statement', { fileId: file, sourceType: 'bank', accountAlias: 'Synthetic current', accountLast4: '4321' });
  assert.equal(preview.previewed, true); assert.equal(preview.saved, 0);
  assert.deepEqual([preview.summary.rows, preview.summary.from, preview.summary.to, preview.summary.inflowPaise, preview.summary.outflowPaise], [2, '2026-07-01', '2026-07-03', 2360000, 118000]);
  assert.deepEqual([preview.summary.inflowRupees, preview.summary.outflowRupees], ['₹23,600', '₹1,180'], 'the paise totals said in rupees (BC-015)');
  assert.equal((await ok(key, 'list_money_records', { dataset: 'bank' })).total, 0, 'a preview keeps nothing');
  const saved = await ok(key, 'import_bank_statement', { fileId: file, sourceType: 'bank', accountAlias: 'Synthetic current', accountLast4: '4321', confirm: true });
  assert.equal(saved.previewed, false); assert.equal(saved.saved, 2);
  const again = await ok(key, 'import_bank_statement', { fileId: file, sourceType: 'bank', accountLast4: '4321', confirm: true });
  assert.equal(again.saved, 0, 'repeated lines are skipped');
  const money = await ok(key, 'list_money_records', { dataset: 'bank' });
  assert.equal(money.total, 2);
  assert.deepEqual(money.rows.map(r => [r.date, r.amount, r.direction]).sort(), [['2026-07-01', 1180, 'outflow'], ['2026-07-03', 23600, 'inflow']]);

  // A doc written in the group is shared with the group's people; the address opens it beside the chat.
  const made = await ok(key, 'create_doc', { title: 'Synthetic finance checklist', markdown: '## Statements\n- July 2026', shareWithChat: chat });
  assert.match(made.openBeside, /^\/docs\/[0-9a-f-]{36}$/);
  assert.equal(made.doc.access, 'people');
  assert.deepEqual(made.doc.sharedWith.map(s => s.personId).sort(), JSON.parse(people).sort());
  assert.ok(made.doc.sharedWith.every(s => s.canEdit));
  const elsewhere = await tool(key, 'create_doc', { title: 'Synthetic', markdown: 'x', shareWithChat: otherChat });
  assert.equal(elsewhere.error, true, 'only a chat it is in');
  const own = await ok(key, 'create_doc', { title: 'Synthetic private note', markdown: 'x' });
  assert.equal(own.doc.access, 'private', 'without a chat a doc stays private');

  // Without the Finance role the same AI tools are refused (an AI employee holds no role by default).
  for (const [n, args] of [['list_finance_entries', {}], ['list_money_records', { dataset: 'bank' }], ['get_finance_numbers', {}],
    ['import_bank_statement', { fileId: file, sourceType: 'bank', preview: true }]]) {
    const r = await tool(plainKey, n, args);
    assert.equal(r.error, true, `${n} without the Finance role: ${r.text}`);
  }
  console.log('artha-fix runner: ok');
} finally {
  await app.close().catch(() => {});
  await pool.end();
}
