import { financePilot } from './finance-pilot.js';
import { liveWithManual } from './finance-entry.js';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { fail,type Tx } from './routes.js';
import { accountControls,allocationPreview,exactCandidates,currentSources,movementSummary,discrepancyExplanations,verifiedForecastOpening,scheduledCash,realizedForecastComparison,budgetComparison,integerMoney,validateSource,validDate,weeklyForecast,type FinancePeriod,type FinanceState } from './finance-model.js';
const text=(x:unknown,max=1000)=>String(x??'').trim().slice(0,max);
const uuid=(x:unknown)=>/^[0-9a-f-]{36}$/.test(text(x))?text(x):fail(400,'Choose a valid source');
const month=(x:unknown)=>/^\d{4}-(0[1-9]|1[0-2])$/.test(text(x))?text(x):fail(400,'Choose a calendar month');
const currency=(x:unknown)=>/^[A-Z]{3}$/.test(text(x))?text(x):fail(400,'Choose a currency');
const scale=(x:unknown)=>Number.isInteger(Number(x))&&Number(x)>=0&&Number(x)<=4?Number(x):fail(400,'Choose a minor-unit scale');
const day=(x:unknown)=>validDate(x)?x:fail(400,'Choose an unambiguous calendar date');
function latest(state:FinanceState,kind:string,key:(b:Record<string,unknown>)=>string){const map=new Map<string,Record<string,unknown>>();for(const d of state.documents.filter(d=>d.kind===kind))map.set(key(d.body),d.body);return [...map.values()];}
function view(state:FinanceState,q:Record<string,string>) {
 const periods=latest(state,'period',p=>`${p.account}|${p.month}|${p.currency}|${p.scale}`) as unknown as FinancePeriod[];
 const controls=periods.map(p=>accountControls(state,p));
 const active=state.decisions.filter(d=>d.active),used=new Set(active.flatMap(d=>d.body.links.filter(l=>l.role==='cash').map(l=>l.sourceId))),supported=new Set(active.flatMap(d=>d.body.links.map(l=>l.sourceId)));
 const selectedMonth=q.month??new Date().toISOString().slice(0,7),selectedCurrency=q.currency??'INR',selectedScale=Number(q.scale??2);
 const scoped=currentSources(state).filter(s=>s.currency===selectedCurrency&&s.scale===selectedScale&&(!q.source||s.id===q.source)&&((s.kind==='cash'?s.cashDate:s.invoiceDate||s.serviceFrom||s.cashDate).startsWith(selectedMonth)));
 const knownAccounts=[...new Set(state.sources.filter(s=>s.kind==='cash'&&s.currency===selectedCurrency&&s.scale===selectedScale).map(s=>s.account).concat(periods.filter(p=>p.currency===selectedCurrency&&p.scale===selectedScale).map(p=>p.account)))];
 const selectedControls=controls.filter(c=>c.month===selectedMonth&&c.currency===selectedCurrency&&c.scale===selectedScale);
 const blockers=[...selectedControls.flatMap(c=>c.blockers),...(knownAccounts.some(a=>!selectedControls.some(c=>c.account===a))?['Missing account-period coverage']:[]),...(!selectedControls.length?['No account-period statements']:[])];
 const cases=state.documents.filter(d=>d.kind==='case'&&d.body.month===selectedMonth&&d.body.currency===selectedCurrency&&!state.documents.some(r=>r.kind==='case_resolution'&&r.body.caseId===d.id));if(cases.length)blockers.push('Unresolved discrepancy cases');
 const close=state.documents.filter(d=>d.kind==='close'&&d.body.month===selectedMonth&&d.body.currency===selectedCurrency&&d.body.scale===selectedScale).at(-1);
 const start=q.start??new Date().toISOString().slice(0,10),openingControl=verifiedForecastOpening(state,selectedCurrency,selectedScale,start);
 const schedule=scheduledCash(state,selectedCurrency,selectedScale);
 const calculated=weeklyForecast(openingControl.opening,start,schedule,openingControl.complete,['base','downside','upside'].includes(q.scenario)?q.scenario as 'base'|'downside'|'upside':'base',q.delay);
 const forecast={...calculated,reason:calculated.certified?null:openingControl.reason??calculated.reason,opening:openingControl.opening,start,sourceCutoff:openingControl.cutoff,closeId:openingControl.closeId,overdueAssumptions:schedule.filter(s=>s.date<start).length};
 const acceptedObligations=new Set(state.decisions.filter(d=>d.active).flatMap(d=>d.body.links.filter(l=>l.role==='obligation'||l.role==='fee').map(l=>l.sourceId)));
 const budgetSources=currentSources(state).filter(s=>(acceptedObligations.has(s.id)||s.kind==='delivery')&&!state.sources.some(x=>x.kind==='delivery'&&x.validation==='validated'&&x.originalId===s.id));
 const budgets=[...new Set(state.documents.filter(d=>d.kind==='budget'&&d.body.month===selectedMonth&&d.body.currency===selectedCurrency&&d.body.scale===selectedScale).map(d=>text(d.body.category)))].map(category=>({category,...budgetComparison(state.documents,budgetSources,selectedMonth,category,selectedCurrency,selectedScale,new Date().toISOString().slice(0,10))}));
 return {...state,budgets,forecastEvaluations:state.documents.filter(d=>d.kind==='forecast').map(d=>({id:d.id,evaluation:realizedForecastComparison(state,d)})),summary:movementSummary(state,selectedMonth,selectedCurrency,selectedScale),discrepancies:selectedControls.map(c=>({account:c.account,...discrepancyExplanations(state,c)})),selectedMonth,selectedCurrency,selectedScale,candidates:exactCandidates({...state,sources:currentSources(state)}),controls,blockers,close,forecast,schedule,queues:{cash:scoped.filter(s=>s.kind==='cash'&&!used.has(s.id)),source:scoped.filter(s=>s.kind!=='cash'&&!supported.has(s.id)),identity:scoped.filter(s=>!s.partyConfirmed||s.validation==='quarantine')},cases,sourceCoverage:{snapshots:state.sources.length,coveredAccounts:selectedControls.length,knownAccounts:knownAccounts.length,certifiedMonths:state.documents.filter(d=>d.kind==='close').length},policy:'Only unique deterministic reference/party/currency matches under a reviewed enabled rule; no fuzzy automation.'};
}
export function registerFinanceRoutes(app:FastifyInstance,{tx}:{tx:Tx}) {
 const body={type:'object'} as const;
 const state=async(c:{query: (sql:string)=>Promise<{rows:{data:FinanceState}[]}>})=>(await c.query('select pulse.finance_state() data')).rows[0].data;
 const safe=<T>(fn:()=>T):T=>{try{return fn();}catch(e){return fail(400,e instanceof Error?e.message:'Check finance values');}};
 app.get('/api/v0/finance',req=>tx(req,async c=>{const live=await state(c),q=req.query as Record<string,string>,s=q.pilot==='synthetic'?financePilot():live;const permissions=(await c.query("select pulse.money_can('money.plan.write') write")).rows[0];
  // FIN-LIVE: the uncertified live model rides along with the certified workspace; the pilot never mixes with it.
  const liveState=q.pilot==='synthetic'?null:await liveWithManual(c,(await c.query('select pulse.finance_live_state() data')).rows[0].data);
  return {...safe(()=>view(s,q)),synthetic:q.pilot==='synthetic',permissions,live:liveState,people:permissions.write&&q.pilot!=='synthetic'?(await c.query("select id,display_name name from pulse.person where side='staff' and status='active' order by display_name")).rows:[]};}));
 app.get('/api/v0/finance/live',req=>tx(req,async c=>liveWithManual(c,(await c.query('select pulse.finance_live_state() data')).rows[0].data)));
 app.get('/api/v0/finance/live/records',req=>tx(req,async c=>{await c.query('select pulse.finance_live_authorize()');const q=req.query as Record<string,string>,kind=text(q.kind,40),offset=Number(q.offset??0);
  if(!['bank_line','bank_balance','bank_summary','invoice','bill','cost_month','expense_month','subscription','ad_spend_month','filing','suspense','plan','package_cost'].includes(kind))fail(400,'Choose a live record kind');
  if(!Number.isInteger(offset)||offset<0||offset>1e6)fail(400,'Choose a page');
  return (await c.query('select pulse.finance_live_records($1,$2) data',[kind,offset])).rows[0].data;}));
 app.get<{Params:{id:string}}>('/api/v0/finance/clients/:id',req=>tx(req,async c=>{
  const s=await state(c),key=uuid(req.params.id),redirects=(await c.query("select gone_id,keep_id from pulse.record_merge where entity_type='client' and undone_at is null")).rows;
  const resolve=(id:string)=>{for(let i=0;i<10;i++){const redirect=redirects.find(r=>r.gone_id===id);if(!redirect)break;id=redirect.keep_id;}return id;};
  if(!(await c.query('select id from pulse.client where id=$1',[resolve(key)])).rowCount)fail(404,'Client unavailable');
  const facts=movementSummary(s,(req.query as {month?:string}).month??new Date().toISOString().slice(0,7),'INR',2).clientCollections.filter(x=>resolve(x.clientId)===resolve(key));
  return {clientId:resolve(key),basis:'Reconciled invoice applications; collections and invoices are distinct; no lifetime value claim',facts,currencies:[...new Set(s.sources.map(s=>s.currency))],lifetimeValue:null};
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/finance/source',{schema:{body}},req=>tx(req,async(c,v)=>{
  await c.query('select pulse.finance_authorize(true)');
  const b={...req.body};b.ambiguous=b.ambiguous===true||b.ambiguous==='yes';b.partyConfirmed=b.partyConfirmed===true||b.partyConfirmed==='yes';b.aggregateApproved=b.aggregateApproved===true||b.aggregateApproved==='yes';
  if(b.accountLabel)b.account=createHash('sha256').update(v.org+'|'+text(b.accountLabel,160)).digest('hex');
  if(b.referenceText)b.reference=createHash('sha256').update(v.org+'|'+text(b.referenceText,160)).digest('hex');
  // Payroll input never includes names or employee-level settlements.
  if(b.kind==='payroll'){b.label='Approved aggregate payroll';if(Object.keys(b).some(k=>/employee|salary|person|name/i.test(k)))fail(400,'Individual payroll details belong in the restricted payroll system');}
  if(b.kind==='cash'&&text(b.category).toLowerCase()==='payroll'){if(!b.aggregateApproved||!b.originalId)fail(400,'Payroll settlement must be an approved aggregate linked to its batch; individual transfers stay in restricted evidence');b.label='Approved aggregate payroll settlement';b.party='payroll:aggregate';}
  const normalized=safe(()=>validateSource(b));
  if(normalized.projectId&&!/^[0-9a-f-]{36}$/.test(normalized.projectId))fail(400,'Choose a master project ID');
  if(normalized.clientId&&!/^[0-9a-f-]{36}$/.test(normalized.clientId))fail(400,'Choose a master client ID');
  for(const [table,key] of [['project',normalized.projectId],['client',normalized.clientId]] as const)if(key&&!(await c.query(`select id from pulse.${table} where id=$1`,[key])).rowCount)fail(404,'Master identity unavailable');
  return (await c.query('select pulse.finance_source_add($1) id',[JSON.stringify(normalized)])).rows[0];
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/finance/match/preview',{schema:{body}},req=>tx(req,async c=>{const s=await state(c);return safe(()=>allocationPreview(s,req.body));}));
 app.post<{Body:Record<string,unknown>}>('/api/v0/finance/match/accept',{schema:{body}},req=>tx(req,async c=>{
  await c.query('select pulse.finance_authorize(true)');await c.query("select pg_advisory_xact_lock(hashtextextended('finance:'||pulse.current_org()::text,0))");
  const s=await state(c),key=text(req.body.requestKey,160);if(!key)fail(400,'A stable decision request key is required');
  const previous=s.decisions.find(d=>d.body.requestKey===key);if(previous){const b=req.body;if(JSON.stringify(previous.body.links.map(l=>[l.sourceId,l.role,l.minor]))!==JSON.stringify(Array.isArray(b.links)?b.links.map((l: {sourceId:string;role:string;minor:number})=>[l.sourceId,l.role,l.minor]):null)||previous.body.reason!==text(b.reason)||previous.body.treatment!==b.treatment)fail(409,'Replay differs from original decision');return {id:previous.id,replayed:true};}
  if(req.body.rule==='exact-reference-party-currency-v1'){const pairs=exactCandidates(s);const links=req.body.links as {sourceId:string;role:string}[];if(!pairs.some(p=>p.unique&&links.length===2&&links.some(l=>l.role==='cash'&&l.sourceId===p.cashId)&&links.some(l=>l.role==='obligation'&&l.sourceId===p.obligationId)))fail(400,'Only a unique deterministic candidate can be reviewed as an exact rule prediction');}
  const preview=safe(()=>allocationPreview(s,req.body));return (await c.query('select pulse.finance_accept($1) id',[JSON.stringify(preview)])).rows[0];
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/finance/match/unlink',{schema:{body}},req=>tx(req,async c=>{await c.query('select pulse.finance_authorize(true)');await c.query('select pulse.finance_unlink($1,$2)',[uuid(req.body.id),text(req.body.reason)]);return {ok:true};}));
 app.post<{Body:Record<string,unknown>}>('/api/v0/finance/auto/preview',{schema:{body}},req=>tx(req,async c=>{
  const s=await state(c),rule=s.documents.filter(d=>d.kind==='rule').at(-1);
  const candidates=exactCandidates(s,Number(rule?.body.windowDays??45),text(rule?.body.provider)||undefined).filter(p=>{const cash=s.sources.find(x=>x.id===p.cashId)!;return p.unique&&(!rule||(cash.currency===rule.body.currency&&cash.scale===rule.body.scale&&cash.minor<=Number(rule.body.maxMinor)&&cash.cashDate.slice(0,7)===rule.body.month));});
  return {rule:rule??null,enabled:rule?.body.enabled===true,rows:candidates,policy:'Exact scoped reference, confirmed party, currency, scale, direction, amount and date window; no unsupported fee tolerance',limits:rule?.body??{},blocked:rule?.body.enabled===true?null:'No reviewed rule qualifies for promotion; review candidates manually'};
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/finance/auto/run',{schema:{body}},req=>tx(req,async c=>{
  await c.query('select pulse.finance_authorize(true)');await c.query("select pg_advisory_xact_lock(hashtextextended('finance:'||pulse.current_org()::text,0))");
  const s=await state(c),rule=s.documents.filter(d=>d.kind==='rule').at(-1);if(!rule||rule.body.enabled!==true)return fail(409,'A reviewed enabled exact rule is required');
  const ids=[];for(const p of exactCandidates(s,Number(rule.body.windowDays),text(rule.body.provider)||undefined).filter(p=>p.unique)){
   const cash=s.sources.find(x=>x.id===p.cashId)!;if(cash.minor>Number(rule.body.maxMinor)||cash.cashDate.slice(0,7)!==rule.body.month||cash.currency!==rule.body.currency||cash.scale!==rule.body.scale)continue;
   const preview=safe(()=>allocationPreview(s,{requestKey:`auto:${rule.id}:${p.cashId}`,links:[{sourceId:p.cashId,role:'cash',minor:cash.minor},{sourceId:p.obligationId,role:'obligation',minor:cash.minor}],treatment:'payment',reason:'Enabled reviewed exact rule '+rule.id,rule:p.rule}));
   const id=(await c.query('select pulse.finance_accept($1) id',[JSON.stringify(preview)])).rows[0].id;ids.push(id);
  }return {ok:true,accepted:ids.length};
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/finance/document',{schema:{body}},req=>tx(req,async c=>{
  await c.query('select pulse.finance_authorize(true)');const b=req.body,k=text(b.kind),p:Record<string,unknown>={};
  const copy=(keys:string[])=>{for(const key of keys)if(b[key]!==undefined)p[key]=typeof b[key]==='string'?text(b[key]):b[key];};
  if(k==='period'){copy(['account','statementBasis']);p.currency=currency(b.currency);p.scale=scale(b.scale);p.month=month(b.month);if(!/^[a-f0-9]{64}$/.test(text(p.account)))fail(400,'Choose an imported account digest');p.opening=b.opening===null||b.opening===''?null:safe(()=>integerMoney(b.opening));p.closing=b.closing===null||b.closing===''?null:safe(()=>integerMoney(b.closing));p.complete=b.complete===true||b.complete==='yes';}
  else if(k==='balance'){copy(['account','statementBasis']);p.currency=currency(b.currency);p.scale=scale(b.scale);p.asOf=day(b.asOf);p.minor=safe(()=>integerMoney(b.minor));p.coverageComplete=b.coverageComplete===true||b.coverageComplete==='yes';if(!/^[a-f0-9]{64}$/.test(text(p.account))||!p.statementBasis)fail(400,'Account digest and statement evidence required');}
  else if(k==='budget'||k==='commitment'){copy(['category','reason','billedSourceKey','projectId','commitmentKey']);p.month=month(b.month);p.currency=currency(b.currency);p.scale=scale(b.scale);p.minor=safe(()=>integerMoney(b.minor));if(!p.category||!p.reason)fail(400,'Category and reason required');if(k==='commitment'&&!p.commitmentKey)fail(400,'A stable commitment key is required');if(k==='budget'){p.status=text(b.status);if(!['proposed','submitted','approved'].includes(text(p.status)))fail(400,'Choose budget status');}}
  else if(k==='schedule'){copy(['scheduleKey','label','basis','sourceId']);p.currency=currency(b.currency);p.scale=scale(b.scale);p.date=day(b.date);p.minor=safe(()=>integerMoney(b.minor));p.direction=text(b.direction);p.protected=b.protected===true||b.protected==='yes';if(!p.scheduleKey||!p.basis||!['inflow','outflow'].includes(text(p.direction)))fail(400,'Schedule key basis and direction required');if(p.protected)p.label='Approved aggregate payroll';}
  else if(k==='case'){copy(['category','owner','dueDate','description','sourceIds','action','closeImpact']);p.month=month(b.month);p.currency=currency(b.currency);if(!['missing_movement','duplicate','timing','transfer','identity','fee','amount_unit','coverage'].includes(text(p.category)))fail(400,'Choose discrepancy reason');if(!p.owner||!p.description)fail(400,'Case owner and description required');p.dueDate=day(p.dueDate);}
  else if(k==='case_resolution'){copy(['caseId','reason','action']);const s=await state(c);if(!s.documents.some(d=>d.kind==='case'&&d.id===p.caseId)||!p.reason)fail(400,'Choose an open case and a supported resolution reason');}
  else if(k==='vendor'){copy(['vendorKey','product','billingAccount','contract','owner','cancellationDeadline','term','cycle','renewalDate','usageBasis','previousCurrency','planChange','discountExpiry','eligibleSavingsBasis','ownerId']);if(!p.vendorKey||!p.product)fail(400,'Normalized vendor and product required');p.currency=currency(b.currency);p.scale=scale(b.scale);for(const key of ['minor','previousMinor','seats','previousSeats','tax','previousTax','eligibleSavings','realizedSavings'])p[key]=b[key]===null||b[key]===undefined||b[key]===''?null:safe(()=>integerMoney(b[key]));p.activeConfirmed=b.activeConfirmed===true||b.activeConfirmed==='yes';p.usageKnown=b.usageKnown===true||b.usageKnown==='yes';p.failedPayment=b.failedPayment===true||b.failedPayment==='yes';if(!['monthly','annual','quarterly','unknown'].includes(text(p.cycle)))fail(400,'Choose a confirmed billing cadence');if(Number(p.eligibleSavings)>0&&!p.eligibleSavingsBasis)fail(400,'Eligible savings needs confirmed contract evidence');}
  else if(k==='rule'){copy(['reviewedDecisionIds','negativeCaseIds','provider']);if(!['bank','card','upi','gateway'].includes(text(p.provider)))fail(400,'A provider-specific date-window rule is required');p.currency=currency(b.currency);p.scale=scale(b.scale);for(const key of ['reviewedDecisionIds','negativeCaseIds'])if(typeof b[key]==='string')p[key]=String(b[key]).slice(0,50000).split(/[\s,]+/).filter(Boolean);p.windowDays=Number(b.windowDays);p.maxMinor=safe(()=>integerMoney(b.maxMinor));p.month=month(b.month);if(!Number.isInteger(p.windowDays)||Number(p.windowDays)<0||Number(p.windowDays)>90)fail(400,'Date window must be reviewed and bounded');const s=await state(c);const ids=Array.isArray(p.reviewedDecisionIds)?[...new Set(p.reviewedDecisionIds.map(String))]:[],negative=Array.isArray(p.negativeCaseIds)?p.negativeCaseIds.map(String):[];const reviewed=ids.map(id=>s.decisions.find(d=>d.id===id&&d.body.rule==='exact-reference-party-currency-v1'));const negatives=negative.filter(id=>s.documents.some(d=>d.kind==='case_resolution'&&d.id===id&&text(d.body.reason).startsWith('Rejected ambiguous match:')));const precision=ids.length?reviewed.filter(d=>d?.active).length/ids.length:0;p.sample=ids.length;p.precision=precision;p.enabled=b.enabled===true||b.enabled==='yes';if(p.enabled&&(ids.length<200||precision<.995||!negatives.length||reviewed.some(d=>!d)))fail(409,'Promotion requires 200 reviewed exact predictions, 99.5% precision and reviewed ambiguous negatives');p.rule='exact-reference-party-currency-v1';}
  else if(k==='adjustment'){copy(['closeId','reason','decisionId']);const s=await state(c);if(!s.documents.some(d=>d.kind==='close'&&d.id===p.closeId)||!p.reason)fail(400,'Frozen close and correction reason required');}
  else if(k==='forecast'){const s=await state(c),q={start:day(b.start),month:month(b.month),currency:currency(b.currency),scale:String(scale(b.scale)),scenario:text(b.scenario)||'base'};const v=safe(()=>view(s,q));if(!v.forecast.certified)fail(409,v.forecast.reason??'Forecast inputs uncertified');p.retrospective=q.start<new Date().toISOString().slice(0,10);p.evaluationEligible=!p.retrospective;p.start=q.start;p.currency=q.currency;p.scale=Number(q.scale);p.scenario=q.scenario;const shifts:Record<string,string>={};if(b.scenarioShifts&&typeof b.scenarioShifts==='object'&&!Array.isArray(b.scenarioShifts)){for(const [id,date] of Object.entries(b.scenarioShifts as Record<string,unknown>)){if(!v.schedule.some(x=>x.id===id&&x.direction==='inflow'))fail(400,'Only a scheduled receipt date can move in a scenario');shifts[id]=day(date);}}p.scenarioShifts=shifts;p.weeks=weeklyForecast(v.forecast.opening,q.start,v.schedule.map(x=>({...x,date:shifts[x.id]??x.date})),true,v.forecast.scenario as 'base'|'downside'|'upside').weeks;p.verifiedCashCutoff=v.forecast.sourceCutoff;p.sourceIds=s.sources.map(x=>x.id);p.sourceCutoff=new Date().toISOString();p.assumptionIds=v.schedule.map(x=>x.id);p.model='direct-weekly-schedule-v1';p.interval='Uncalibrated; no statistical interval';}
  else fail(400,'Unknown finance document kind');
  if(k==='vendor'&&p.ownerId){if(!(await c.query("select id from pulse.person where id=$1 and side='staff' and status='active'",[uuid(p.ownerId)])).rowCount)fail(400,'Choose an active contract owner');}
  if(k==='case'&&p.action){const existing=(await state(c)).documents.find(d=>d.kind==='case'&&d.body.action===p.action&&d.body.month===p.month&&d.body.currency===p.currency);if(existing)return {id:existing.id,replayed:true};}
  const made=(await c.query('select pulse.finance_document_add($1,$2) id',[k,JSON.stringify(p)])).rows[0];if(k==='vendor'&&p.failedPayment){const sourceKey=`vendor:${p.vendorKey}|${p.product}|${p.billingAccount}|${p.contract}`;await c.query('select pulse.finance_task($1,$2,$3,$4)', ['billing_failure',sourceKey,p.ownerId||null,null]);}return made;
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/finance/task',{schema:{body}},req=>tx(req,async c=>{
  await c.query('select pulse.finance_authorize(true)');const b=req.body,kind=text(b.taskKind);if(!['collection','funding','contract_review','billing_failure'].includes(kind)||!text(b.sourceKey,160))fail(400,'Choose an explicit finance review action');
  return (await c.query('select pulse.finance_task($1,$2,$3,$4) id',[kind,text(b.sourceKey,160),uuid(b.ownerId),day(b.dueDate)])).rows[0];
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/finance/close',{schema:{body}},req=>tx(req,async c=>{
  await c.query('select pulse.finance_authorize(true)');return (await c.query('select pulse.finance_close($1,$2,$3,$4) id',[month(req.body.month),currency(req.body.currency),scale(req.body.scale),text(req.body.reason)])).rows[0];
 }));
}
