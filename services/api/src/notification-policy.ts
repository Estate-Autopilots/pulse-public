export const TYPES=['chat','mention','reply','approval','decision','policy','holiday','payroll','task','attendance','update'] as const;
export const CHANNELS=['local','web','native','telegram','email'] as const;
/** ATT: the families a person may mute (pulse.notification_family, 0860). Muted: still in the bell, never a toast, push or mail. */
export const FAMILIES=['attendance_reminders','attendance_questions','attendance_confirmations','attendance_digest','approvals','my_requests','mentions','chats',
 'tasks_assigned','tasks_waiting','tasks_due','reviews','task_updates','domains','processes','pay','profile','company_updates'] as const;
export type PingSettings={dnd:boolean;quiet:boolean;start:string;end:string;timezone:string;types:Record<string,boolean>;channels:Record<string,boolean>;nightShift:boolean;snoozedUntil:string|null;reminders:{done:boolean};mute:Record<string,boolean>};
/** A person's notification settings; quiet hours default to the company's zone (`zone`). */
export function pingSettings(raw:unknown,zone:string):PingSettings {
 const p=(raw&&typeof raw==='object'?raw:{}) as Record<string,unknown>;
 const timezone=typeof p.timezone==='string'?p.timezone:zone;
 try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{throw Error('Choose a valid time zone');}
 const time=(x:unknown,fallback:string)=>{if(x===undefined)return fallback;if(typeof x!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(x))throw Error('Use hours and minutes');return x;};
 const t=(p.types&&typeof p.types==='object'?p.types:{}) as Record<string,unknown>;
 const ch=(p.channels&&typeof p.channels==='object'?p.channels:{}) as Record<string,unknown>;
 const reminders=(p.reminders&&typeof p.reminders==='object'?p.reminders:{}) as Record<string,unknown>;
 const mute=(p.mute&&typeof p.mute==='object'?p.mute:{}) as Record<string,unknown>;
 let snoozedUntil:string|null=null;
 if(p.snoozedUntil!==undefined&&p.snoozedUntil!==null){
  if(typeof p.snoozedUntil!=='string'||!Number.isFinite(Date.parse(p.snoozedUntil))||Date.parse(p.snoozedUntil)>Date.now()+86400000)throw Error('Snooze for at most 24 hours');
  snoozedUntil=new Date(p.snoozedUntil).toISOString();
 }
 return {dnd:p.dnd===true,quiet:p.quiet===true,start:time(p.start,'21:00'),end:time(p.end,'08:00'),timezone,types:Object.fromEntries(TYPES.map(k=>[k,t[k]!==false])),channels:Object.fromEntries(CHANNELS.map(k=>[k,ch[k]!==false])),nightShift:p.nightShift===true,snoozedUntil,reminders:{done:reminders.done===true},mute:Object.fromEntries(FAMILIES.map(k=>[k,mute[k]===true]))};
}
export function pingAllowed(kind:string,settings:PingSettings,at=new Date(),context:{channel?:string;approvedShift?:boolean}={}):boolean {
 if(settings.dnd||settings.types[kind]===false||settings.channels[context.channel??'local']===false||(settings.snoozedUntil&&Date.parse(settings.snoozedUntil)>at.getTime()))return false;
 if(!settings.quiet)return true;
 if(settings.nightShift&&context.approvedShift===true)return true;
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:settings.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(at);
 const {start,end}=settings;
 return !(start===end|| (start<end?parts>=start&&parts<end:parts>=start||parts<end));
}
export function pushEndpoint(raw:unknown):string {
 if(typeof raw!=='string'||raw.length>2048)throw Error('Invalid push subscription');
 const url=new URL(raw);
 const allowed=['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'];
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!allowed.some(h=>url.hostname===h||url.hostname.endsWith('.'+h))||url.pathname==='/')throw Error('Unsupported push provider');
 return raw;
}
