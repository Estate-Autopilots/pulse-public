import {isId,validateEvent} from './native-validation.js';
export const QUEUE_DAYS=7;
export const itemsByPurpose:Record<string,string[]>={activity_context:['work_app_category','focus_idle_aggregate'],work_evidence:['render_export_metadata','structural_edit_delta'],work_sites:['authorized_project_id'],shoot_presence:['explicit_shoot_wrap'],command_counts:['work_command_categories']};
const exact=(o:Record<string,unknown>,keys:string[])=>Object.keys(o).every(k=>keys.includes(k));
export function eventReceipt(raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid evidence');const r=raw as Record<string,unknown>;
 if(!exact(r,['id','deviceId','personId','purpose','kind','at','projectId','data','consentReceipt','sourceSession','sequence','intervalStart'])||!isId(r.consentReceipt)||!isId(r.sourceSession)||!Number.isSafeInteger(r.sequence)||Number(r.sequence)<0)throw Error('Source identity and permission receipt required');
 const {consentReceipt,sourceSession,sequence,intervalStart,...base}=r;
 const e=validateEvent(base);const start=Date.parse(String(intervalStart??e.at));const end=Date.parse(e.at);
 if(!Number.isFinite(start)||start>end||end-start>3600000)throw Error('Bounded source interval required');
 const duration=e.kind==='usage'?Number(e.data.activeSeconds)+Number(e.data.idleSeconds):e.kind==='site'?Number(e.data.seconds):0;
 if(duration>(end-start)/1000+1)throw Error('Duration exceeds source interval');
 return {...e,consentReceipt:consentReceipt as string,sourceSession:sourceSession as string,sequence:Number(sequence),intervalStart:new Date(start).toISOString()};
}
export function workWindow(at:string,window:{start?:string;end?:string;timezone?:string}){
 if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.start??'')||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.end??''))return false;
 try{const parts=new Intl.DateTimeFormat('en-GB',{timeZone:window.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at));const start=window.start!,end=window.end!;return start<end?parts>=start&&parts<end:start>end&&(parts>=start||parts<end);}catch{return false;}
}
/** Personal context only. Union overlapping devices/sources; source gaps add no time. */
export function contextUnion(intervals:{start:string;end:string}[]){const ordered=intervals.map(i=>[Date.parse(i.start),Date.parse(i.end)]).filter(([s,e])=>Number.isFinite(s)&&Number.isFinite(e)&&e>=s).sort((a,b)=>a[0]-b[0]);let total=0,end=-Infinity;for(const [s,e] of ordered){total+=Math.max(0,e-Math.max(s,end));end=Math.max(e,end);}return Math.floor(total/1000);}
export function verifiedSite(s:Record<string,unknown>){return s.precision==='verified_site'&&typeof s.verifiedBy==='string'&&s.verifiedBy.length>=3&&Number.isFinite(s.latitude)&&Math.abs(Number(s.latitude))<=90&&Number.isFinite(s.longitude)&&Math.abs(Number(s.longitude))<=180&&Number(s.radiusMeters)>=50&&Number(s.radiusMeters)<=300&&Date.parse(String(s.startsAt))<Date.parse(String(s.endsAt));}
