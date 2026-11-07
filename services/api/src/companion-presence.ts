import { isIP, BlockList } from 'node:net';
import type { PoolClient } from 'pg';
import { fail, type Viewer } from './routes.js';

const blocked = new BlockList();
for (const [network,bits] of [['0.0.0.0',8],['10.0.0.0',8],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['100.64.0.0',10],['224.0.0.0',4]] as const) blocked.addSubnet(network,bits);
export function cleanRanges(raw:unknown):string[] {
 if (raw === undefined) return [];
 if (!Array.isArray(raw) || raw.length>16) fail(400,'Add up to 16 office public IP ranges');
 return [...new Set((raw as unknown[]).map(value=>{
  const s=String(value).trim();const [address,prefix,...rest]=s.split('/');const family=isIP(address);const bits=prefix===undefined?(family===4?32:128):Number(prefix);
  if (!family||rest.length||!Number.isInteger(bits)||bits<(family===4?16:32)||bits>(family===4?32:128)||family===4&&blocked.check(address)||family===6&&!/^[23][0-9a-f]{3}:/i.test(address))fail(400,'Use office public IP addresses or CIDR ranges, not local/private addresses');
  if(family===4){const parts=address.split('.').map(Number);let n=parts.reduce((v,p)=>(v*256+p)>>>0,0);const mask=(0xffffffff<<(32-bits))>>>0;n=(n&mask)>>>0;const canonical=[n>>>24,n>>>16&255,n>>>8&255,n&255].join('.');if(blocked.check(canonical))fail(400,'Use a public office network');return `${canonical}/${bits}`;}
  const [left,right]=address.split('::');const head=left?left.split(':'):[];const tail=right?right.split(':'):[];
  const words=right!==undefined?[...head,...Array(8-head.length-tail.length).fill('0'),...tail]:head;
  const n=words.reduce((v,w)=>(v<<16n)|BigInt(parseInt(w,16)),0n);const masked=(n>>BigInt(128-bits))<<BigInt(128-bits);
  const canonical=Array.from({length:8},(_,i)=>Number((masked>>BigInt((7-i)*16))&65535n).toString(16)).join(':');
  return `${canonical}/${bits}`;
 }))];
}

/** Update one device's current office evidence. IP comes only from the trusted web gateway, never the body. */
export async function updatePresence(c:PoolClient,v:Viewer,b:Record<string,unknown>,address:string) {
 if(!v.nativeDevice||!v.person)fail(403,'Office presence requires an authorized device');
 if(typeof b.consent!=='boolean'||typeof b.autoConsent!=='boolean')fail(400,'Choose your office presence preferences');
 if(!b.consent){
  await c.query(`update pulse.companion_presence set consent=false,auto_consent=false,region_inside=false,wifi_strength=0,ip_matched=false,region_at=null,wifi_at=null,ip_at=null,dwell_started_at=null,last_present_at=null,left_at=null,office_id=null where device_id=$1`,[v.nativeDevice]);
  return {enabled:false,score:0};
 }
 const prior=(await c.query('select * from pulse.companion_presence where device_id=$1 for update',[v.nativeDevice])).rows[0];
 if(b.consentOnly===true){
  // The phone's on/off switch has no "automatic" choice (it always sent false): automatic follows the person's own
  // agreement from onboarding, which the switch must not drop (QA-E2E P2-11).
  await c.query(`insert into pulse.companion_presence(org_id,device_id,person_id,consent,auto_consent)
   values($1,$2,$3,true,coalesce((pulse.onboarding_presence_consent()->>'auto')::boolean,false)) on conflict(device_id) do update set consent=true,auto_consent=excluded.auto_consent,updated_at=now()`,[v.org,v.nativeDevice,v.person]);
  return {enabled:true,score:0};
 }
 // A test office (named audience) is a candidate only for its own people.
 const offices=(await c.query('select id,wifi,public_ip_ranges from pulse.presence_office where active and (audience is null or $1=any(audience))',[v.person])).rows;
 if(b.officeId!==undefined&&(typeof b.officeId!=='string'||!offices.some(o=>o.id===b.officeId)))fail(400,'Unknown office');
 const wifi=b.wifi&&typeof b.wifi==='object'?b.wifi as Record<string,unknown>:null;
 const ssid=String(wifi?.ssid??'').trim();const bssid=String(wifi?.bssid??'').trim().toLowerCase().replace(/-/g,':');
 const networks=(o:{wifi:unknown})=>(Array.isArray(o.wifi)?o.wifi:[]) as {ssid:string;bssids:string[]}[];
 // The laptop app reports its Wi-Fi without naming an office (apps/desktop presence.rs): a registered access point names
 // its office (before this device's earlier one); the network's name alone only when nothing else does. Without this a
 // laptop on the office access point counted for nothing unless its traffic also came from the office's public IP.
 const byAccessPoint=bssid?offices.find(o=>networks(o).some(w=>w.ssid===ssid&&w.bssids.includes(bssid)))?.id:undefined;
 let officeId=typeof b.officeId==='string'&&offices.some(o=>o.id===b.officeId)?b.officeId:byAccessPoint??prior?.office_id??null;
 const ipOffice=isIP(address)?(await c.query('select id from pulse.presence_office where active and (audience is null or $2=any(audience)) and exists(select 1 from unnest(public_ip_ranges) network where $1::inet <<= network) order by id limit 1',[address,v.person])).rows[0]?.id:null;
 if(!officeId)officeId=ipOffice??(ssid?offices.find(o=>networks(o).some(w=>w.ssid===ssid))?.id:null)??null;
 const office=offices.find(o=>o.id===officeId);
 // ATT: the laptop in use (`active`, from its idle time) and the phone app open (`foreground`): yes/no only. Away from
 // every office they say "working elsewhere", which only matters when the person's session is at the office.
 const active=b.active===true,foreground=b.foreground===true;
 if(!office){
  if(active||foreground)await c.query(`insert into pulse.companion_presence(org_id,device_id,person_id,consent,auto_consent,active_at,foreground_at,elsewhere_at)
   values($1,$2,$3,true,$4,case when $5 then now() end,case when $6 then now() end,now()) on conflict(device_id) do update set consent=true,auto_consent=excluded.auto_consent,
   active_at=coalesce(excluded.active_at,companion_presence.active_at),foreground_at=coalesce(excluded.foreground_at,companion_presence.foreground_at),elsewhere_at=now(),updated_at=now()`,
   [v.org,v.nativeDevice,v.person,b.autoConsent,active,foreground]);
  const result=(await c.query('select pulse.companion_presence_tick($1) state',[v.nativeDevice])).rows[0].state;
  return {enabled:true,score:0,...result};
 }
 const match=networks(office).find(w=>w.ssid===ssid);
 // POLISH-2: Android's shell reports "entered" only after Android's own loitering delay, which is HR's dwell: the person
 // has already stayed that long, so the server's dwell counts from then instead of starting again (it waited twice:
 // ~6–7 minutes for a 3-minute dwell). New shells say so (`dwelled`); older Android shells only ever sent dwell
 // transitions. iPhone regions report on entry, so their dwell still runs on the server.
 const dwelled=b.region==='enter'&&(b.dwelled===true||b.dwelled===undefined&&(await c.query("select platform='android' and shell ok from pulse.native_device where id=$1",[v.nativeDevice])).rows[0]?.ok===true);
 const strength=match?(bssid&&match.bssids.includes(bssid)?40:10):0;
 const inside=b.region==='enter'||(b.region!=='exit'&&prior?.office_id===officeId&&prior?.region_inside===true);
 const away=(active||foreground)&&!strength&&ipOffice!==officeId&&!inside;
 // An office switch cannot carry over another office's dwell/region or signal timestamps.
 await c.query(`insert into pulse.companion_presence(org_id,device_id,person_id,office_id,consent,auto_consent,region_inside,region_at,wifi_strength,wifi_at,ip_matched,ip_at,holding_since)
 values($1,$2,$3,$4,true,$5,$6,case when $7 then now() else null end,$8,now(),$9,now(),case when $10 then now()-make_interval(mins=>coalesce((select presence_dwell_minutes from pulse.hr_policy),0)) end)
 on conflict(device_id) do update set office_id=excluded.office_id,consent=true,auto_consent=excluded.auto_consent,
 region_inside=case when $7 then excluded.region_inside when companion_presence.office_id is distinct from excluded.office_id then false else companion_presence.region_inside end,
 region_at=case when $7 then now() when companion_presence.office_id is distinct from excluded.office_id then null else companion_presence.region_at end,
 wifi_strength=excluded.wifi_strength,wifi_at=now(),ip_matched=excluded.ip_matched,ip_at=now(),
 dwell_started_at=case when companion_presence.office_id is distinct from excluded.office_id or not companion_presence.consent then null else companion_presence.dwell_started_at end,
 last_present_at=case when companion_presence.office_id is distinct from excluded.office_id then null else companion_presence.last_present_at end,
 left_at=case when companion_presence.office_id is distinct from excluded.office_id then null else companion_presence.left_at end,
 holding_since=case when $10 then least(case when companion_presence.office_id is not distinct from excluded.office_id then companion_presence.holding_since end,excluded.holding_since)
  when companion_presence.office_id is distinct from excluded.office_id then null else companion_presence.holding_since end,
 active_at=case when $11 then now() else companion_presence.active_at end,foreground_at=case when $12 then now() else companion_presence.foreground_at end,
 elsewhere_at=case when $13 then now() when $8>0 or $9 then null else companion_presence.elsewhere_at end,updated_at=now()`,
 [v.org,v.nativeDevice,v.person,officeId,b.autoConsent,b.region==='enter',b.region==='enter'||b.region==='exit',strength,ipOffice===officeId,dwelled,active,foreground,away]);
 // A phone inside the geofence that Android confirmed after its own loitering delay: the person's engine counts the
 // dwell from then (POLISH-2), not from this report.
 if(dwelled)await c.query('select pulse.presence_dwelled()');
 const result=(await c.query('select pulse.companion_presence_tick($1) state',[v.nativeDevice])).rows[0].state;
 return {enabled:true,officeId,...result};
}
