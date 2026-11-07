// The Chrome companion's background half with a fake chrome.* and a fake Pulse: pairing that survives the popup
// closing, token storage split (refresh on disk, access in memory), one-click actions, badge and reminders.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const T = (c) => c.repeat(43);
function fakeChrome() {
  const area = () => { const m = new Map(); return { m, get: async (k) => { if (k === null) return Object.fromEntries(m); const keys = Array.isArray(k) ? k : [k]; return Object.fromEntries(keys.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])); }, set: async (o) => { for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v)); }, remove: async (k) => { for (const x of [k].flat()) m.delete(x); } }; };
  const c = { badge: {}, tabs: [], notes: [], listeners: {} };
  c.storage = { local: area(), session: area() };
  c.action = { setBadgeText: async ({ text }) => { c.badge.text = text; }, setBadgeBackgroundColor: async ({ color }) => { c.badge.color = color; }, setBadgeTextColor: async () => {}, setTitle: async ({ title }) => { c.badge.title = title; } };
  c.tabs = { created: [], create: async ({ url }) => { c.tabs.created.push(url); } };
  c.notifications = { create: (id, o) => { c.notes.push(typeof id === 'string' ? { id, ...o } : id); }, clear: () => {},getPermissionLevel:async()=>'granted',onClicked:{addListener:f=>{c.listeners.clicked=f;}}, onButtonClicked: { addListener: (f) => { c.listeners.button = f; } } };
  c.alarmSettings = new Map();
  c.alarms = { create: (name,options) => c.alarmSettings.set(name,options), onAlarm: { addListener: () => {} } };
  c.runtime = { getManifest: () => ({ version: '0.2.0' }), onStartup: { addListener: () => {} } };
  return c;
}
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const IST = (hhmm) => Date.parse(`2026-10-08T${hhmm}:00+05:30`);

globalThis.chrome = fakeChrome();
const { demoPayload } = await import('../shared/index.js');
let pulse = { state: 'out', approved: false, calls: [] };
globalThis.fetch = async (url, init) => {
  if (url.includes('/api/app-updates/')) { if (!pulse.update) return new Response(null,{status:204}); pulse.updateRequest=init; return json(200,pulse.update); }
  const path = url.split('/api/native/v0/')[1];
  pulse.calls.push({ path, auth: init.headers.authorization ?? null, body: init.body ? JSON.parse(init.body) : null, credentials: init.credentials });
  if (path === 'native/pair/start') return json(200, { pairId: '0e8b9d4e-1b7a-4a43-9b8c-0a1b2c3d4e5f', pollSecret: T('p'), code: 'KQ7M-4TXA', expiresIn: 600, interval: 0.01 });
  if (path === 'native/pair/poll') return json(200, pulse.approved ? { status: 'approved', accessToken: T('a'), refreshToken: T('r'), deviceId: 'dev-1', person: { id: 'p1', name: 'Pip Demo' } } : { status: 'pending' });
  if (path === 'native/refresh') return json(200, { accessToken: T('b'), refreshToken: T('s') });
  if(path==='companion/ack')return json(200,{ok:true});
  if(path.startsWith('companion/updates'))return json(200,pulse.communications??{person:{id:'p1',name:'Pip Demo'},rows:[],counts:{chats:0,inbox:0,total:0},cursor:new Date().toISOString()});
  if(/^chats\/[0-9a-f-]{36}\/messages$/.test(path))return json(200,{messages:[]});
  if(path.startsWith('companion/inbox'))return json(200,{rows:pulse.communications?.rows??[]});
  if (path === 'companion') { const p = demoPayload(pulse.state, IST('09:50')); p.demo = false; p.now = new Date().toISOString(); return json(200, p); }
  if (path.startsWith('attendance/')) { pulse.state = path.endsWith('check-in') ? 'in' : path.endsWith('check-out') ? 'done' : JSON.parse(init.body).action === 'start' ? 'break' : 'in'; return json(200, { ok: true }); }
  if (path.endsWith('/revoke')) return json(200, { ok: true });
  return json(404, { error: 'unknown' });
};
const { handleCompanionMessage, startCompanion } = await import('../companion-worker.js');
const ask = (msg) => new Promise((resolve) => handleCompanionMessage(msg, resolve));

test('signed out: the popup offers sign-in and the badge invites it', async () => {
  startCompanion();
  const r = await ask({ op: 'state' });
  assert.equal(r.ok, true); assert.equal(r.data.signedIn, false); assert.equal(r.data.pair, null);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(chrome.badge.title, 'Pulse · sign in to check in');
});

test('pairing opens the approval tab and finishes in the background, even with the popup closed', async () => {
  const r = await ask({ op: 'pair' });
  assert.equal(r.data.code, 'KQ7M-4TXA');
  assert.equal(chrome.tabs.created.at(-1), 'https://pulse.estateautopilots.com/connect?code=KQ7M-4TXA');
  assert.equal((await ask({ op: 'state' })).data.pair.status, 'pending');
  pulse.approved = true;
  for (let i = 0; i < 50 && (await chrome.storage.session.get('companionPair')).companionPair; i++) await new Promise((res) => setTimeout(res, 10));
  const device = (await chrome.storage.local.get('companionDevice')).companionDevice;
  assert.deepEqual(device, { refreshToken: T('r'), deviceId: 'dev-1', person: { id: 'p1', name: 'Pip Demo' } }, 'only the refresh credential is kept on disk');
  assert.equal((await chrome.storage.session.get('companionAccess')).companionAccess, T('a'), 'the access credential lives in session memory');
  assert.ok(chrome.notes.some((n) => n.title === 'Pulse is connected'));
  assert.ok(pulse.calls.filter((c) => c.path.startsWith('native/pair')).every((c) => c.auth === null), 'pairing carries no credential');
});

test('one click: check in, break, back, check out — with the device credential and the browser’s cookies', async () => {
  let s = (await ask({ op: 'state', force: true })).data;
  assert.equal(s.signedIn, true); assert.equal(s.day.payload.state, 'out');
  s = (await ask({ op: 'act', action: 'check-in', extra: { mode: 'office' } })).data;
  assert.equal(s.day.payload.state, 'in');
  const post = pulse.calls.find((c) => c.path === 'attendance/check-in');
  assert.equal(post.auth, `Bearer ${T('a')}`); assert.equal(post.body.via, 'chrome'); assert.equal(post.credentials, 'include');
  assert.equal(chrome.badge.color, '#328267', 'green badge while checked in');
  assert.equal((await ask({ op: 'act', action: 'break-start' })).data.day.payload.state, 'break');
  assert.equal(chrome.badge.text, 'BRK');
  assert.equal((await ask({ op: 'act', action: 'break-end' })).data.day.payload.state, 'in');
  assert.equal((await ask({ op: 'act', action: 'check-out' })).data.day.payload.state, 'done');
  assert.equal(chrome.badge.text, '✓');
});

test('after a browser restart the stored device rotates its credential before the first call', async () => {
  await chrome.storage.session.remove(['companionAccess', 'companionDay']);
  pulse.calls = [];
  const responses = await Promise.all([ask({ op: 'state', force: true }), ask({ op: 'state', force: true })]);
  assert.ok(responses.every((r) => r.ok && r.data.signedIn));
  const s = responses[0].data;
  assert.equal(s.signedIn, true);
  assert.equal(pulse.calls.filter((c) => c.path === 'native/refresh').length, 1, 'popup and alarm share one rotation');
  assert.equal(pulse.calls.filter((c) => c.path === 'companion').length, 2);
  assert.equal((await chrome.storage.local.get('companionDevice')).companionDevice.refreshToken, T('s'));
});

test('sign out revokes the device and forgets it', async () => {
  await ask({ op: 'signOut' });
  assert.ok(pulse.calls.some((c) => c.path === 'devices/dev-1/revoke'));
  assert.equal((await ask({ op: 'state' })).data.signedIn, false);
  assert.equal((await chrome.storage.local.get('companionDevice')).companionDevice, undefined);
});

test('demo mode works without an account and saves nothing', async () => {
  await ask({ op: 'demo', on: true });
  let s = (await ask({ op: 'state' })).data;
  assert.equal(s.demo, true); assert.equal(s.day.payload.demo, true);
  s = (await ask({ op: 'act', action: 'check-in' })).data;
  assert.equal(s.day.payload.state, 'in');
  await ask({ op: 'demo', on: false });
  assert.equal((await ask({ op: 'state' })).data.signedIn, false);
});

test('background update discovery uses public metadata, no device credential, and the registered four-hour alarm', async () => {
  pulse.update = {version:'0.3.1',channel:'test',notes:'Pip updates',platforms:{},files:[]};
  const result = await ask({op:'updates'});
  assert.equal(result.ok,true);assert.equal(result.data.version,'0.3.1');
  assert.equal(chrome.alarmSettings.get('pulse-companion-updates').periodInMinutes,240);
  assert.equal(pulse.updateRequest.credentials,'omit');assert.equal(pulse.updateRequest.headers.authorization,undefined);
  assert.equal((await chrome.storage.local.get('companionUpdate')).companionUpdate.manifest.notes,'Pip updates');
});


test('group feed notifies once, updates the Chrome badge and opens the exact conversation',async()=>{
 await chrome.storage.local.set({companionDevice:{refreshToken:T('r'),deviceId:'dev-1',person:{id:'p1'}}});
 await chrome.storage.session.set({companionAccess:T('a')});
 const channel='11111111-1111-4111-8111-111111111111';
 pulse.communications={person:{id:'p1',name:'Pip Demo'},rows:[{id:channel,title:'New message in Chats',href:`/chats?channel=${channel}`,channelId:channel,pingAllowed:true}],counts:{chats:3,inbox:0,total:3},cursor:new Date().toISOString()};
 const first=await ask({op:'communicationState'});assert.equal(first.ok,true);await new Promise(r=>setTimeout(r,10));
 assert.equal(chrome.badge.text,'3');assert.equal(chrome.notes.filter(n=>n.id===`pulse-message:${channel}`).length,1);
 await ask({op:'communicationState'});assert.equal(chrome.notes.filter(n=>n.id===`pulse-message:${channel}`).length,1);
 chrome.listeners.clicked(`pulse-message:${channel}`);await new Promise(r=>setTimeout(r,20));assert.equal(chrome.tabs.created.at(-1),`https://pulse.estateautopilots.com/chats?channel=${channel}`);
 pulse.communications=null;
 await ask({op:'signOut'});
});

test('blocked Chrome notifications stay explained after a successful feed refresh',async()=>{
 await chrome.storage.local.set({companionDevice:{refreshToken:T('r'),deviceId:'blocked-device',person:{id:'p1'}}});
 await chrome.storage.session.set({companionAccess:T('a')});
 pulse.communications={person:{id:'p1',name:'Pip Demo'},rows:[],counts:{chats:2,inbox:0,total:2},cursor:new Date().toISOString()};
 const permission=chrome.notifications.getPermissionLevel;
 try{
  chrome.notifications.getPermissionLevel=async()=> 'denied';
  const blocked=await ask({op:'communicationState'});assert.equal(blocked.ok,true);assert.match(blocked.data.error,/blocked/);assert.equal(blocked.data.snapshot.counts.total,2);
  chrome.notifications.getPermissionLevel=async()=> 'granted';
  assert.equal((await ask({op:'communicationState'})).data.error,null);
 }finally{chrome.notifications.getPermissionLevel=permission;pulse.communications=null;await ask({op:'signOut'});}
});
