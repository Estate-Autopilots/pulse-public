// The Chrome companion's background half. Every Pulse call goes through here, so one place rotates the device
// credential (two contexts rotating at once would look like a replay and sign the device out). It keeps the toolbar
// badge current, shows reminders with a button, and finishes browser pairing even after the popup closes.
import { actionRequest, badge, clockOffset, createClient, demoClient, dueReminders, prefsWith, verifyUrl } from './shared/index.js';
import {createFeed,conversationTarget} from './shared/communications.js';
import {UPDATE_URL,parseManifest,newer} from './shared/updates.js';
import { companionBase, companionStore } from './companion-store.js';

const ALARM = 'pulse-companion';
const CHAT_ALARM = 'pulse-companion-chats';
const UPDATE_ALARM = 'pulse-companion-updates';
let checkingUpdates = false;
async function checkUpdates() {
  if (checkingUpdates) return; checkingUpdates = true;
  try {
    const response = await fetch(`${UPDATE_URL}/test/latest.json`, { headers: {Accept:'application/json'}, credentials:'omit', signal:AbortSignal.timeout(30000) });
    if (response.status === 204) { await chrome.storage.local.remove('companionUpdate'); return; }
    if (!response.ok) throw Error('Update check failed');
    const manifest = parseManifest(await response.json());
    await chrome.storage.local.set({companionUpdate: {manifest,checkedAt:Date.now()}});
  } catch { /* keep last verified metadata while offline; popup can check again */ }
  finally { checkingUpdates = false; }
}
const TONE = { success: '#328267', info: '#4167cf', warning: '#9a6209', neutral: '#66687e' };
const ACTION_LABEL = { 'check-in': 'Check in', 'break-start': 'Break', 'break-end': 'Back', 'check-out': 'Check out' };
const version = chrome.runtime.getManifest().version;
let demo = null;
let polling = false;
let gateway = null;
let gatewayBase = null;

async function client() {
  const base = await companionBase();
  if (!gateway || gatewayBase !== base) {
    gatewayBase = base;
    gateway = createClient({ base, store: companionStore, credentials: 'include', client: `chrome/${version}` });
  }
  return gateway;
}
const plainError = (e) => ({ message: e?.message ?? String(e), status: e?.status ?? 0, gate: !!e?.gate, offline: !!e?.offline, signedOut: !!e?.signedOut });

let communicationSnapshot=null,pingError=null;
const feeds=new Map();
async function chatTick(){
 const tokens=await companionStore.get();if(demo||!tokens){communicationSnapshot=null;return;}
 const permission=chrome.notifications.getPermissionLevel?await chrome.notifications.getPermissionLevel():'granted';
 pingError=permission==='granted'?null:'Chrome notifications are blocked. Allow Pulse notifications in browser settings.';
 const identity=tokens.deviceId;
 let feed=feeds.get(identity);
 if(!feed){
  const saved=(await chrome.storage.local.get('companionFeed')).companionFeed;
  feed=createFeed({call:async(path)=>(await client()).call(path),load:()=>saved?.deviceId===identity?saved:null,
   acknowledge:async rows=>{if(rows.length)await (await client()).call('companion/ack',{ids:rows.map(n=>n.id)});},
   save:(_id,state)=>{void chrome.storage.local.set({companionFeed:{...state,deviceId:identity}});},
   onSnapshot:state=>{communicationSnapshot=state;void chrome.storage.local.set({companionExpectedPerson:state.person?.id});void setBadge(null);},
   onPing:async(row)=>{if((await companionStore.get())?.deviceId!==identity)return;
    const permission=chrome.notifications.getPermissionLevel?await chrome.notifications.getPermissionLevel():'granted';
    if(permission!=='granted'){pingError='Chrome notifications are blocked. Allow Pulse notifications in browser settings.';return;}
    if((await companionStore.get())?.deviceId!==identity)return;
    await chrome.notifications.create(`pulse-message:${row.id}`,{type:'basic',iconUrl:'icons/128.png',title:'Pulse',message:'A new work update is ready',priority:1});},
   onError:e=>{pingError=e.signedOut?'Signed out of Pulse. Sign in to receive pings.':e.message;},
  });feed.reset(identity);for(const old of feeds.values())old.reset(null);feeds.clear();feeds.set(identity,feed);
 }
 await feed.poll();
}
async function setBadge(b) {
  const unread=communicationSnapshot?.counts?.total??0;
  await chrome.action.setBadgeText({ text: unread>0?String(Math.min(unread,99))+(unread>99?'+':''):b?.text??'' });
  await chrome.action.setBadgeBackgroundColor({ color: TONE[b?.tone] ?? TONE.neutral });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  const cached = (await chrome.storage.local.get('companionUpdate')).companionUpdate;
  const ready = b && cached && newer(cached.manifest.version, version);
  await chrome.action.setTitle({ title: (unread?`Pulse · ${unread} unread`:(b?.title ?? 'Pulse · sign in to check in')) + (ready ? ' · Update available' : '') });
}

/** The day, fetched at most every few minutes for the badge, always fresh when the popup asks (force). */
async function day(force = false) {
  if (demo) return { payload: await demo.companion(), offset: 0, demo: true };
  if (!(await companionStore.get())) return null;
  const { companionDay } = await chrome.storage.session.get('companionDay');
  if (!force && companionDay && Date.now() - companionDay.fetchedAt < 4 * 60000) return companionDay;
  const payload = await (await client()).companion();
  const next = { payload, offset: clockOffset(payload), fetchedAt: Date.now() };
  await chrome.storage.session.set({ companionDay: next });
  return next;
}

async function tick() {
  let d = null;
  try { d = await day(); } catch (e) { if (e?.signedOut) { await companionStore.clear(); await setBadge(null); } return; }
  if (!d) { await setBadge(null); return; }
  const at = Date.now() + d.offset;
  await setBadge(badge(d.payload, at));
  if (d.demo) return;
  const { companionShown = [], companionPrefs = {} } = await chrome.storage.local.get(['companionShown', 'companionPrefs']);
  for (const r of dueReminders(d.payload, companionPrefs, at, companionShown)) {
    companionShown.push(r.id);
    chrome.notifications.create(`pulse:${r.action}:${r.id}`, { type: 'basic', iconUrl: 'icons/128.png', title: r.title, message: r.body, buttons: [{ title: ACTION_LABEL[r.action] }], priority: 1 });
  }
  await chrome.storage.local.set({ companionShown: companionShown.slice(-60) });
}

async function act(action, extra = {}) {
  if (demo) { await demo.act(action, extra); return day(true); }
  const { path, body } = actionRequest(action, { via: 'chrome', trigger: 'manual', ...extra });
  await (await client()).call(path, body);
  const d = await day(true);
  await setBadge(badge(d.payload, Date.now() + d.offset));
  return d;
}

/** Browser pairing: the tab with the code opens; this keeps asking until the person approves (the popup may close). */
async function pairStart() {
  const c = await client();
  const started = await c.pairStart('chrome', 'Pulse in Chrome');
  const expected=(await chrome.storage.local.get('companionExpectedPerson')).companionExpectedPerson;
  const pair = { code: started.code, pairId: started.pairId, pollSecret: started.pollSecret, url: verifyUrl(c.base, started.code,expected), until: Date.now() + started.expiresIn * 1000, interval: started.interval ?? 3 };
  await chrome.storage.session.set({ companionPair: pair });
  await chrome.tabs.create({ url: pair.url });
  void pollPairing();
  return { code: pair.code, url: pair.url };
}
async function pollPairing() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const { companionPair: pair } = await chrome.storage.session.get('companionPair');
      if (!pair) return;
      if (Date.now() > pair.until) { await chrome.storage.session.set({ companionPair: { ...pair, status: 'expired' } }); return; }
      await new Promise((r) => setTimeout(r, pair.interval * 1000));
      let r;
      try { r = await (await client()).pairPoll(pair.pairId, pair.pollSecret); } catch (e) { if (e?.offline) continue; await chrome.storage.session.set({ companionPair: { ...pair, status: 'error', message: e.message } }); return; }
      if (r.status === 'pending') continue;
      if (r.status === 'approved') {
        await chrome.storage.session.remove('companionPair');
        demo = null;
        chrome.notifications.create('pulse:connected', { type: 'basic', iconUrl: 'icons/128.png', title: 'Pulse is connected', message: `Hello${r.person?.name ? `, ${r.person.name.split(' ')[0]}` : ''}! Click the Pulse button in the toolbar to check in.`, priority: 1 });
        await tick();
      } else await chrome.storage.session.set({ companionPair: { ...pair, status: r.status } });
      return;
    }
  } finally { polling = false; }
}

/** Popup messages: { op: 'state' | 'act' | 'pair' | 'cancelPair' | 'signOut' | 'demo' | 'prefs' | 'base' }. */
export function handleCompanionMessage(msg, respond) {
  const run = async () => {
    switch (msg.op) {
      case 'communicationState': await chatTick();return {snapshot:communicationSnapshot,error:pingError};
      case 'communication': {
        if(!/^(companion\/(inbox|updates|read|ack|notification-settings)|chats(?:\/[0-9a-f-]{36}\/(messages|read))?)(?:\?.*)?$/.test(msg.path??''))throw new Error('Unsupported companion route');
        return (await client()).call(msg.path,msg.body);
      }
      case 'state': {
        const { companionPair: pair } = await chrome.storage.session.get('companionPair');
        const { companionPrefs = {}, companionBase: base } = await chrome.storage.local.get(['companionPrefs', 'companionBase']);
        const signedIn = !!(await companionStore.get()) || !!demo;
        let d = null, error = null;
        if (signedIn) { try { d = await day(!!msg.force); } catch (e) { error = plainError(e); if (e?.signedOut) await companionStore.clear(); } }
        if (pair && !pair.status && !polling) void pollPairing();
        return { communications:communicationSnapshot,pingError, signedIn: signedIn && !error?.signedOut, demo: !!demo, pair: pair ? { code: pair.code, url: pair.url, status: pair.status ?? 'pending', message: pair.message } : null, day: d, error, prefs: prefsWith(companionPrefs), base: base ?? null };
      }
      case 'updates': await checkUpdates(); return (await chrome.storage.local.get('companionUpdate')).companionUpdate?.manifest ?? null;
      case 'act': return { day: await act(msg.action, msg.extra) };
      case 'pair': return await pairStart();
      case 'cancelPair': await chrome.storage.session.remove('companionPair'); return {};
      case 'signOut': demo = null;for(const feed of feeds.values())feed.reset(null);feeds.clear();communicationSnapshot=null;await chrome.storage.local.remove('companionFeed'); await (await client()).signOut(); await setBadge(null); return {};
      case 'demo': demo = msg.on ? demoClient('out') : null; await tick(); return {};
      case 'prefs': await chrome.storage.local.set({ companionPrefs: prefsWith(msg.prefs) }); return {};
      case 'base': await chrome.storage.local.set({ companionBase: msg.base || null }); return {};
      default: throw new Error('Unknown request');
    }
  };
  run().then((data) => respond({ ok: true, data }), (e) => respond({ ok: false, error: plainError(e) }));
  return true;
}

export function startCompanion() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(CHAT_ALARM,{periodInMinutes:0.5});
  const chatTimer=setInterval(()=>void chatTick(),2500);chatTimer.unref?.();
  chrome.notifications.onClicked.addListener(id=>{if(!id.startsWith('pulse-message:'))return;void (async()=>{
    try{const row=(await (await client()).call('companion/inbox?id='+encodeURIComponent(id.slice('pulse-message:'.length)))).rows.find(n=>n.id===id.slice('pulse-message:'.length));if(!row)return;
      const channel=conversationTarget(row.href);if(channel)await (await client()).call(`chats/${channel}/messages`);
      await chrome.tabs.create({url:new URL(row.href,new URL(await companionBase()).origin).href});
    }catch(e){pingError=e.message;}
  })();});
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 240 });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) void tick();if(a.name===CHAT_ALARM)void chatTick(); if (a.name === UPDATE_ALARM) void checkUpdates().then(tick); });
  chrome.runtime.onStartup.addListener(() => { void tick(); void checkUpdates().then(tick); });
  chrome.notifications.onButtonClicked.addListener((id) => {
    const [, action] = id.split(':');
    if (!ACTION_LABEL[action]) return;
    void act(action, { trigger: 'reminder' }).then(
      () => chrome.notifications.create({ type: 'basic', iconUrl: 'icons/128.png', title: 'Pulse', message: `${ACTION_LABEL[action]} — done.`, priority: 0 }),
      (e) => chrome.notifications.create({ type: 'basic', iconUrl: 'icons/128.png', title: 'Pulse could not do that', message: e.message, priority: 1 }));
    chrome.notifications.clear(id);
  });
  void tick(); void checkUpdates().then(tick);
}
