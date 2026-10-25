import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {Pool} from 'pg';import {writeFile} from 'node:fs/promises';import {createApp} from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),app=createApp(pool,pool);let checks=0;const receipts=[];
function eq(a,b,label){checks++;assert.deepEqual(a,b,label);receipts.push({check:label,result:'pass'});}
async function call(path,payload,role='leadership'){const r=await app.inject({url:'/api/v0/finance'+path,method:payload?'POST':'GET',headers:{'cf-access-authenticated-user-email':role+'@round10.example'},...(payload?{payload}:{})});return {status:r.statusCode,data:r.json()};}
const digest='a'.repeat(64),base={vintage:'synthetic-v1',currency:'INR',scale:2,direction:'outflow',account:digest,party:'vendor:synthetic',partyConfirmed:true,cashDate:'2026-03-10',invoiceDate:'2026-03-01',serviceFrom:'2026-03-01',serviceTo:'2026-03-31',dateBasis:'Source posting date',documentBasis:'Synthetic evidence receipt',label:'Synthetic source'};
async function source(key,kind,minor,extra={}){const payload={...base,externalKey:key,kind,minor,...extra};const r=await call('/source',payload);eq(r.status,200,key+' source prepared');return {id:r.data.id,payload};}
const link=(s,role,minor)=>({sourceId:s.id,role,minor});
async function match(links,treatment='payment',requestKey=crypto.randomUUID()){const payload={links,treatment,reason:'Synthetic reviewed allocation',requestKey};const r=await call('/match/accept',payload);eq(r.status,200,'atomic conserved allocation');return {id:r.data.id,payload};}
for(const role of ['person','admin','foreign'])for(const [path,payload] of [['',null],['/source',{}],['/document',{kind:'budget'}],['/match/preview',{}],['/match/accept',{}],['/auto/preview',{}],['/close',{}]]){const r=await call(path,payload,role);eq(r.status,403,role+' finance boundary '+path);}
eq((await call('')).status,200,'leadership authorized workspace');
const bank=await source('bank-12000','cash',1200000),sheet=await source('sheet-12000','bill',1200000),receipt=await source('receipt-12000','receipt',1200000);
const expense=await match([link(bank,'cash',1200000),link(sheet,'obligation',1200000),link(receipt,'evidence',1200000)]);
eq((await call('/source',bank.payload)).data.id,bank.id,'reimport returns immutable observation');
eq((await call('/source',{...bank.payload,minor:1199999})).status,409,'same-vintage conflicting payload rejected');
eq((await call('/match/accept',expense.payload)).data.id,expense.id,'manual decision replay retains receipt');
eq((await call('/match/accept',{...expense.payload,requestKey:crypto.randomUUID()})).status,400,'allocated cash cannot be consumed twice');
const invoice=await source('invoice-10000','invoice',1000000,{direction:'inflow'}),pay1=await source('payment-4000','cash',400000,{direction:'inflow'}),pay2=await source('payment-6000','cash',600000,{direction:'inflow'});
await match([link(pay1,'cash',400000),link(invoice,'obligation',400000)]);await match([link(pay2,'cash',600000),link(invoice,'obligation',600000)]);
const gw=await source('gateway-9800','cash',980000,{direction:'inflow'}),sale=await source('gateway-invoice-10000','invoice',1000000,{direction:'inflow'}),fee=await source('gateway-fee-200','fee',20000);
eq((await call('/match/preview',{links:[link(gw,'cash',980000),link(sale,'obligation',1000000)],reason:'Synthetic missing fee'})).status,400,'missing documented fee blocks allocation');await match([link(gw,'cash',980000),link(sale,'obligation',1000000),link(fee,'fee',20000)]);
const usd=await source('usd-receipt','receipt',100,{currency:'USD'});eq((await call('/match/preview',{links:[link(gw,'cash',980000),link(usd,'evidence',100)],reason:'Cross currency'})).status,400,'cross currency blocked');
const t1=await source('transfer-out','cash',50000),t2=await source('transfer-in','cash',50000,{account:'b'.repeat(64),direction:'inflow'});await match([link(t1,'cash',50000),link(t2,'cash',50000)],'transfer');
const payroll=await source('payroll-batch','payroll',300000,{aggregateApproved:true}),salaryBank=await source('payroll-aggregate-settlement','cash',300000);await match([link(salaryBank,'cash',300000),link(payroll,'obligation',300000)]);
eq((await call('/source',{...base,externalKey:'private',kind:'payroll',minor:100,aggregateApproved:true,employeeSalary:'PRIVATE'})).status,400,'individual payroll details rejected');
const concurrent=await source('concurrent-cash','cash',10000),cBill=await source('concurrent-bill','bill',10000);
const outcomes=await Promise.all([1,2].map(()=>call('/match/accept',{links:[link(concurrent,'cash',10000),link(cBill,'obligation',10000)],reason:'Concurrent acceptance',requestKey:crypto.randomUUID()})));
eq(outcomes.filter(r=>r.status===200).length,1,'concurrent acceptance allows exactly one allocation');
const period={kind:'period',account:digest,currency:'INR',scale:2,month:'2026-03',opening:5000000,closing:5370000,complete:true,statementBasis:'Synthetic complete statement'};
// Main account: 1,980,000 in and 1,560,000 out including transfer = +420,000.
period.closing=5420000;
eq((await call('/document',{...period,opening:null})).status,200,'missing opening retained explicitly');eq((await call('/close',{month:'2026-03',currency:'INR',scale:2,reason:'Synthetic attempt'})).status,400,'missing opening prevents close');
eq((await call('/document',period)).status,200,'signed controls recorded');
eq((await call('/document',{...period,account:'b'.repeat(64),opening:100000,closing:150000})).status,200,'transfer target controls recorded');
let s=(await call('?month=2026-03')).data;eq(s.controls.find(c=>c.account===digest).residual,0,'opening plus inflows minus outflows equals closing');
let close=await call('/close',{month:'2026-03',currency:'INR',scale:2,reason:'Synthetic mixed-source certification'});eq(close.status,200,'mixed-source month certified');const frozen=(await call('?month=2026-03')).data.close;eq(frozen.body.version,1,'first close vintage');
const budget={kind:'budget',month:'2026-03',currency:'INR',scale:2,category:'Office',minor:1000000,status:'proposed',reason:'Synthetic original proposal'};
eq((await call('/document',budget)).status,200,'original proposal recorded');eq((await call('/document',{...budget,status:'approved',minor:900000,reason:'Synthetic approval'})).status,200,'approval baseline recorded');eq((await call('/document',{...budget,status:'approved',minor:950000,reason:'Synthetic retrospective revision'})).status,200,'budget revision appended');
s=(await call('?month=2026-03')).data;eq(s.documents.filter(d=>d.kind==='budget').map(d=>d.body.minor),[1000000,900000,950000],'original proposal and approval unchanged');
eq((await call('/document',{kind:'schedule',scheduleKey:'promise',label:'Synthetic collection',date:'2026-04-03',minor:1000000,currency:'INR',scale:2,direction:'inflow',basis:'Synthetic payment promise'})).status,200,'dated assumption recorded');
const forecast=(await call('?month=2026-03&start=2026-04-01')).data.forecast;eq(forecast.certified,true,'certified boundary cash schedule available');eq(forecast.weeks.length,13,'thirteen weekly forecast points');
const delayed=(await call('?month=2026-03&start=2026-04-01&delay=promise')).data.forecast;eq(delayed.weeks[0].inflow,0,'one-week late scenario changes first week');eq(delayed.weeks[1].inflow,1000000,'one-week late scenario shifts only receipt');
eq((await call('/document',{kind:'forecast',month:'2026-03',currency:'INR',scale:2,start:'2026-04-01',scenario:'base'})).status,200,'forecast vintage frozen with cutoff');
const shiftedVintage=await call('/document',{kind:'forecast',month:'2026-03',currency:'INR',scale:2,start:'2026-04-01',scenario:'base',scenarioShifts:{promise:'2026-04-08'}});eq(shiftedVintage.status,200,'scenario-only date override frozen');const shiftedDocument=(await call('')).data.documents.find(x=>x.id===shiftedVintage.data.id);eq(shiftedDocument.body.weeks[0].inflow,0,'frozen shifted vintage retains changed week');eq(shiftedDocument.body.weeks[1].inflow,1000000,'frozen shifted vintage retains receipt');eq(shiftedDocument.body.retrospective,true,'retrospective scenario excluded from held-out evaluation');eq((await call('?month=2026-03&start=2026-04-01')).data.forecast.weeks[0].inflow,1000000,'scenario freeze leaves source promise untouched');

eq((await call('/auto/run',{})).status,409,'automatic exact rule stays disabled without reviewed sample');eq((await call('/document',{kind:'rule',provider:'bank',currency:'INR',scale:2,month:'2026-03',windowDays:45,maxMinor:1000000,enabled:true,reviewedDecisionIds:[],negativeCaseIds:[]})).status,409,'low sample cannot promote rule');
eq((await call('/match/unlink',{id:expense.id,reason:'Synthetic reviewed correction'})).status,200,'unlink recorded');
eq((await call('?month=2026-03')).data.close,frozen,'historical close remains frozen after correction');
eq((await call('/close',{month:'2026-03',currency:'INR',scale:2,reason:'Unreconciled correction'})).status,400,'new close blocked after unmatched correction');
eq((await call('/source',bank.payload)).data.id,bank.id,'reimport after unlink preserves observation identity');
await match(expense.payload.links);eq((await call('/document',{kind:'adjustment',closeId:frozen.id,decisionId:expense.id,reason:'Synthetic correction audit'})).status,200,'explicit historical adjustment linked');
eq((await call('/close',{month:'2026-03',currency:'INR',scale:2,reason:'Synthetic reopen after linked adjustment'})).status,200,'reopened close appends version');eq((await call('?month=2026-03')).data.close.body.version,2,'close v2 retains v1');
// Current daily cash must conserve the frozen close; source cutoffs are explicit.
for(const [account,minor] of [[digest,5420000],['b'.repeat(64),150000]])eq((await call('/document',{kind:'balance',account,currency:'INR',scale:2,asOf:'2026-04-05',minor,coverageComplete:true,statementBasis:'Synthetic daily bank export through cutoff'})).status,200,'verified daily balance recorded');
eq((await call('?month=2026-03&start=2026-04-06')).data.forecast.certified,true,'current verified cash rolls from certified period');
eq((await call('/document',{kind:'balance',account:digest,currency:'INR',scale:2,asOf:'2026-04-05',minor:5420001,coverageComplete:true,statementBasis:'Synthetic wrong balance'})).status,200,'unsupported balance remains an observation');
eq((await call('?month=2026-03&start=2026-04-06')).data.forecast.certified,false,'one minor unit cannot be tolerated away in forecast opening');
const vendor={kind:'vendor',vendorKey:'synthetic-tool',product:'Synthetic annual product',contract:'Synthetic confirmed contract',cycle:'annual',renewalDate:'2026-05-01',currency:'INR',scale:2,minor:20000,seats:2,previousMinor:10000,previousSeats:1,tax:0,previousTax:0,failedPayment:true};
eq((await call('/document',vendor)).status,200,'billing failure recorded');eq((await call('/document',vendor)).status,200,'billing failure replay retained');
let tasks=await app.inject({url:'/api/v0/tasks',headers:{'cf-access-authenticated-user-email':'leadership@round10.example'}});eq(tasks.json().rows.filter(t=>t.title==='Review subscription billing failure').length,1,'one owner task for billing failure replay');
// Promotion sample is entirely synthetic, with actual unique deterministic predictions and ambiguous negatives.
const reviewed=[];for(let i=0;i<200;i++){
 const reference=createHash('sha256').update('synthetic-reference-'+i).digest('hex'),dates={cashDate:'2026-01-15',invoiceDate:'2026-01-01',serviceFrom:'2026-01-01',serviceTo:'2026-01-31',reference};
 const cash=await source('review-bank-'+i,'cash',100,dates),bill=await source('review-bill-'+i,'bill',100,dates);
 const payload={links:[link(cash,'cash',100),link(bill,'obligation',100)],treatment:'payment',reason:'Synthetic human-reviewed exact prediction',rule:'exact-reference-party-currency-v1',requestKey:crypto.randomUUID()};
 const r=await call('/match/accept',payload);eq(r.status,200,'reviewed deterministic prediction');reviewed.push(r.data.id);
}
const ambRef=createHash('sha256').update('synthetic-ambiguous-reference').digest('hex'),ambDates={cashDate:'2026-06-15',invoiceDate:'2026-06-01',serviceFrom:'2026-06-01',serviceTo:'2026-06-30',reference:ambRef};
const ambCash=await source('ambiguous-bank','cash',100,ambDates),ambBill1=await source('ambiguous-bill-a','bill',100,ambDates),ambBill2=await source('ambiguous-bill-b','bill',100,ambDates);
eq((await call('/match/accept',{links:[link(ambCash,'cash',100),link(ambBill1,'obligation',100)],treatment:'payment',reason:'Synthetic ambiguous candidate',rule:'exact-reference-party-currency-v1',requestKey:crypto.randomUUID()})).status,400,'ambiguous candidate cannot enter exact-rule positives');
const negative=await call('/document',{kind:'case',month:'2026-06',currency:'INR',category:'identity',owner:'Synthetic finance reviewer',dueDate:'2026-06-30',description:'Synthetic ambiguous negative with two matching obligations',sourceIds:[ambCash.id,ambBill1.id,ambBill2.id]});eq(negative.status,200,'ambiguous negative case recorded');
const resolution=await call('/document',{kind:'case_resolution',caseId:negative.data.id,reason:'Rejected ambiguous match: two obligations share the scoped reference'});eq(resolution.status,200,'ambiguous negative reviewed');
const rule={kind:'rule',provider:'bank',currency:'INR',scale:2,month:'2026-06',windowDays:45,maxMinor:100,enabled:true,reviewedDecisionIds:reviewed,negativeCaseIds:[resolution.data.id]};eq((await call('/document',rule)).status,200,'reviewed 200-prediction exact rule qualifies with negative receipt');
const newRef=createHash('sha256').update('synthetic-new-rule-reference').digest('hex'),newDates={...ambDates,reference:newRef};
await source('automatic-bank','cash',100,newDates);await source('automatic-bill','bill',100,newDates);
eq((await call('/auto/preview',{})).data.rows.length,1,'automatic preview includes only unique enabled-limit rows');
eq((await call('/auto/run',{})).data.accepted,1,'reviewed recurring rule accepts only the unique exact match');eq((await call('/auto/run',{})).data.accepted,0,'automatic replay cannot consume bank row twice');
const rail=await app.inject({url:'/api/v0/intelligence?path=/finance',headers:{'cf-access-authenticated-user-email':'leadership@round10.example'}});eq(rail.statusCode,200,'Finance has a metadata rail provider');eq(rail.json().cards.every(c=>c.facts.every(f=>f.classification==='finance_metadata')),true,'financial amounts stay out of general intelligence');
const statementRow={date:'2026-03-10',vendor:'Synthetic statement',amount:'120',direction:'outflow',currency:'INR',reference_hash:'c'.repeat(64),account_digest:'a'.repeat(64),reference_kind:'provider_transaction',source_file_digest:'d'.repeat(64),file_replay_key:'e'.repeat(64),minor_unit_scale:2,date_basis:'source posting date',original_amount_unit:'major',parser_issues:[]};
async function importStatement(row){const r=await app.inject({url:'/api/v0/money/import',method:'POST',headers:{'cf-access-authenticated-user-email':'leadership@round10.example'},payload:{action:'save',sourceType:'bank',rows:[row]}});eq(r.statusCode,200,'scoped statement import authorized');return r.json();}
eq((await importStatement(statementRow)).saved,1,'provider transaction first observation imported');eq((await importStatement({...statementRow,source_file_digest:'f'.repeat(64),file_replay_key:'1'.repeat(64)})).saved,0,'same scoped provider ID across files deduplicated');eq((await importStatement({...statementRow,account_digest:'b'.repeat(64),file_replay_key:'2'.repeat(64)})).saved,1,'different account retains independent provider transaction');
const c=await pool.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true)",[process.env.PULSE_ORG_ID]);await assert.rejects(c.query('select * from pulse_priv.finance_source'),e=>e.code==='42501');checks++;await c.query('rollback');}finally{c.release();}
await writeFile(process.env.TEST_REPORT,JSON.stringify({checks,receipts,syntheticOnly:true,certifiedMonth:'2026-03',closeVersions:2,noExternalPosting:true},null,2));await app.close();await pool.end();console.log(checks+' Round 10 acceptance assertions passed');
