import {matchWorkUrl,allowedProfile} from './match.js';
import {state,save,withinWorkHours} from './storage.js';
import {sameSession,ownedEvents} from './session.js';
import {handleCompanionMessage,startCompanion} from './companion-worker.js';
// The companion (check-in, badge, reminders) starts with every worker start; work-context capture below stays opt-in.
startCompanion();
// A worker restart never fills the timer gap from an earlier process.
await chrome.storage.session.remove('last');
const live=async s=>sameSession(s,await state());
async function call(s,path,body){const r=await fetch(`${s.api}/${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',authorization:'Bearer '+s.session},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});let d;try{d=await r.json();}catch{throw Error('Native API is unavailable or requires Access');}if(!r.ok)throw Error(d.error??'Pulse refused this request');return d;}
// The toolbar badge belongs to the companion (attendance); work-context state is shown on its own page.
async function badge(){}
let running=Promise.resolve();
function tick(){running=running.then(sample,sample);return running;}
async function sample(){const s=await state();const now=Date.now();const {last}=await chrome.storage.session.get('last');await chrome.storage.session.remove('last');await badge(s);if(s.shiftEnd&&now>=s.shiftEnd){await save({paused:true,outbox:[],issue:'Shift ended · capture stopped'});return;}if(!s.session||s.paused||now>=s.shiftEnd||!s.receipt||!withinWorkHours(now,s.workWindow))return;
 const profile=await chrome.identity.getProfileUserInfo({accountStatus:'ANY'});if(!s.policy||!allowedProfile(profile,s.policy))return;
 const focused=await chrome.windows.getLastFocused();const idle=await chrome.idle.queryState(180);if(!focused.focused||idle!=='active')return;
 const [tab]=await chrome.tabs.query({active:true,windowId:focused.id});if(tab?.incognito)return;const work=matchWorkUrl(tab?.url,s.policy);if(!work)return;
 if(!await live(s))return;await badge(s,true);await chrome.storage.session.set({last:{...work,at:now,personId:s.personId,deviceId:s.deviceId,trackingEpoch:s.trackingEpoch,monotonic:performance.now()}});
 if(!last||last.personId!==s.personId||last.deviceId!==s.deviceId||last.trackingEpoch!==s.trackingEpoch||last.resource!==work.resource||last.domain!==work.domain)return;
 const elapsed=performance.now()-last.monotonic;const seconds=Math.min(60,Math.max(0,Math.floor(elapsed/1000)));if(!Number.isFinite(elapsed)||Math.abs(elapsed-(now-last.at))>2000)return;if(!seconds||now-last.at>90000)return;
 const e={consentReceipt:s.receipt,sourceSession:s.sourceSession,sequence:s.sequence??0,intervalStart:new Date(last.at).toISOString(),id:crypto.randomUUID(),personId:s.personId,deviceId:s.deviceId,purpose:'work_sites',kind:'site',at:new Date(now).toISOString(),projectId:work.projectId,data:{domain:work.domain,resource:work.resource,seconds}};
 const cutoff=now-7*86400000;const outbox=ownedEvents(s.outbox,s,now).filter(x=>Date.parse(x.at)>cutoff);if(outbox.length>=2000){await save({paused:true,issue:'Offline queue full. Resume after syncing.'});return;}outbox.push(e);const seen=ownedEvents(s.seen,s,now).filter(x=>x.at.slice(0,10)===e.at.slice(0,10));seen.push(e);if(!await live(s))return;await save({outbox,seen:seen.slice(-1000),sequence:(s.sequence??0)+1});await sync();
}
async function sync(){const s=await state();if(!s.session)return;try{const policy=await call(s,'devices/policy');if(!await live(s))return;await save({policy});const devices=await call(s,'devices');if(!await live(s))return;const d=devices.devices.find(x=>x.id===s.deviceId&&!x.revokedAt);if(!d||d.paused||!d.purposes.includes('work_sites')){await save({paused:true,trackingEpoch:crypto.randomUUID(),outbox:[],seen:[],issue:'Device consent was withdrawn or revoked.'});return;}const queue=ownedEvents(s.outbox,s);if(!await live(s))return;await save({outbox:queue});for(const e of queue.slice(0,20)){if(!await live(s))return;const ack=await call(s,'native/batches',{batchId:e.id,events:[e]});if(!ack.acknowledged?.includes(e.id))throw Error('Queue retained: no acknowledgement');const current=await state();if(!sameSession(s,current))return;await save({outbox:(current.outbox??[]).filter(x=>x.id!==e.id)});}if(await live(s))await chrome.storage.local.remove('issue');}catch(e){if(!await live(s))return;await save({issue:String(e)});}}
chrome.runtime.onStartup.addListener(()=>{void save({paused:true,outbox:[],seen:[],issue:'New browser session · confirm purpose and shift before capture'});});
chrome.runtime.onInstalled.addListener(()=>{void chrome.storage.local.remove(['session','deviceId','personId','outbox','seen','trackingEpoch']);chrome.alarms.create('pulse-tick',{periodInMinutes:1});save({paused:true,trackingEpoch:crypto.randomUUID(),outbox:[],seen:[]});});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='pulse-tick')void tick().then(sync);});chrome.tabs.onActivated.addListener(()=>void tick());chrome.tabs.onUpdated.addListener((_id,change)=>{if(change.url)void tick();});chrome.windows.onFocusChanged.addListener(()=>void tick());chrome.idle.onStateChanged.addListener(()=>void tick());
chrome.runtime.onMessage.addListener((msg,_sender,respond)=>{if(msg.companion)return handleCompanionMessage(msg,respond);if(msg.type==='sync'){running=running.then(sync,sync);running.then(()=>respond({ok:true}));return true;}return false;});
