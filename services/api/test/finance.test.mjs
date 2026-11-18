import {test} from 'node:test';
import assert from 'node:assert/strict';
import {financeWorkspace} from '../dist/finance.js';
const row=(id,data,approved=true,dataset='money_sheet_transactions')=>({id,dataset,approved,data});
test('Cash totals exclude unreconciled receipts and separate currencies',()=>{
 const d=financeWorkspace([row('a',{date:'2026-09-01',direction:'outflow',currency:'INR',amount:'300',category:'Office'}),row('b',{date:'2026-09-01',direction:'outflow',currency:'INR',amount:'999'},false),row('c',{date:'2026-09-01',direction:'outflow',currency:'INR',amount:'300'},true,'money_gmail_receipts'),row('d',{date:'2026-09-01',direction:'inflow',currency:'USD',amount:'5'})],'2026-10-05');
 assert.equal(d.trends.find(t=>t.currency==='INR').months[0].outflow,300);assert.equal(d.trends.find(t=>t.currency==='USD').months[0].inflow,5);assert.equal(d.counts.pending,1);
 assert.equal(d.proposals[0].amount,100);assert.match(d.proposals[0].basis,/2026-07, 2026-08, 2026-09/);
});
test('Renewals budget adds all known renewals while inferred contracts remain outside it',()=>{
 const d=financeWorkspace([row('a',{tool:'Synthetic one',last_charge_date:'2026-10-01',last_charge_amount:'300',cycle:'monthly',currency:'INR'},false,'subscriptions'),row('b',{tool:'Synthetic two',renewal_date:'2026-11-01',amount:'200',currency:'INR',seats:'2',used_seats:'0'},false,'subscriptions'),row('c',{tool:'Synthetic three',renewal_date:'2026-11-01',amount:'100',currency:'INR'},false,'subscriptions')],'2026-10-05');
 assert.equal(d.subscriptions.find(s=>s.id==='b').costPerSeat,100);assert.equal(d.subscriptions.find(s=>s.id==='b').unused,true);assert.equal(d.subscriptions.find(s=>s.id==='a').unused,null);
 assert.equal(d.proposals[0].amount,300);
});
test('Runway needs verified balance and three complete months',()=>{
 const rows=['07','08','09'].map(m=>row(m,{date:`2026-${m}-01`,direction:'outflow',currency:'INR',amount:'100',category:'Office'}));
 const b={currency:'INR',amount:500,as_of:'2026-10-05',history_reconciled:true};
 assert.equal(financeWorkspace(rows,'2026-10-05',[b]).runways[0].months,5);assert.equal(financeWorkspace(rows,'2026-10-05',[{...b,history_reconciled:false}]).runways[0].months,null);
 assert.equal(financeWorkspace(rows.slice(1),'2026-10-05',[b]).runways[0].months,null);
});
test('Monthly plans contribute without invented dates or duplicate receipt charges',()=>{
 const plan={planned_monthly_cost:'120',planned_currency:'INR',planned_cadence:'monthly',planned_source:'Kazuk Tools sheet',cycle:'monthly',seats:2};
 const d=financeWorkspace([
  row('a',{...plan,last_charge_amount:'20',currency:'USD',renewal_date:'2026-11-01'},false,'subscriptions'),
  row('b',{...plan,last_charge_amount:'',category:'Office'},false,'recurring'),
  row('c',{...plan,active_now:'inactive'},false,'subscriptions'),
 ],'2026-10-06');
 assert.equal(d.subscriptions.find(r=>r.id==='a').observedAmount,20);
 assert.equal(d.subscriptions.find(r=>r.id==='a').plannedMonthlyCost,120);
 assert.equal(d.subscriptions.find(r=>r.id==='a').costPerSeat,60);
 assert.equal(d.subscriptions.find(r=>r.id==='b').amount,120);
 assert.equal(d.subscriptions.find(r=>r.id==='b').renewal,null);
 assert.equal(d.subscriptions.find(r=>r.id==='b').usage,null);
 assert.deepEqual(d.proposals.map(p=>[p.category,p.currency,p.amount]).sort(),[['Office','INR',120],['Subscriptions','INR',120]]);
 assert.equal(d.counts.ledger,0);
});
