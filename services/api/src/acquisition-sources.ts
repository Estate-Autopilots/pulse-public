import type {Obj} from './acquisition-model.js';
import {equal} from './acquisition-model.js';
import {createHmac} from 'node:crypto';
export type ProbeConfig={sourceId:string;kind:string;account:string;url:string;token:string;expires:string;currency?:string;timezone?:string;apiVersion:string;attribution?:string;expectedCount?:number};
const hosts:Record<string,string[]>={meta_delivery:['graph.facebook.com'],meta_leads:['graph.facebook.com'],google_ads:['googleads.googleapis.com'],zoho:['www.zohoapis.com','www.zohoapis.in','www.zohoapis.eu','www.zohoapis.com.au','www.zohoapis.jp','www.zohoapis.ca'],gmail:['gmail.googleapis.com'],calendar:['www.googleapis.com'],contacts:['people.googleapis.com'],meet:['meet.googleapis.com']};
// Endpoint URLs and secrets are operator configuration, never submitted by a user. All probes are read-only.
export async function probeSource(cfg:ProbeConfig,fetcher:typeof fetch=fetch){
 const root=new URL(cfg.url);if(!hosts[cfg.kind]?.includes(root.hostname)||root.protocol!=='https:'||root.username||root.password||root.port||root.searchParams.has('access_token'))throw new Error('Approved read-only provider endpoint required');
 const pathOk=cfg.kind==='google_ads'?root.pathname.endsWith(':search'):cfg.kind==='meta_delivery'?root.pathname.endsWith('/insights'):cfg.kind==='meta_leads'?/\/(leadgen_forms|leads)$/.test(root.pathname):cfg.kind==='zoho'?/\/(books|invoice)\/v[34]\/(contacts|invoices|customerpayments|creditnotes|estimates|salesorders)$/.test(root.pathname):cfg.kind==='gmail'?/\/gmail\/v1\/users\/[^/]+\/(history|messages)$/.test(root.pathname):cfg.kind==='calendar'?/\/calendar\/v[34]\/calendars\/[^/]+\/events$/.test(root.pathname):cfg.kind==='contacts'?root.pathname==='/v1/people/me/connections':cfg.kind==='meet'?root.pathname==='/v2/conferenceRecords':false;
 if(cfg.kind==='zoho'&&root.searchParams.get('organization_id')!==cfg.account)throw new Error('Selected Zoho organization and regional host required');
 if(cfg.kind==='meta_delivery'&&!root.pathname.includes('/act_'+cfg.account+'/'))throw new Error('Selected ad account endpoint required');
 if(!pathOk||!cfg.token||!cfg.account||!cfg.apiVersion)throw new Error('Test the requested reporting endpoint and selected account');
 let url=cfg.url,count=0,pages=0;let cursor:string|null=null;
 do {
 if(++pages>20)throw new Error('Pagination exceeded bounded read; last cursor retained');
 const response=await fetcher(url,{method:cfg.kind==='google_ads'?'POST':'GET',headers:{authorization:(cfg.kind==='zoho'?'Zoho-oauthtoken ':'Bearer ')+cfg.token,'content-type':'application/json'},...(cfg.kind==='google_ads'?{body:JSON.stringify({query:'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'})}:{}),redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error(response.status===401||response.status===403?'Grant revoked or requested endpoint denied':'Source read failed; cursor retained');
 const p=await response.json() as Obj;
 const items=[p.data,p.results,p.items,p.connections,p.conferenceRecords,p.messages,p.history,p.invoices,p.contacts,p.customerpayments,p.creditnotes,p.estimates,p.salesorders].find(Array.isArray) as Obj[]|undefined;
 if(!items)throw new Error('Unexpected provider schema; cursor retained');count+=items.length;
 if(cfg.kind==='google_ads'&&items.some(r=>String((r.customer as Obj)?.id)!==cfg.account||cfg.currency&&(r.customer as Obj)?.currencyCode!==cfg.currency))throw new Error('Customer or API currency control conflict');
 if(cfg.kind==='meta_delivery'&&items.some(r=>r.account_id!==cfg.account||cfg.currency&&r.account_currency!==cfg.currency))throw new Error('Ad account or API currency control conflict');
 const paging=p.paging as Obj|undefined,context=p.page_context as Obj|undefined,next=paging?.next;
 cursor=String(p.nextSyncToken??p.historyId??'')||cursor;
 if(next){const target=new URL(String(next));if(target.origin!==root.origin||target.pathname!==root.pathname||target.searchParams.has('access_token'))throw new Error('Unsafe provider pagination; use token-free cursor pagination');url=target.toString();}
 else if(p.nextPageToken){const target=new URL(cfg.url);target.searchParams.set('pageToken',String(p.nextPageToken));url=target.toString();}
 else if(context?.has_more_page===true){const target=new URL(cfg.url);target.searchParams.set('page',String(pages+1));url=target.toString();}
 else url='';
 }while(url);
 if(cfg.expectedCount!==undefined&&count!==cfg.expectedCount)throw new Error('Provider control count differs; cursor retained');
 if(!cfg.expires||Date.parse(cfg.expires)<=Date.now())throw new Error('Grant expiry evidence required');
 return {kind:cfg.kind,account:cfg.account,endpoint:root.origin+root.pathname,grantTest:'passed',complete:true,controlCount:count,cutoff:new Date().toISOString(),expires:cfg.expires,currency:cfg.currency,timezone:cfg.timezone,apiVersion:cfg.apiVersion,attribution:cfg.attribution,cursor};
}
// Authorized parser/scanner receipt, with no binary/chat content. Untrusted attachments cannot mark themselves clean.
export function documentProposal(p:Obj,secret:string,signature:string){
 if(!secret||!equal(signature,'sha256='+createHmac('sha256',secret).update(JSON.stringify(p)).digest('hex')))throw new Error('Trusted isolated scanner receipt required');
 if(p.purpose!=='finance'||! /^[a-f0-9]{64}$/.test(String(p.contentHash))||Number(p.bytes)>10485760||Number(p.bytes)<1||p.malware!=='clean'||p.parserVersion!=='finance-v1')throw new Error('Attachment purpose size scan or parser validation failed');
 const fields=p.fields as Obj,confidence=p.confidence as Obj;
 if(!fields||!confidence)throw new Error('Document fields and confidence required');
 const currency=String(fields.currency??''),minor=Number(fields.minor);
 const ambiguous=!/^[A-Z]{3}$/.test(currency)||!Number.isSafeInteger(minor)||minor<0||minor>9e12||Number(confidence.currency)<0.99||Number(confidence.minor)<0.99;
 return {contentHash:p.contentHash,label:String(p.label??'Finance document').slice(0,160),fields:{currency,minor,scale:Number(fields.scale),date:fields.date,vendor:String(fields.vendor??'').slice(0,160)},confidence:{currency:confidence.currency,minor:confidence.minor},malware:'clean',parserVersion:'finance-v1',ambiguous,kind:'bill',toolsAllowed:false};
}
