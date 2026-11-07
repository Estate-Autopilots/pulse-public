// FINANCE-TRUTH (tests/core/test_finance_truth.py): Finance → Numbers, the GST account, the account a payment arrived
// in and a salesperson's own numbers through the real routes on an isolated synthetic tenant. No browser, no live data.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const ids = JSON.parse(process.env.TEST_IDS);
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const call = async (path, body, as = 'founder') => {
  const r = await app.inject({ method: body === undefined ? 'GET' : 'POST', url: '/api/v0/' + path,
    headers: { 'cf-access-authenticated-user-email': `${as}@${ids.domain}` }, ...(body === undefined ? {} : { payload: body }) });
  return { status: r.statusCode, data: r.json() };
};
try {
  // Who: leadership and the Finance role read the numbers; a member is refused.
  eq((await call('finance/numbers', undefined, 'member')).status, 403, 'a member cannot open Finance → Numbers');
  eq((await call('finance/numbers/gst-account', { account: ids.gst }, 'fin')).status, 403, 'the Finance role does not name the GST account');
  eq((await call('finance/numbers/gst-account', { account: 'Nowhere' })).status, 400, 'only a Cash book account');
  eq((await call('finance/numbers/gst-account', { account: ids.gst })).data, { gstAccount: ids.gst }, 'leadership names it');
  let r = await call('finance/numbers?from=2026-10&to=2026-10', undefined, 'fin');
  eq([r.status, r.data.period, r.data.access.bank, r.data.totals.revenue, r.data.totals.gstBilled, r.data.outstanding.gst], [200, 'custom', false, 0, 180000, 180000],
    'the Finance role: GST billed and still due, no revenue yet, no bank lines');
  // The payment drawer knows the accounts and what is due; a GST payment into the GST account clears the GST only.
  r = await call(`erp/documents/${ids.invoice}`, undefined, 'fin');
  eq([r.data.paymentAccounts.gstAccount, r.data.due], [ids.gst, { baseDue: 1000000, gstDue: 180000 }], 'the drawer offers base and GST');
  eq((await call(`erp/documents/${ids.invoice}/payments`, { amount: 180000, receivedOn: '2026-10-05', account: ids.gst }, 'fin')).status, 200, 'GST recorded into the GST account');
  r = await call(`erp/documents/${ids.invoice}`, undefined, 'fin');
  eq([r.data.payments[0].account, r.data.due], [ids.gst, { baseDue: 1000000, gstDue: 0 }], 'kept with its account; the base is still due');
  eq((await call(`erp/payments/${r.data.payments[0].id}/account`, { account: 'HDFC current' }, 'sales')).status, 403, 'a salesperson does not change it');
  eq((await call('erp/payments/not-a-payment/account', { account: 'HDFC current' }, 'fin')).status, 400, 'a bad payment id');
  r = await call('finance/numbers?from=2026-10&to=2026-10');
  const oct = r.data.months[0];
  eq([oct.revenue, oct.gstToGstAccount, r.data.totals.baseOutstanding, r.data.totals.gstOutstanding], [0, 180000, 1000000, 0], 'GST received is not revenue; the base is outstanding');
  assert.match(r.data.sources.gst.from, /GST account/); checks++;
  assert.match(r.data.sources.revenue.from, /without the GST/); checks++;
  eq((await call('finance/numbers?period=fy')).data.period, 'fy', 'the financial year by default');
  // A salesperson's own numbers; someone else's are leadership's and Finance's.
  r = await call('sales-numbers', undefined, 'sales');
  eq([r.status, r.data.person.self, r.data.canOpenErp, r.data.period], [200, true, false, 'month'], 'their own, this month');
  eq((await call(`sales-numbers?person=${ids.founder}`, undefined, 'sales')).status, 403, 'not another person');
  eq((await call('sales-numbers?person=nobody', undefined, 'sales')).status, 400, 'a bad person id');
  r = await call(`sales-numbers?person=${ids.sales}&period=fy`);
  eq([r.status, r.data.person.self, r.data.person.id], [200, false, ids.sales], 'leadership opens the salesperson');
  eq((await call('sales-numbers', undefined, 'member')).data.quotes.count, 0, 'a person with no quotations sees zeros, not an error');
  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks }));
} finally {
  await app.close(); await pool.end();
}
