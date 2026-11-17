/** Accounting contract for Round 10. This module is never imported by the general rail.
 * Values require certified sources AND an explicitly approved policy; receipt funding is ineligible. */
export type RevenueFact={id:string;kind:'invoice'|'credit'|'collection'|'refund';invoiceId:string;settlementId?:string;gross:number;tax:number;mediaPassThrough:number;currency:string;date:string;certified:boolean};
export function observedClientValue(facts:RevenueFact[],policyApproved:boolean,history:{from:string;to:string;complete:boolean}|null) {
 if(!policyApproved||!history||!facts.length||facts.some(f=>!f.certified))return {state:'unknown' as const,invoiced:null,collected:null,label:'Unknown client value',reason:'Certified sources, declared coverage and approved accounting policy are required.'};
 const ids=new Map<string,RevenueFact>(),settlements=new Map<string,RevenueFact>();
 for(const f of facts){if(![f.gross,f.tax,f.mediaPassThrough].every(Number.isFinite)||f.tax<0||f.mediaPassThrough<0||f.gross<0||f.tax+f.mediaPassThrough>f.gross||f.date<history.from||f.date>history.to)throw new Error('Invalid or uncovered accounting fact');const old=ids.get(f.id);if(old&&JSON.stringify(old)!==JSON.stringify(f))throw new Error('Conflicting accounting receipt');ids.set(f.id,f);}
 const invoices=new Set([...ids.values()].filter(f=>f.kind==='invoice').map(f=>f.invoiceId));
 const invoiceReceipts=new Map<string,RevenueFact>();
 const totals=new Map<string,{currency:string;invoiced:number;collected:number}>();
 for(const f of ids.values()) {
  if(f.kind==='invoice'){const key=f.currency+':'+f.invoiceId,old=invoiceReceipts.get(key);if(old){if(old.gross!==f.gross||old.tax!==f.tax||old.mediaPassThrough!==f.mediaPassThrough||old.date!==f.date)throw new Error('Conflicting invoice receipt');continue;}invoiceReceipts.set(key,f);}
  if(f.kind!=='invoice'&&!invoices.has(f.invoiceId))throw new Error('Unresolved invoice application');
  if(f.kind==='collection'||f.kind==='refund') {
   if(!f.settlementId)throw new Error('A reconciled bank application needs stable settlement identity');
   const key=f.kind+':'+f.settlementId+':'+f.invoiceId,old=settlements.get(key);
   if(old){if(old.gross!==f.gross||old.tax!==f.tax||old.mediaPassThrough!==f.mediaPassThrough||old.currency!==f.currency)throw new Error('Conflicting bank application');continue;}settlements.set(key,f);
  }
  const n=f.gross-f.tax-f.mediaPassThrough,row=totals.get(f.currency)??{currency:f.currency,invoiced:0,collected:0};
  if(f.kind==='invoice')row.invoiced+=n;if(f.kind==='credit')row.invoiced-=n;if(f.kind==='collection')row.collected+=n;if(f.kind==='refund')row.collected-=n;totals.set(f.currency,row);
 }
 return {state:'observed' as const,coveredDates:history,label:history.complete?'Lifetime, declared complete history':'Observed net revenue in covered dates',totals:[...totals.values()],futureContribution:null};
}
