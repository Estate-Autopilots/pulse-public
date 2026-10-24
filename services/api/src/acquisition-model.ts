import {createHmac,createCipheriv,createDecipheriv,randomBytes,timingSafeEqual,createHash} from 'node:crypto';
export type Obj=Record<string,unknown>;
const str=(x:unknown,n=1000)=>typeof x==='string'?x.trim().slice(0,n):'';
const date=(x:unknown)=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(x)&&Number.isFinite(Date.parse(x));
export function managedKeys(env:NodeJS.ProcessEnv=process.env){
 const raw=env.PULSE_ACQUISITION_IDENTITY_KEYS;if(!raw)return [];
 let keys:{version:string;key:string}[];try{keys=JSON.parse(raw);}catch{throw new Error('Versioned managed identity key configuration is invalid');}
 if(!Array.isArray(keys)||!keys.length||keys.length>4||keys.some(k=>!/^v[0-9]+$/.test(k.version)||! /^[a-f0-9]{64}$/.test(k.key)))throw new Error('Versioned managed identity keys are invalid');
 return keys;
}
/** The alias normaliser: strips spaces, brackets, dots and dashes; aliases are 'phone:'+this value. */
export const cleanPhone=(x:unknown)=>str(x,40).replace(/[\s().-]/g,'');
export function protectContact(controller:string,path:string,input:Obj,env:NodeJS.ProcessEnv=process.env){
 const phone=cleanPhone(input.phone),email=str(input.email,200).toLowerCase();
 if(phone&&!/^\+[1-9][0-9]{7,14}$/.test(phone))throw new Error('Use an international phone number with country code');
 if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Contact email is invalid');
 const keys=managedKeys(env),fields={phone,email,name:str(input.name,160)};
 if(!phone&&!email&&!fields.name)return {aliases:[],contact:{},phoneAvailable:false};
 if(!keys.length)throw new Error('Protected identity service is not configured; import source IDs without contact fields');
 const aliases=keys.flatMap(k=>[phone&&'phone:'+phone,email&&'email:'+email].filter(Boolean).map(identity=>({version:k.version,key:createHmac('sha256',Buffer.from(k.key,'hex')).update(controller+'|'+path+'|'+identity).digest('hex')})));
 const iv=randomBytes(12),aad=Buffer.from(controller+'|'+path),cipher=createCipheriv('aes-256-gcm',Buffer.from(keys[0].key,'hex'),iv);cipher.setAAD(aad);
 const data=Buffer.concat([cipher.update(JSON.stringify(fields),'utf8'),cipher.final()]);
 return {aliases,contact:{version:keys[0].version,iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('hex'),controller,path},phoneAvailable:!!phone};
}
export function revealContact(contact:Obj,env:NodeJS.ProcessEnv=process.env){
 if(!contact.data)return {available:false,reason:'No protected contact available'};
 const key=managedKeys(env).find(k=>k.version===contact.version);if(!key)return {available:false,reason:'Contact key version unavailable'};
 const cipher=createDecipheriv('aes-256-gcm',Buffer.from(key.key,'hex'),Buffer.from(String(contact.iv),'hex'));cipher.setAAD(Buffer.from(contact.controller+'|'+contact.path));cipher.setAuthTag(Buffer.from(String(contact.tag),'hex'));
 return {available:true,...JSON.parse(Buffer.concat([cipher.update(Buffer.from(String(contact.data),'hex')),cipher.final()]).toString('utf8'))};
}
export function normalizeLead(input:Obj,scope:{controller:string;path:string;namespace:string},env:NodeJS.ProcessEnv=process.env){
 if(input.path&&input.path!==scope.path)throw new Error('Revenue paths cannot mix; hiring stays outside acquisition');
 const leadId=str(input.leadId,160);if(!leadId||input.identityBasis==='ephemeral')throw new Error('Authorized source lead or row ID required; ephemeral export keys are not durable identity');
 if(!date(input.occurred)||Date.parse(String(input.occurred))>Date.now()+300000)throw new Error('Unambiguous source timestamp with timezone required');
 if(!str(input.notice,160))throw new Error('Source notice version required');
 const contact=protectContact(scope.controller,scope.path,input,env);
 return {leadId,namespace:scope.namespace,path:scope.path,identityClass:contact.aliases.length?'protected_keyed':'source_id_only',notice:str(input.notice,160),consent:input.consent===true,optOut:input.optOut===true,offer:str(input.offer,160),formId:str(input.formId,160),campaignId:str(input.campaignId,160),adId:str(input.adId,160),creativeId:str(input.creativeId,160),utmSource:str(input.utmSource,160),utmCampaign:str(input.utmCampaign,160),clickId:str(input.clickId,200),intent:str(input.intent,240),test:input.isTest===true,coverage:false,callback:null,...contact};
}
export function envelope(input:Obj,normalized:Obj){return {objectId:str(input.objectId??input.leadId,160),vintage:str(input.vintage??'v1',160),occurred:input.occurred,batchHash:createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),normalized};}
export function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return !!x.length&&x.length===y.length&&timingSafeEqual(x,y);}
export function verifyTransport(kind:string,raw:Buffer,signature:string,secret:string){return !!secret&&(kind==='google_forms'?equal(signature,secret):equal(signature,'sha256='+createHmac('sha256',secret).update(raw).digest('hex')));}
export function googleLead(p:Obj):Obj{
 const columns=Array.isArray(p.user_column_data)?p.user_column_data as Obj[]:[];
 const value=(id:string)=>columns.find(c=>c.column_id===id)?.string_value;
 return {leadId:str(p.lead_id,160),occurred:p.lead_submit_time,phone:value('PHONE_NUMBER'),email:value('EMAIL'),name:value('FULL_NAME'),formId:String(p.form_id??''),campaignId:String(p.campaign_id??''),creativeId:p.creative_id?String(p.creative_id):'',clickId:str(p.gcl_id,200),isTest:p.is_test===true};
}
export function retryDelay(attempt:number,random=0.5){return Math.min(21600000,1000*2**Math.min(15,Math.max(0,attempt)))*(0.75+Math.max(0,Math.min(1,random))*0.5);}
export type Interval={start:string;end:string};
export function staffedAge(start:string,end:string,calendar:Interval[]){const a=Date.parse(start),b=Date.parse(end);if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)throw new Error('Valid ordered source times required');const ranges=calendar.map(i=>[Math.max(a,Date.parse(i.start)),Math.min(b,Date.parse(i.end))]).filter(i=>Number.isFinite(i[0])&&Number.isFinite(i[1])&&i[1]>i[0]).sort((a,b)=>a[0]-b[0]);let total=0,lo=0,hi=0;for(const [x,y]of ranges){if(x>hi){total+=hi-lo;lo=x;hi=y;}else hi=Math.max(hi,y);}return {elapsedMs:b-a,staffedMs:calendar.length?total+hi-lo:null};}
export function nextStaffed(now:string,calendar:Interval[]){const n=Date.parse(now);return calendar.map(i=>[Date.parse(i.start),Date.parse(i.end)]).filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>n).sort((a,b)=>a[0]-b[0]).map(([a])=>new Date(Math.max(a,n)).toISOString())[0]??null;}
export function nextAction(l:Obj,source:Obj,now:string){const events=Array.isArray(l.events)?l.events as Obj[]:[],calendar=Array.isArray((source.body as Obj)?.calendar)?(source.body as Obj).calendar as Interval[]:[];
 const first=events.filter(e=>['attempt','connected'].includes(String(e.stage))).map(e=>String(e.effective)).sort()[0];
 const age=staffedAge(String(l.occurred),now,calendar);
 const base={owner:l.owner,ownerId:l.ownerId,enquiryId:l.id,...age,firstTouch:first??null,firstTouchAge:first?staffedAge(String(l.occurred),first,calendar):null,evidence:['Source timestamp','Logged call metadata','Contact authority'],missingAlternatives:['Appointment capacity','Complete client outcomes','Comparable delivered spend']};
 if(l.optOut||!l.consent||!l.phoneAvailable)return {...base,reason:l.optOut?'Excluded · contact opted out':'Correct missing phone / contact authority',next:null,rank:-1};
 if(source.state==='revoked'||source.state==='failed')return {...base,reason:'Reconnect source and recover missed enquiries',next:'Source owner reconnect task',rank:4};
 return {...base,reason:l.callback?'Honor the promised callback':'Follow up in the next staffed window',next:l.callback??nextStaffed(now,calendar),rank:l.callback?5:2};
}
export function metric(input:{spend:number;count:number;buyers:number;currency:string;scale:number;basis:string;window:string;comparable:boolean;coverage:number;sourceCurrent:boolean}){
 const available=input.basis==='delivered'&&input.comparable&&input.sourceCurrent&&input.count>0;
 return {...input,cpl:available?input.spend/input.count:null,uniqueBuyerCost:available&&input.buyers?input.spend/input.buyers:null,reason:available?'Comparable delivered spend / documented enquiries':'Comparable delivered spend attribution or source coverage unavailable',causal:false};
}
// Priors must come from comparable reviewed projects; these are descriptive posterior summaries, never causal ROI.
export function betaBinomial(success:number,total:number,alpha:number,beta:number){if(![success,total,alpha,beta].every(Number.isFinite)||!Number.isInteger(success)||!Number.isInteger(total)||success<0||total<success||alpha<=0||beta<=0)throw new Error('Comparable counts and positive priors required');const a=alpha+success,b=beta+total-success;return {mean:a/(a+b),variance:a*b/((a+b)**2*(a+b+1)),alpha:a,beta:b,causal:false};}
export function gammaPoisson(leads:number,spend:number,alpha:number,beta:number){if(![leads,spend,alpha,beta].every(Number.isFinite)||!Number.isInteger(leads)||leads<0||spend<0||alpha<=0||beta<=0)throw new Error('Comparable leads spend and positive priors required');const a=alpha+leads,b=beta+spend;return {rate:a/b,variance:a/b**2,cplMean:a>1?b/(a-1):null,cplVariance:a>2?b**2/((a-1)**2*(a-2)):null,cplUncertainty:'Inverse gamma; infinite moments are withheld',causal:false};}
export function whatsappCapability(p:Obj){return {oneToOne:p.companyNumber===true&&p.participantsVerified===true,newGroup:p.companyNumber===true&&p.oba===true&&p.entitlement===true&&p.coexistence!==true&&p.multiSolution!==true&&Number(p.participants)>=1&&Number(p.participants)<=8,existingHistory:false,calling:false,templateAnalytics:false,maxParticipants:8,maxGroups:10000};}
export function sendAllowed(p:Obj,now:string){if(p.optOut===true||p.contactAuthority!==true)return false;if(p.group===true)return p.groupCapabilityTested===true&&p.templateAllowed===true&&p.optIn===true;const open=date(p.lastInbound)&&Date.parse(now)-Date.parse(String(p.lastInbound))>=0&&Date.parse(now)-Date.parse(String(p.lastInbound))<=86400000;return p.marketing===true?p.optIn===true&&p.approvedTemplate===true:open||(p.approvedTemplate===true&&p.optIn===true);}

export function quarantineLead(input:Obj,scope:{controller:string;path:string;namespace:string},reason:string,env:NodeJS.ProcessEnv=process.env){
 const key=managedKeys(env)[0];let contact:Obj={};
 if(key){const fields={phone:str(input.phone,40),email:str(input.email,200),name:str(input.name,160)},iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key.key,'hex'),iv);cipher.setAAD(Buffer.from(scope.controller+'|'+scope.path));const data=Buffer.concat([cipher.update(JSON.stringify(fields),'utf8'),cipher.final()]);contact={version:key.version,iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('hex'),controller:scope.controller,path:scope.path};}
 return {leadId:str(input.leadId,160),namespace:scope.namespace,path:scope.path,notice:str(input.notice,160),test:input.isTest===true,consent:input.consent===true,optOut:input.optOut===true,phoneAvailable:false,aliases:[],contact,quarantine:true,issues:[reason],identityClass:'source_id_only',timeBasis:'Received time; source timestamp not validated'};
}
