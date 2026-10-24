// FIN-ENTRY model: the one-line quick add, entry checks, how hand entries join the live totals, WhatsApp suggestions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanEntry, parseDay, parseQuick, rupees, suggestFromScreen, withManual } from '../dist/finance-entry-model.js';

const TODAY = '2026-10-22';
const ctx = { categories: ['Ad spend', 'Software & tools', 'Rent & office', 'Salaries', 'Travel', 'Client payment', 'Other'], accounts: ['HDFC current', 'ICICI current', 'Company card', 'Cash'],
 clients: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Acme Realty' }, { id: '22222222-2222-4222-8222-222222222222', name: 'Majestic Homes' }] };

test('rupees as people type them', () => {
 assert.equal(rupees('₹5,000'), 500000);
 assert.equal(rupees('Rs. 12,500.50'), 1250050);
 assert.equal(rupees('1.5k'), 150000);
 assert.equal(rupees('2 lakh'), 20000000);
 assert.equal(rupees('abc'), null);
 assert.equal(rupees('0'), null);
});

test('days without a year are the latest one not after today', () => {
 assert.equal(parseDay('14 Apr', TODAY), '2026-04-14');
 assert.equal(parseDay('Apr 14', TODAY), '2026-04-14');
 assert.equal(parseDay('14/04', TODAY), '2026-04-14');
 assert.equal(parseDay('25 Dec', TODAY), '2025-12-25');
 assert.equal(parseDay('yesterday', TODAY), '2026-10-21');
 assert.equal(parseDay('31 Feb', TODAY), null);
});

test('the owner\'s example line fills the form', () => {
 const q = parseQuick('₹5,000 Facebook ads 14 Apr from HDFC', TODAY, ctx);
 assert.equal(q.kind, 'expense'); assert.equal(q.direction, 'out');
 assert.equal(q.amountMinor, 500000); assert.equal(q.date, '2026-04-14');
 assert.equal(q.accountFrom, 'HDFC current'); assert.equal(q.category, 'Ad spend');
 assert.equal(q.vendor, 'Facebook ads'); assert.deepEqual(q.missing, []);
});

test('payments received, GST, bills with due dates, transfers, refunds', () => {
 const a = parseQuick('received 1.2 lakh from Acme into ICICI today', TODAY, ctx);
 assert.equal(a.kind, 'income'); assert.equal(a.amountMinor, 12000000); assert.equal(a.accountTo, 'ICICI current');
 assert.equal(a.clientId, ctx.clients[0].id); assert.equal(a.date, TODAY); assert.equal(a.category, 'Client payment');
 const b = parseQuick('bill 18,000 + 18% GST rent due 5 Nov', TODAY, ctx);
 assert.equal(b.kind, 'bill'); assert.equal(b.amountMinor, 2124000); assert.equal(b.gstMinor, 324000); assert.equal(b.dueDate, '2026-11-05'); assert.equal(b.category, 'Rent & office');
 const g = parseQuick('Zoom 1,180 incl 18% GST 3 Oct from company card', TODAY, ctx);
 assert.equal(g.gstMinor, 18000); assert.equal(g.accountFrom, 'Company card'); assert.equal(g.category, 'Software & tools'); assert.equal(g.date, '2026-10-03');
 const t = parseQuick('/transfer 50k from HDFC to ICICI', TODAY, ctx);
 assert.equal(t.kind, 'transfer'); assert.equal(t.direction, 'neutral'); assert.equal(t.accountFrom, 'HDFC current'); assert.equal(t.accountTo, 'ICICI current');
 const r = parseQuick('refund 2,000 from Zoom', TODAY, ctx);
 assert.equal(r.kind, 'refund'); assert.equal(r.direction, 'in'); assert.equal(r.amountMinor, 200000);
 const e = parseQuick('/expense uber 450 yesterday', TODAY, ctx);
 assert.equal(e.kind, 'expense'); assert.equal(e.amountMinor, 45000); assert.equal(e.date, '2026-10-21'); assert.equal(e.category, 'Travel');
 assert.deepEqual(parseQuick('lunch with team', TODAY, ctx).missing, ['amount']);
});

test('entry checks say what is wrong in plain words', () => {
 assert.throws(() => cleanEntry({ kind: 'gift', amount: '10' }, TODAY), /Choose what this is/);
 assert.throws(() => cleanEntry({ kind: 'expense', amount: '' , date: TODAY }, TODAY), /Give the amount/);
 assert.throws(() => cleanEntry({ kind: 'expense', amount: '100', gst: '200', date: TODAY }, TODAY), /GST/);
 assert.throws(() => cleanEntry({ kind: 'transfer', amount: '100', date: TODAY, accountFrom: 'Cash', accountTo: 'Cash' }, TODAY), /two different accounts/);
 assert.throws(() => cleanEntry({ kind: 'expense', amount: '100', date: '2027-03-01' }, TODAY), /more than a month ahead/);
 const ok = cleanEntry({ kind: 'refund', direction: 'out', amount: '1,000', date: '14 Apr' }, TODAY);
 assert.equal(ok.direction, 'out'); assert.equal(ok.amountMinor, 100000); assert.equal(ok.date, '2026-04-14');
});

test('approved hand entries join the month totals; pending, deleted and transfers do not', () => {
 const model = { asOf: TODAY, expenses: { months: [{ month: '2026-09', total: 100000, byCategory: { 'Ad spend': 60000, Rent: 40000 }, basis: 'Monthly cost sheet', confidence: 'medium' }], categories: [{ category: 'Ad spend', total: 60000 }] },
  revenue: { months: [{ month: '2026-09', invoiced: 200000, invoicedGross: 236000, invoices: 3, collected: 150000, collectedLines: 4, collectedBasis: 'Bank lines', revenue: 200000, revenueBasis: 'Invoices', confidence: 'high' }] },
  timeline: [{ month: '2026-09', label: 'Sep 2026', events: [] }] };
 const base = { gstMinor: 0, currency: 'INR', accountFrom: null, accountTo: null, clientId: null, projectId: null, vendor: 'Meta', note: null, billStatus: null, dueDate: null, source: 'manual', deleted: false, status: 'approved' };
 const entries = [
  { ...base, id: 'a', kind: 'expense', direction: 'out', date: '2026-09-14', amountMinor: 500000, category: 'Ad spend' },
  { ...base, id: 'b', kind: 'income', direction: 'in', date: '2026-09-20', amountMinor: 1000000, category: 'Client payment' },
  { ...base, id: 'c', kind: 'expense', direction: 'out', date: '2026-10-02', amountMinor: 250000, category: 'Travel' },
  { ...base, id: 'd', kind: 'expense', direction: 'out', date: '2026-09-15', amountMinor: 9900000, category: 'Ad spend', status: 'pending' },
  { ...base, id: 'e', kind: 'expense', direction: 'out', date: '2026-09-15', amountMinor: 7700000, category: 'Ad spend', deleted: true },
  { ...base, id: 'f', kind: 'transfer', direction: 'neutral', date: '2026-09-16', amountMinor: 5000000, category: null },
  { ...base, id: 'g', kind: 'refund', direction: 'in', date: '2026-09-17', amountMinor: 100000, category: 'Ad spend' },
 ];
 const m = withManual(model, entries);
 const sep = m.expenses.months.find((x) => x.month === '2026-09');
 assert.equal(sep.total, 100000 + 5000 - 1000); assert.equal(sep.byCategory['Ad spend'], 60000 + 5000 - 1000); assert.equal(sep.manual, 4000);
 assert.match(sep.basis, /entered in Pulse/);
 const oct = m.expenses.months.find((x) => x.month === '2026-10');
 assert.equal(oct.total, 2500); assert.equal(m.expenses.months.at(-1).month, '2026-10');
 assert.equal(m.revenue.months[0].collected, 150000 + 10000); assert.equal(m.revenue.months[0].revenue, 200000, 'revenue (invoiced) stays as it was');
 assert.equal(m.manual.count, 5); assert.equal(m.manual.pending, 1);
 assert.equal(m.timeline[0].events.filter((e) => e.kind === 'manual').length, 4);
 assert.equal(model.expenses.months[0].total, 100000, 'the stored model is not changed');
 assert.equal(withManual(null, entries), null);
});

test('a WhatsApp ads top-up becomes a suggested Ad spend expense for the group\'s client', () => {
 const s = suggestFromScreen({ amount: 29951.84, payee: null, sentAt: '2026-10-09T07:17:00Z', senderRole: 'colleague', messageText: 'Funds added in ads manager', groupTitle: 'Pod - 2 Alidig Vamok | Bunenu Putig | Dhayari | Dec 2025 | Mid-R', clientHint: null, datesInText: [] }, TODAY, ctx.categories);
 assert.equal(s.kind, 'expense'); assert.equal(s.amountMinor, 2995184); assert.equal(s.category, 'Ad spend'); assert.equal(s.date, '2026-10-09'); assert.equal(s.client, 'Alidig Vamok');
 const c = suggestFromScreen({ amount: 50000, payee: null, sentAt: '2026-09-28T09:51:00Z', senderRole: 'client', messageText: 'Payment done', groupTitle: 'Pod-1 | Puratog Pizunol | Mr. Pudor Sosukek', clientHint: 'Pudor Sosukek', datesInText: ['27 Sep 2026'] }, TODAY, ctx.categories);
 assert.equal(c.kind, 'income'); assert.equal(c.date, '2026-09-27'); assert.equal(c.client, 'Pudor Sosukek');
});
