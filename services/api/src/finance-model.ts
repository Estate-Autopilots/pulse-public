/** Round 10: integer money, scoped immutable sources and explainable allocation. No private salary input. */
export type FinanceSource = {
 id:string; sourceProvider?:string;originalId?:string;externalKey:string; vintage:string; kind:'cash'|'invoice'|'bill'|'receipt'|'payroll'|'topup'|'delivery'|'fee'|'credit'|'application';
 account:string; party:string; partyConfirmed:boolean; currency:string; scale:number; minor:number; direction:'inflow'|'outflow';
 cashDate:string; invoiceDate:string; dueDate:string; serviceFrom:string; serviceTo:string; dateBasis:string; reference:string;
 label:string; documentBasis:string; dataset:string; observationId:string; category:string; projectId:string; clientId:string;
 validation:'validated'|'quarantine'; issues:string[];
};
export type AllocationLink={sourceId:string;role:'cash'|'obligation'|'fee'|'evidence';minor:number};
export type Decision={id:string;active:boolean;at:string;body:{requestKey:string;links:AllocationLink[];treatment:string;reason:string;rule?:string;currency:string;scale:number;direction:string}};
export type FinancePeriod={account:string;currency:string;scale:number;month:string;opening:number|null;closing:number|null;complete:boolean;statementBasis:string};
export type FinanceDocument={id:string;kind:string;body:Record<string,unknown>;at:string;actor:string};
export type FinanceState={sources:FinanceSource[];decisions:Decision[];documents:FinanceDocument[]};
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
export function validDate(x:unknown):x is string{return typeof x==='string'&&datePattern.test(x)&&Number.isFinite(Date.parse(x+'T00:00:00Z'))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;}
export function integerMoney(x:unknown):number {const n=typeof x==='number'?x:Number(x);if(x===null||x===undefined||x===''||!Number.isSafeInteger(n)||n<0||n>9e12)throw new Error('Use nonnegative integer minor units within the supported limit');return n;}
export function toMinor(value:unknown,scale:number):number {const s=String(value??'');if(!/^\d+(\.\d+)?$/.test(s))throw new Error('Amount or debit/credit sign needs review');const [whole,fraction='']=s.split('.');if(fraction.length>scale)throw new Error('Amount exceeds currency minor-unit scale');return integerMoney(Number(whole)*10**scale+Number(fraction.padEnd(scale,'0')));}
export function validateSource(raw:Record<string,unknown>):Omit<FinanceSource,'id'> {
 const get=(k:string,max=160)=>String(raw[k]??'').trim().slice(0,max), issues:string[]=[];
 const kind=get('kind') as FinanceSource['kind'];if(!['cash','invoice','bill','receipt','payroll','topup','delivery','fee','credit','application'].includes(kind))throw new Error('Choose an economic source kind');
 const scale=Number(raw.scale), currency=get('currency');if(!/^[A-Z]{3}$/.test(currency)||!Number.isInteger(scale)||scale<0||scale>4)throw new Error('Currency and minor-unit scale are required');
 const known:Record<string,number>={INR:2,USD:2,EUR:2,GBP:2,JPY:0,KWD:3};if(known[currency]!==undefined&&known[currency]!==scale)issues.push('Currency minor-unit scale conflict');
 const direction=get('direction') as FinanceSource['direction'];if(!['inflow','outflow'].includes(direction))throw new Error('Explicit debit or credit direction is required');
 const minor=integerMoney(raw.minor);if(minor===0)issues.push('Zero-value movement');
 const account=get('account'),party=get('party'),reference=get('reference');if(account&&!/^[a-f0-9]{64}$/.test(account))throw new Error('Account must be a scoped digest');if(reference&&!/^[a-f0-9]{64}$/.test(reference))throw new Error('Reference must be a digest');
 if(kind==='cash'&&!account)issues.push('Source account unknown');
 const dates=['cashDate','invoiceDate','dueDate','serviceFrom','serviceTo'];for(const k of dates)if(get(k)&&!validDate(get(k)))issues.push(`${k} invalid or timezone ambiguous`);
 if(kind==='cash'&&!validDate(get('cashDate')))issues.push('Cash date missing');
 if(kind==='cash'&&get('cashDate')>new Date().toISOString().slice(0,10))issues.push('Future settlement belongs in a scenario, not a cash fact');
 if(['invoice','bill','payroll','delivery','fee'].includes(kind)&&(!validDate(get('serviceFrom'))||!validDate(get('serviceTo'))))issues.push('Service period missing');
 if(get('serviceFrom')>get('serviceTo'))issues.push('Service period reversed');
 if(!get('dateBasis'))issues.push('Original date basis missing');if(!get('documentBasis',1000))issues.push('Document basis missing');
 if(raw.ambiguous===true)issues.push('Parser or OCR fields need review');if(get('dateBasis').includes('timezone-unknown'))issues.push('Timezone boundary needs source confirmation');
 if(!get('externalKey')||!get('vintage'))throw new Error('Immutable source key and vintage are required');
 if(!['bank','card','upi','gateway','finance','payroll','other',''].includes(get('sourceProvider')))issues.push('Provider needs review');
 if(kind==='credit'&&!get('originalId'))issues.push('Credit or refund requires its original obligation');
 if(kind==='payroll'&&raw.aggregateApproved!==true)issues.push('Approved aggregate payroll obligation required');
 return {sourceProvider:get('sourceProvider')||(kind==='cash'?'bank':'finance'),originalId:get('originalId'),externalKey:get('externalKey'),vintage:get('vintage'),kind,account,party,partyConfirmed:raw.partyConfirmed===true,currency,scale,minor,direction,cashDate:get('cashDate'),invoiceDate:get('invoiceDate'),dueDate:get('dueDate'),serviceFrom:get('serviceFrom'),serviceTo:get('serviceTo'),dateBasis:get('dateBasis'),reference,label:get('label'),documentBasis:get('documentBasis',1000),dataset:get('dataset'),observationId:get('observationId'),category:get('category',80),projectId:get('projectId'),clientId:get('clientId'),validation:issues.length?'quarantine':'validated',issues};
}
export function allocationPreview(state:FinanceState,input:Record<string,unknown>) {
 const links=input.links as AllocationLink[];if(!Array.isArray(links)||!links.length||links.length>100)throw new Error('Choose up to 100 source allocations');
 const seen=new Set<string>();const sources=links.map(l=>{if(seen.has(l.sourceId))throw new Error('A source can appear only once in an allocation');seen.add(l.sourceId);integerMoney(l.minor);if(l.minor===0)throw new Error('Allocation must be positive');const s=state.sources.find(s=>s.id===l.sourceId);if(!s||s.validation!=='validated'||!currentSources(state).some(x=>x.id===s.id)||revisionConflicts(state).includes(s.id))throw new Error('Source is missing or quarantined');if(l.minor>s.minor)throw new Error('Allocation exceeds source amount');return s;});
 const cash=links.filter(l=>l.role==='cash'), obligations=links.filter(l=>l.role==='obligation'),fees=links.filter(l=>l.role==='fee');if(!cash.length)throw new Error('A bank settlement cash line is required');
 const first=state.sources.find(s=>s.id===cash[0].sourceId)!;
 if(sources.some(s=>s.currency!==first.currency||s.scale!==first.scale))throw new Error('Different currencies or scales require a separately documented conversion');
 for(let i=0;i<links.length;i++){const l=links[i],s=sources[i];if(!['cash','obligation','fee','evidence'].includes(l.role))throw new Error('Unknown allocation role');if(l.role==='cash'&&(s.kind!=='cash'||l.minor!==s.minor))throw new Error('Consume a complete bank cash line once');if(l.role==='obligation'&&!['invoice','bill','payroll','topup','credit','application'].includes(s.kind))throw new Error('Supporting receipts are not obligations');if(l.role==='fee'&&s.kind!=='fee')throw new Error('Fee or withholding needs explicit source evidence');
  const used=state.decisions.filter(d=>d.active).flatMap(d=>d.body.links).filter(x=>x.sourceId===s.id&&x.role===l.role);if(l.role==='cash'&&used.length)throw new Error('Cash line is already allocated');if(['obligation','fee'].includes(l.role)&&used.reduce((n,x)=>n+x.minor,0)+l.minor>s.minor)throw new Error('Source has insufficient unallocated amount');
 }
 const treatment=String(input.treatment??'payment');if(!['payment','cash_only','transfer','refund'].includes(treatment))throw new Error('Choose an explicit economic treatment');
 const cashMinor=cash.reduce((n,l)=>n+l.minor,0),obligationMinor=obligations.reduce((n,l)=>n+l.minor,0),feeMinor=fees.reduce((n,l)=>n+l.minor,0);
 if(treatment==='transfer'){if(obligations.length||fees.length||cash.length!==2||sources.filter(s=>s.kind==='cash').some(s=>!s.account))throw new Error('Transfer requires two complete account cash lines');const c=cash.map(l=>state.sources.find(s=>s.id===l.sourceId)!);if(c[0].account===c[1].account||c[0].direction===c[1].direction||c[0].minor!==c[1].minor)throw new Error('Transfer must conserve consolidated cash across distinct accounts');}
 else {if(cash.some(l=>state.sources.find(s=>s.id===l.sourceId)!.direction!==first.direction))throw new Error('Cash directions conflict');if(treatment!=='refund'&&obligations.some(l=>state.sources.find(s=>s.id===l.sourceId)!.direction!==first.direction))throw new Error('Obligation direction conflicts');if(treatment==='cash_only'){if(obligations.length||fees.length)throw new Error('Cash-only acceptance cannot create an obligation or adjustment');}else if(!obligations.length||cashMinor+feeMinor!==obligationMinor)throw new Error(`Amount conservation failed: cash ${cashMinor} + supported fee ${feeMinor} must equal obligation ${obligationMinor}`);}
 if(treatment==='refund'&&obligations.some(l=>{const s=state.sources.find(s=>s.id===l.sourceId)!;return s.kind!=='credit'||!s.originalId||!state.sources.some(x=>x.id===s.originalId&&['invoice','bill','payroll','topup'].includes(x.kind));}))throw new Error('Refund requires a credit linked to the original obligation');
 if(!String(input.reason??'').trim())throw new Error('A reviewed decision reason is required');
 return {requestKey:String(input.requestKey??''),links,treatment,reason:String(input.reason).slice(0,1000),rule:String(input.rule??'manual-v1'),currency:first.currency,scale:first.scale,direction:first.direction,cashMinor,obligationMinor,feeMinor,reversible:true};
}
export function exactCandidates(state:FinanceState,windowDays=45,provider?:string) {
 const used=new Set(state.decisions.filter(d=>d.active).flatMap(d=>d.body.links.filter(l=>l.role==='cash').map(l=>l.sourceId)));
 const cash=state.sources.filter(s=>s.kind==='cash'&&s.validation==='validated'&&!used.has(s.id)&&(!provider||(s.sourceProvider??'bank')===provider));
 const pairs=cash.flatMap(c=>state.sources.filter(s=>['bill','invoice','payroll','topup'].includes(s.kind)&&s.validation==='validated'&&s.reference&&s.reference===c.reference&&s.partyConfirmed&&c.partyConfirmed&&s.party===c.party&&s.direction===c.direction&&s.currency===c.currency&&s.scale===c.scale&&s.minor===c.minor&&validDate(s.invoiceDate||s.serviceTo)&&Math.abs(Date.parse(c.cashDate)-Date.parse(s.invoiceDate||s.serviceTo))<=windowDays*864e5).map(s=>({cashId:c.id,obligationId:s.id,rule:'exact-reference-party-currency-v1',basis:'Scoped reference, confirmed party, direction, currency, integer amount and reviewed date window'})));
 return pairs.map(p=>({...p,unique:pairs.filter(x=>x.cashId===p.cashId).length===1&&pairs.filter(x=>x.obligationId===p.obligationId).length===1&&!state.decisions.some(d=>d.active&&d.body.links.some(l=>l.sourceId===p.obligationId&&l.role==='obligation'))}));
}
export function accountControls(state:FinanceState,p:FinancePeriod) {
 const cash=currentSources(state).filter(s=>s.kind==='cash'&&s.account===p.account&&s.currency===p.currency&&s.scale===p.scale&&s.cashDate.startsWith(p.month));
 const accepted=new Set(state.decisions.filter(d=>d.active).flatMap(d=>d.body.links.filter(l=>l.role==='cash').map(l=>l.sourceId)));
 const inflow=cash.filter(s=>accepted.has(s.id)&&s.direction==='inflow').reduce((n,s)=>n+s.minor,0),outflow=cash.filter(s=>accepted.has(s.id)&&s.direction==='outflow').reduce((n,s)=>n+s.minor,0);
 const residual=p.opening!==null&&p.closing!==null?p.opening+inflow-outflow-p.closing:null;
 const blockers=[...(revisionConflicts(state).some(id=>cash.some(s=>s.id===id))?['Allocated source vintage conflicts with a later revision']:[]),...(!p.complete?['Incomplete statement coverage']:[]),...(p.opening===null?['Cannot reconcile account balance: opening balance missing']:[]),...(p.closing===null?['Closing balance missing']:[]),...(!p.statementBasis?['Statement evidence missing']:[]),...(cash.some(s=>s.validation==='quarantine')?['Quarantined cash rows']:[]),...(cash.some(s=>!accepted.has(s.id))?['Unmatched cash lines']:[]),...(residual!==null&&residual!==0?['Unexplained account residual']:[])];
 return {...p,inflow,outflow,residual,rows:cash.length,unmatched:cash.filter(s=>!accepted.has(s.id)).length,blockers,certifiable:blockers.length===0};
}
export type CashSchedule={id:string;date:string;minor:number;direction:'inflow'|'outflow';label:string;basis:string;protected?:boolean;sourceId?:string};
export function weeklyForecast(opening:number|null,start:string,schedule:CashSchedule[],complete:boolean,scenario:'base'|'downside'|'upside'='base',delayId?:string) {
 if(!validDate(start))throw new Error('Forecast start date required');const reason=opening===null?'Verified opening cash missing':!complete?'Account coverage and a certified period are required':null;
 if(reason)return {certified:false,reason,scenario,weeks:[] as {date:string;inflow:number;outflow:number;closing:number}[]};
 let balance=integerMoney(opening);const weeks=Array.from({length:13},(_,i)=>{const date=new Date(Date.parse(start+'T00:00:00Z')+i*7*864e5).toISOString().slice(0,10),end=Date.parse(date+'T00:00:00Z')+7*864e5;
 const items=schedule.filter(s=>{const extra=s.direction==='inflow'&&(scenario==='downside'||s.id===delayId)?7:0;const when=Date.parse(s.date+'T00:00:00Z')+extra*864e5;return when>=Date.parse(date+'T00:00:00Z')&&when<end;});
 const inflow=items.filter(s=>s.direction==='inflow').reduce((n,s)=>n+integerMoney(s.minor),0),outflow=items.filter(s=>s.direction==='outflow').reduce((n,s)=>n+integerMoney(s.minor),0);balance+=inflow-outflow;return {date,inflow,outflow,closing:balance};});
 return {certified:true,reason:null,scenario,weeks};
}
export function budgetComparison(documents:FinanceDocument[],sources:FinanceSource[],month:string,category:string,currency:string,scale:number,today:string) {
 const versions=documents.filter(d=>d.kind==='budget'&&d.body.month===month&&d.body.category===category&&d.body.currency===currency&&d.body.scale===scale);
 const original=versions.find(d=>d.body.status==='proposed'),baseline=versions.find(d=>d.body.status==='approved'),approved=versions.filter(d=>d.body.status==='approved').at(-1);
 const expense=sources.filter(s=>['bill','delivery','payroll','fee'].includes(s.kind)&&s.validation==='validated'&&s.category===category&&s.currency===currency&&s.scale===scale&&s.serviceFrom.slice(0,7)<=month&&s.serviceTo.slice(0,7)>=month&&s.serviceFrom<=today);
 const actual=expense.reduce((n,s)=>n+accrualExpense(s,month,today),0);
 const latestCommitments=new Map<string,FinanceDocument>();for(const d of documents.filter(d=>d.kind==='commitment'))latestCommitments.set(String(d.body.commitmentKey||d.id),d);
 const commitments=[...latestCommitments.values()].filter(d=>d.body.month===month&&d.body.category===category&&d.body.currency===currency&&d.body.scale===scale&&!sources.some(s=>s.externalKey===d.body.billedSourceKey));
 const committed=commitments.reduce((n,d)=>n+integerMoney(d.body.minor),0);return {versions,proposal:original?.body.minor??null,baseline:baseline?.body.minor??null,approved:approved?.body.minor??null,actual,committed,available:approved?Number(approved.body.minor)-actual-committed:null,basis:month===today.slice(0,7)?'Accrual actual to date':'Accrual expense in covered periods'};
}
export function forecastEvaluation(predicted:number[],actual:number[]){if(predicted.length!==actual.length||!actual.length)throw new Error('Matched realized forecast vintages required');const errors=predicted.map((p,i)=>p-actual[i]);return {n:errors.length,signedBias:errors.reduce((n,e)=>n+e,0)/errors.length,mae:errors.reduce((n,e)=>n+Math.abs(e),0)/errors.length,intervalCoverage:null,promotion:'Schedule baseline only; no held-out model or calibrated interval'};}
export function vendorExplanation(before:{minor:number;seats:number|null;currency:string;tax:number|null},after:{minor:number;seats:number|null;currency:string;tax:number|null}) {if(before.currency!==after.currency)return 'Currency changed; compare documented FX basis';if(before.tax!==after.tax)return 'Tax changed; compare pre-tax cost';if(before.seats&&after.seats&&before.minor/before.seats===after.minor/after.seats)return 'Seat count explains the change; comparable per-seat cost unchanged';return before.minor===after.minor?'Comparable cost unchanged':'Review plan, discount expiry, tax, seats and contract evidence';}
/** Source revisions never erase evidence. An allocated older vintage becomes an explicit conflict. */
export function currentSources(state:FinanceState) {
 const latest=new Map<string,FinanceSource>();for(const s of state.sources)latest.set(s.externalKey,s);
 const allocated=new Set(state.decisions.filter(d=>d.active).flatMap(d=>d.body.links.map(l=>l.sourceId)));
 return state.sources.filter(s=>latest.get(s.externalKey)?.id===s.id||allocated.has(s.id));
}
export function revisionConflicts(state:FinanceState) {const sources=currentSources(state),counts=new Map<string,number>();for(const s of sources)counts.set(s.externalKey,(counts.get(s.externalKey)??0)+1);return sources.filter(s=>counts.get(s.externalKey)!>1).map(s=>s.id);}
export function accrualExpense(source:FinanceSource,month:string,today:string) {
 if(!validDate(source.serviceFrom)||!validDate(source.serviceTo)||month<source.serviceFrom.slice(0,7)||month>source.serviceTo.slice(0,7)||month>today.slice(0,7))return 0;
 const first=Number(source.serviceFrom.slice(0,4))*12+Number(source.serviceFrom.slice(5,7))-1,last=Number(source.serviceTo.slice(0,4))*12+Number(source.serviceTo.slice(5,7))-1,index=Number(month.slice(0,4))*12+Number(month.slice(5,7))-1-first,n=last-first+1;
 const monthly=Math.floor(source.minor/n)+(index<source.minor%n?1:0);
 if(month<today.slice(0,7))return monthly;
 const days=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).getUTCDate(),from=month===source.serviceFrom.slice(0,7)?Number(source.serviceFrom.slice(8)):1,to=month===source.serviceTo.slice(0,7)?Number(source.serviceTo.slice(8)):days;
 return Math.floor(monthly*Math.max(0,Math.min(Number(today.slice(8)),to)-from+1)/(to-from+1));
}
/** Stable largest-remainder allocation keeps every minor unit, including grouped settlements across months. */
export function apportionMinor(total:number,weights:number[]):number[]{
 integerMoney(total);weights.forEach(integerMoney);const sum=weights.reduce((n,w)=>n+BigInt(w),BigInt(0));if(!sum)return weights.map(()=>0);
 const parts=weights.map((w,i)=>({i,minor:Number(BigInt(total)*BigInt(w)/sum),remainder:BigInt(total)*BigInt(w)%sum}));
 let left=total-parts.reduce((n,p)=>n+p.minor,0);for(const p of [...parts].sort((a,b)=>a.remainder>b.remainder?-1:a.remainder<b.remainder?1:a.i-b.i)){if(left--<=0)break;p.minor++;}
 return parts.map(p=>p.minor);
}
export function movementSummary(state:FinanceState,month:string,currency:string,scale:number,today=new Date().toISOString().slice(0,10)) {
 const current=currentSources(state),sources=new Map(current.map(s=>[s.id,s])),decisions=state.decisions.filter(d=>d.active);
 const cash=decisions.filter(d=>d.body.treatment!=='transfer').flatMap(d=>d.body.links.filter(l=>l.role==='cash').map(l=>sources.get(l.sourceId)!)).filter(s=>s&&s.currency===currency&&s.scale===scale&&s.cashDate.startsWith(month));
 const accepted=new Set(decisions.flatMap(d=>d.body.links.filter(l=>l.role==='obligation'||l.role==='fee').map(l=>l.sourceId)));
 const consumptionBills=new Set(current.filter(s=>s.kind==='delivery'&&s.validation==='validated'&&s.originalId).map(s=>s.originalId));
 const expenses=current.filter(s=>!consumptionBills.has(s.id)&&s.validation==='validated'&&s.currency===currency&&s.scale===scale&&((accepted.has(s.id)&&['bill','payroll','fee'].includes(s.kind))||s.kind==='delivery'));
 const invoices=current.filter(s=>s.kind==='invoice'&&s.validation==='validated'&&accepted.has(s.id)&&s.currency===currency&&s.scale===scale&&s.invoiceDate.startsWith(month));
 const clientCollections=decisions.filter(d=>d.body.treatment!=='transfer').flatMap(d=>{
  const cashRows=d.body.links.filter(l=>l.role==='cash').map(l=>sources.get(l.sourceId)!).filter(s=>s?.currency===currency&&s.scale===scale&&s.direction==='inflow');
  if(!cashRows.length)return [];
  const obligations=d.body.links.filter(l=>l.role==='obligation');
  const grossByCash=obligations.map(l=>apportionMinor(l.minor,cashRows.map(s=>s.minor)));
  return cashRows.flatMap((cash,ci)=>{
   if(!cash.cashDate.startsWith(month))return [];
   const bankByObligation=apportionMinor(cash.minor,obligations.map(l=>l.minor));
   return obligations.flatMap((l,oi)=>{const source=sources.get(l.sourceId);return source?.kind==='invoice'&&source.clientId?[{clientId:source.clientId,projectId:source.projectId,invoiceId:source.id,decisionId:d.id,minor:grossByCash[oi][ci],bankMinor:bankByObligation[oi],cashDate:cash.cashDate}]:[];});
  });
 });
 return {cashIn:cash.filter(s=>s.direction==='inflow').reduce((n,s)=>n+s.minor,0),cashOut:cash.filter(s=>s.direction==='outflow').reduce((n,s)=>n+s.minor,0),accrualExpense:expenses.reduce((n,s)=>n+accrualExpense(s,month,today),0),invoiced:invoices.reduce((n,s)=>n+s.minor,0),expenseSources:expenses.map(s=>s.id),clientCollections,consolidatedBasis:'Internal transfers and card settlements are neutral in consolidated cash; top-ups remain prepaid funding, not delivered media expense'};
}
export function discrepancyExplanations(state:FinanceState,control:ReturnType<typeof accountControls>) {
 const sources=currentSources(state),cash=sources.filter(s=>s.kind==='cash'&&s.account===control.account&&s.currency===control.currency&&s.scale===control.scale&&s.cashDate.startsWith(control.month));
 if(!control.complete||control.opening===null||control.closing===null)return {residual:null,basis:'Incomplete coverage; no monetary gap is asserted',explanations:[{kind:'coverage',label:'Obtain opening / closing balances and complete statement',sourceIds:cash.map(s=>s.id),rank:1}]};
 const exact=exactCandidates({...state,sources}),supported=new Set(state.decisions.filter(d=>d.active).flatMap(d=>d.body.links.map(l=>l.sourceId)));
 const timing=exact.filter(p=>cash.some(c=>c.id===p.cashId)&&sources.find(s=>s.id===p.obligationId)?.invoiceDate.slice(0,7)!==control.month);
 const feeCandidates=cash.flatMap(c=>sources.filter(s=>s.kind==='invoice'&&s.reference&&s.reference===c.reference&&s.currency===c.currency&&s.minor>c.minor).map(s=>({invoice:s,cash:c,fee:sources.find(f=>f.kind==='fee'&&f.reference===c.reference&&f.currency===c.currency&&f.minor===s.minor-c.minor)})));
 const explanations=[...(feeCandidates.length?[{kind:'fee',label:feeCandidates.some(x=>x.fee)?'Documented fee conserves settlement and collection':'Settlement differs from collection; fee evidence is missing',sourceIds:feeCandidates.flatMap(x=>[x.invoice.id,x.cash.id,...(x.fee?[x.fee.id]:[])]),rank:feeCandidates.some(x=>x.fee)?1:3}]:[]),...(timing.length?[{kind:'timing',label:'Invoice obligation precedes a settlement in this month',sourceIds:timing.flatMap(x=>[x.cashId,x.obligationId]),rank:2}]:[]),{kind:'missing_movement',label:'Review unmatched bank export rows against supporting bills and receipts',sourceIds:cash.filter(s=>!supported.has(s.id)).map(s=>s.id),rank:4}];
 return {residual:control.residual,basis:'Signed account controls after supported allocations; ranked by source evidence, never by staff blame',explanations:explanations.sort((a,b)=>a.rank-b.rank).slice(0,3)};
}
export function verifiedForecastOpening(state:FinanceState,currency:string,scale:number,start:string) {
 if(!validDate(start))throw new Error('Forecast start is invalid');
 const previous=new Date(Date.parse(start+'T00:00:00Z')-864e5).toISOString().slice(0,10);
 const close=state.documents.filter(d=>d.kind==='close'&&d.body.currency===currency&&d.body.scale===scale&&String(d.body.month)<start.slice(0,7)).at(-1);
 if(!close)return {opening:null,complete:false,reason:'A certified prior period is required',cutoff:previous,closeId:null};
 const frozen=close.body.controls as FinancePeriod[];
 if(revisionConflicts(state).length)return {opening:null,complete:false,reason:'An allocated source vintage conflicts with a revision',cutoff:previous,closeId:close.id};
 const sources=currentSources(state),accepted=new Set(state.decisions.filter(d=>d.active).flatMap(d=>d.body.links.filter(l=>l.role==='cash').map(l=>l.sourceId)));
 // A later correction must not silently invalidate the opening balance carried from a frozen close.
 for(const p of frozen)if(!accountControls(state,p).certifiable)return {opening:null,complete:false,reason:'Prior close has a current correction; reopen with an adjustment before forecasting',cutoff:previous,closeId:close.id};
 const accounts=[...new Set(sources.filter(s=>s.kind==='cash'&&s.currency===currency&&s.scale===scale).map(s=>s.account).concat(frozen.map(p=>p.account)))];
 if(accounts.some(a=>!frozen.some(p=>p.account===a)))return {opening:null,complete:false,reason:'Account coverage changed since the prior close',cutoff:previous,closeId:close.id};
 if(previous===`${close.body.month}-${new Date(Date.UTC(Number(previous.slice(0,4)),Number(previous.slice(5,7)),0)).getUTCDate()}`)return {opening:frozen.reduce((n,p)=>n+Number(p.closing),0),complete:true,reason:null,cutoff:previous,closeId:close.id};
 let opening=0;
 for(const p of frozen){const balance=state.documents.filter(d=>d.kind==='balance'&&d.body.account===p.account&&d.body.currency===currency&&d.body.scale===scale&&d.body.asOf===previous).at(-1);
  if(!balance||balance.body.coverageComplete!==true||!balance.body.statementBasis)return {opening:null,complete:false,reason:'Current verified account balances and daily statement coverage are missing',cutoff:previous,closeId:close.id};
  const cash=sources.filter(s=>s.kind==='cash'&&s.account===p.account&&s.currency===currency&&s.scale===scale&&s.cashDate.slice(0,7)>String(close.body.month)&&s.cashDate<=previous);
  if(cash.some(s=>s.validation!=='validated'||!accepted.has(s.id)))return {opening:null,complete:false,reason:'Current bank export contains unmatched or quarantined movements',cutoff:previous,closeId:close.id};
  const expected=Number(p.closing)+cash.reduce((n,s)=>n+(s.direction==='inflow'?s.minor:-s.minor),0);
  if(expected!==Number(balance.body.minor))return {opening:null,complete:false,reason:'Current balance does not conserve prior certified cash and settlements',cutoff:previous,closeId:close.id};
  opening+=expected;
 }
 return {opening,complete:true,reason:null,cutoff:previous,closeId:close.id};
}
export function scheduledCash(state:FinanceState,currency:string,scale:number):CashSchedule[] {
 const explicit=new Map<string,CashSchedule>();for(const d of state.documents.filter(d=>d.kind==='schedule'&&d.body.currency===currency&&d.body.scale===scale))explicit.set(String(d.body.scheduleKey),{id:String(d.body.scheduleKey),date:String(d.body.date),minor:Number(d.body.minor),direction:d.body.direction as 'inflow'|'outflow',label:String(d.body.label),basis:String(d.body.basis),protected:d.body.protected===true,sourceId:String(d.body.sourceId??'')});
 const linked=new Set([...explicit.values()].map(s=>s.sourceId).filter(Boolean));
 const generated=currentSources(state).filter(s=>s.currency===currency&&s.scale===scale&&s.validation==='validated'&&['invoice','bill','payroll'].includes(s.kind)&&validDate(s.dueDate)&&!linked.has(s.id)).flatMap(s=>{
  const applied=state.decisions.filter(d=>d.active).flatMap(d=>d.body.links).filter(l=>l.sourceId===s.id&&l.role==='obligation').reduce((n,l)=>n+l.minor,0);const remaining=s.minor-applied;
  return remaining>0?[{id:`source:${s.id}`,sourceId:s.id,date:s.dueDate,minor:remaining,direction:s.direction,label:s.kind==='payroll'?'Approved aggregate payroll':s.label,basis:'Explicit source due terms; collection timing remains an assumption',protected:s.kind==='payroll'}]:[];
 });
 return [...explicit.values(),...generated];
}
export function realizedForecastComparison(state:FinanceState,vintage:FinanceDocument) {
 const predicted=vintage.body.weeks as {date:string;closing:number}[]|undefined;if(!Array.isArray(predicted))return null;
 const comparisons=predicted.flatMap(w=>{
  if(vintage.body.retrospective===true||vintage.at.slice(0,10)>w.date)return [];
  const end=new Date(Date.parse(w.date+'T00:00:00Z')+6*864e5).toISOString().slice(0,10),month=end.slice(0,7);
  const close=state.documents.filter(d=>d.kind==='close'&&d.body.month===month&&d.body.currency===vintage.body.currency&&d.body.scale===vintage.body.scale).at(-1);if(!close)return [];
  const controls=close.body.controls as FinancePeriod[],sourceIds=new Set(close.body.sourceIds as string[]),decisionIds=new Set(close.body.decisionIds as string[]);
  const cashIds=new Set(state.decisions.filter(d=>decisionIds.has(d.id)).flatMap(d=>d.body.links.filter(l=>l.role==='cash').map(l=>l.sourceId)));
  const ending=controls.reduce((n,p)=>n+Number(p.opening)+state.sources.filter(s=>sourceIds.has(s.id)&&cashIds.has(s.id)&&s.kind==='cash'&&s.currency===vintage.body.currency&&s.scale===vintage.body.scale&&s.account===p.account&&s.cashDate.startsWith(month)&&s.cashDate<=end).reduce((sum,s)=>sum+(s.direction==='inflow'?s.minor:-s.minor),0),0);
  return [{date:w.date,predicted:w.closing,realized:ending,realizedCloseId:close.id}];
 });
 return comparisons.length?{...forecastEvaluation(comparisons.map(w=>w.predicted),comparisons.map(w=>w.realized)),comparisons,split:'Frozen forecast vintage against later certified weekly cash; rolling-origin time split'}:null;
}
