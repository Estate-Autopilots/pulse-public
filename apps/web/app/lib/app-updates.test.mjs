import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { installOrigin, publishedPhone, publishedUpdate, updateSurface, updateOrigin } from './app-updates.ts';
import { GUIDES, guideSteps, phoneHint } from '../settings/app-guides.ts';
const fixture = version => ({version,channel:'test',notes:'Synthetic update',platforms:{},files:[],commit:'a'.repeat(40),runId:'123',builtAt:'2026-10-09T10:00:00Z'});
const defaultOrigin='https://pulse.estateautopilots.com', ownOrigin='https://pulse.example.com';
const suffix=origin=>createHash('sha256').update(origin).digest('hex').slice(0,8);
const updateAsset=(name,selected='test')=>`https://github.com/Estate-Autopilots/pulse-companion/releases/download/companion-${selected}/${name}`;
const phoneManifest=tag=>({...fixture('1.2.3'),files:[{platform:'android',kind:'apk',name:'Pulse-1.2.3-android.apk',size:123,sha256:'b'.repeat(64),url:`https://github.com/Estate-Autopilots/pulse-companion/releases/download/${tag}/Pulse-1.2.3-android.apk`}]});

test('download callers without an origin retain the manifest on a non-default install', async () => {
 const original=globalThis.fetch,publicURL=process.env.PULSE_PUBLIC_URL,calls=[];
 const manifest=phoneManifest('companion-v1.2.3-abcdef1');
 process.env.PULSE_PUBLIC_URL=ownOrigin;
 globalThis.fetch=async url=>{calls.push(url);return Response.json(manifest);};
 try {
  assert.deepEqual(await publishedUpdate(),manifest);
  assert.deepEqual(await publishedUpdate('test','companion'),manifest);
  assert.deepEqual(calls,[updateAsset('latest.json'),updateAsset('latest.json')]);
  assert.equal(await publishedUpdate('test','companion',ownOrigin),null,'the update route still rejects another install’s tag');
 } finally {
  globalThis.fetch=original;
  if(publicURL===undefined)delete process.env.PULSE_PUBLIC_URL;else process.env.PULSE_PUBLIC_URL=publicURL;
 }
});

test('default install accepts only an unsuffixed seven-character phone release tag', async () => {
 const original=globalThis.fetch,calls=[];
 let manifest=phoneManifest('companion-v1.2.3-abcdef1');
 globalThis.fetch=async url=>{calls.push(url);return Response.json(manifest);};
 try {
  assert.deepEqual(await publishedUpdate('test','companion',defaultOrigin),manifest);
  assert.deepEqual(calls,[updateAsset('latest.json')]);
  for(const tag of [`companion-v1.2.3-abcdef1${suffix(ownOrigin)}`,'companion-v1.2.3-abcdef','companion-v1.2.3-abcdef12']){
   manifest=phoneManifest(tag);
   assert.equal(await publishedUpdate('test','companion',defaultOrigin),null,tag);
  }
 } finally {globalThis.fetch=original;}
});

test('own phone discovery reads only the hostname asset in the selected channel', async () => {
 const original=globalThis.fetch,calls=[];
 let selected,origin;
 globalThis.fetch=async url=>{
  calls.push(url);
  return url===updateAsset(`latest-${new URL(origin).hostname}.json`,selected)
   ?Response.json({...phoneManifest(`companion-v1.2.3-abcdef1${suffix(origin)}`),channel:selected})
   :new Response(null,{status:404});
 };
 try {
  for(selected of ['test','stable'])for(origin of [ownOrigin,'https://other.example.test:8443']){
   const manifest={...phoneManifest(`companion-v1.2.3-abcdef1${suffix(origin)}`),channel:selected};
   assert.deepEqual(await publishedUpdate(selected,'companion',origin),manifest);
   assert.equal(calls.at(-1),updateAsset(`latest-${new URL(origin).hostname}.json`,selected));
  }
  assert.equal(calls.length,4,'one own-address fetch per discovery');
 } finally {globalThis.fetch=original;}
});

test('missing own manifest fails closed without trying the available shared EA asset', async () => {
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async url=>{
  calls.push(url);
  return url===updateAsset('latest.json')?Response.json(phoneManifest('companion-v1.2.3-abcdef1')):new Response(null,{status:404});
 };
 try {
  assert.equal(await publishedUpdate('test','companion',ownOrigin),null);
  assert.deepEqual(calls,[updateAsset('latest-pulse.example.com.json')]);
 } finally {globalThis.fetch=original;}
});

test('invalid own manifest or provenance is refused without a shared fallback', async () => {
 const original=globalThis.fetch,calls=[],own=phoneManifest(`companion-v1.2.3-abcdef1${suffix(ownOrigin)}`);
 let manifest;
 globalThis.fetch=async url=>{calls.push(url);return Response.json(manifest);};
 try {
  for(const invalid of [
   {channel:'stable'}, {files:[{...own.files[0],url:'https://foreign.example.test/phone.apk'}]},
   {commit:'a'.repeat(39)}, {runId:'not-a-run'}, {builtAt:'not-a-date'},
  ]){
   manifest={...own,...invalid};calls.length=0;
   assert.equal(await publishedUpdate('test','companion',ownOrigin),null);
   assert.deepEqual(calls,[updateAsset('latest-pulse.example.com.json')]);
  }
 } finally {globalThis.fetch=original;}
});

test('an origin install refuses the default and other installs but accepts its own phone tag', async () => {
 const original=globalThis.fetch,calls=[];
 let manifest;
 globalThis.fetch=async url=>{calls.push(url);return Response.json(manifest);};
 try {
  for(const tag of ['companion-v1.2.3-abcdef1',`companion-v1.2.3-abcdef1${suffix('https://another.example.com')}`]){
   manifest=phoneManifest(tag);
   calls.length=0;
   assert.equal(await publishedUpdate('test','companion',ownOrigin),null,tag);
   assert.deepEqual(calls,[updateAsset('latest-pulse.example.com.json')]);
  }
  manifest=phoneManifest(`companion-v1.2.3-abcdef1${suffix(ownOrigin)}`);
  assert.deepEqual(await publishedUpdate('test','companion',ownOrigin),manifest);
  assert.deepEqual(await publishedUpdate('test','desktop',defaultOrigin),manifest,'desktop policy stays unchanged');
  manifest.files.push(...phoneManifest('companion-v1.2.3-abcdef1').files);
  calls.length=0;
  assert.equal(await publishedUpdate('test','companion',ownOrigin),null,'a mixed-origin Android list fails closed');
  assert.deepEqual(calls,[updateAsset('latest-pulse.example.com.json')]);
 } finally {globalThis.fetch=original;}
});

test('phone discovery uses the requested install host behind the proxy and ignores client origin hints', async () => {
 const original=globalThis.fetch,manifest=phoneManifest(`companion-v1.2.3-abcdef1${suffix(ownOrigin)}`);
 globalThis.fetch=async()=>Response.json(manifest);
 try {
  const request=new Request('http://127.0.0.1:4102/api/app-updates/test/latest.json',{headers:{host:'pulse.example.com',origin:defaultOrigin,'x-forwarded-host':'pulse.estateautopilots.com'}});
  assert.equal(updateOrigin(request),ownOrigin);
  assert.deepEqual(await publishedUpdate('test',updateSurface(request),updateOrigin(request)),manifest);
  const defaultRequest=new Request(`${defaultOrigin}/api/app-updates/test`);
  assert.equal(updateOrigin(defaultRequest),defaultOrigin);
  assert.equal(await publishedUpdate('test',updateSurface(defaultRequest),updateOrigin(defaultRequest)),null);
 } finally {globalThis.fetch=original;}
});

test('desktop-only publication leaves Android discovery on its original manifest', async () => {
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async url=>{calls.push(url);return Response.json(fixture(url.endsWith('latest-desktop.json')?'1.0.1':'1.0.0'));};
 try {
  assert.equal((await publishedUpdate('test','desktop',ownOrigin)).version,'1.0.1');
  assert.equal((await publishedUpdate('test')).version,'1.0.0');
  assert.deepEqual(calls,[updateAsset('latest-desktop.json'),updateAsset('latest.json')]);
 } finally {globalThis.fetch=original;}
});
test('a channel without a desktop-only release falls back to the shared build', async () => {
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async url=>{calls.push(url);return url.endsWith('latest-desktop.json')?new Response(null,{status:404}):Response.json(fixture('1.0.0'));};
 try {
  assert.equal((await publishedUpdate('test','desktop',ownOrigin)).version,'1.0.0');
  assert.deepEqual(calls,[updateAsset('latest-desktop.json'),updateAsset('latest.json')]);
 } finally {globalThis.fetch=original;}
});

test('a desktop manifest error other than 404 does not use the shared fallback', async () => {
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async url=>{calls.push(url);return new Response(null,{status:503});};
 try {
  assert.equal(await publishedUpdate('test','desktop',ownOrigin),null);
  assert.deepEqual(calls,[updateAsset('latest-desktop.json')]);
 } finally {globalThis.fetch=original;}
});

test('old desktop updater headers select desktop, while Android and browsers keep their existing channel', () => {
 for(const agent of ['tauri-plugin-updater/2.13.2','tauri-plugin-updater/2.13.1'])assert.equal(updateSurface(new Request('https://pulse.test',{headers:{'user-agent':agent}})),'desktop');
 for(const agent of ['okhttp/4.9.2','Dalvik/2.1.0 (Linux; Android 13)','Mozilla/5.0',''])assert.equal(updateSurface(new Request('https://pulse.test',{headers:{'user-agent':agent}})),'companion');
});

test('phone downloads come from shell releases and reject the wrong platform or an external APK', async () => {
 const original=globalThis.fetch,calls=[];
 let entry={name:'Pulse-1.1.0-android.apk',platform:'android',kind:'apk',size:123,sha256:'a'.repeat(64),url:'https://github.com/Estate-Autopilots/pulse-companion/releases/download/companion-v1.1.0-abcdef1/Pulse-1.1.0-android.apk'};
 globalThis.fetch=async url=>{calls.push(url);return Response.json(entry);};
 try {
  assert.equal((await publishedPhone('android',defaultOrigin)).name,entry.name);
  assert.equal(await publishedPhone('ios'),null);
  entry={...entry,url:'https://example.test/untrusted.apk'};
  assert.equal(await publishedPhone('android',defaultOrigin),null);
  entry={...entry,name:'Pulse-1.1.0-ios-simulator.zip',platform:'ios',kind:'simulator',url:'https://github.com/Estate-Autopilots/pulse-companion/releases/download/companion-v1.1.0-abcdef1/Pulse-1.1.0-ios-simulator.zip'};
  assert.equal((await publishedPhone('ios')).name,entry.name);
  assert.ok(calls.every(url=>url.includes('/companion-phone/')));
 } finally {globalThis.fetch=original;}
});

const phoneEntry=(tag,extra={})=>({name:'Pulse-1.1.4-android.apk',platform:'android',kind:'apk',size:123,sha256:'a'.repeat(64),url:`https://github.com/Estate-Autopilots/pulse-companion/releases/download/${tag}/Pulse-1.1.4-android.apk`,versionCode:1001004,...extra});

test('EA’s address keeps the shared Android entry; another address reads only its own entry', async () => {
 const original=globalThis.fetch,calls=[],entries={
  'android-channel-entry.json':phoneEntry('companion-v1.1.4-abcdef1'),
  'android-pulse.example.com-entry.json':phoneEntry(`companion-v1.1.4-abcdef1${suffix(ownOrigin)}`,{origin:ownOrigin}),
 };
 globalThis.fetch=async url=>{calls.push(url);const entry=entries[url.split('/companion-phone/')[1]];return entry?Response.json(entry):new Response('Not Found',{status:404});};
 try {
  assert.deepEqual(await publishedPhone('android',defaultOrigin),entries['android-channel-entry.json'],'EA unchanged');
  assert.ok(calls.at(-1).endsWith('/companion-phone/android-channel-entry.json'));
  assert.deepEqual(await publishedPhone('android',ownOrigin),entries['android-pulse.example.com-entry.json'],'own entry');
  assert.ok(calls.at(-1).endsWith('/companion-phone/android-pulse.example.com-entry.json'));
  assert.equal(await publishedPhone('android','https://pulse-staging.estateautopilots.com'),null,'a missing entry offers no Android, never EA’s');
  assert.ok(calls.at(-1).endsWith('/companion-phone/android-pulse-staging.estateautopilots.com-entry.json'));
  assert.equal(await publishedPhone('android',null),null,'an unknown address offers no Android');
  assert.equal(await publishedPhone('android'),null);
 } finally {globalThis.fetch=original;}
});

test('another address refuses an entry naming a different origin or carrying another build’s tag', async () => {
 const original=globalThis.fetch;
 let entry;
 globalThis.fetch=async()=>Response.json(entry);
 try {
  for(const [label,bad] of [
   ['origin of another address',phoneEntry(`companion-v1.1.4-abcdef1${suffix(ownOrigin)}`,{origin:'https://another.example.com'})],
   ['EA origin',phoneEntry(`companion-v1.1.4-abcdef1${suffix(ownOrigin)}`,{origin:defaultOrigin})],
   ['no origin',phoneEntry(`companion-v1.1.4-abcdef1${suffix(ownOrigin)}`)],
   ['EA’s APK under the right origin',phoneEntry('companion-v1.1.4-abcdef1',{origin:ownOrigin})],
   ['another address’s APK',phoneEntry(`companion-v1.1.4-abcdef1${suffix('https://another.example.com')}`,{origin:ownOrigin})],
  ]){entry=bad;assert.equal(await publishedPhone('android',ownOrigin),null,label);}
 } finally {globalThis.fetch=original;}
});

test('the update manifest on another address carries no EA APK', async () => {
 const original=globalThis.fetch,manifest=phoneManifest('companion-v1.2.3-abcdef1');
 globalThis.fetch=async()=>Response.json(manifest);
 try {
  const request=new Request('http://127.0.0.1:4002/api/app-updates/test/latest.json',{headers:{host:'pulse.example.com','user-agent':'okhttp/4.9.2'}});
  assert.equal(await publishedUpdate('test',updateSurface(request),updateOrigin(request)),null);
  const ea=new Request('http://127.0.0.1:4002/api/app-updates/test/latest.json',{headers:{host:'pulse.estateautopilots.com','user-agent':'okhttp/4.9.2'}});
  assert.deepEqual(await publishedUpdate('test',updateSurface(ea),updateOrigin(ea)),manifest,'EA unchanged');
 } finally {globalThis.fetch=original;}
});

test('the install’s own address is the request host, else PULSE_PUBLIC_URL', () => {
 const publicURL=process.env.PULSE_PUBLIC_URL;
 try {
  process.env.PULSE_PUBLIC_URL='https://pulse.install.test/login';
  assert.equal(installOrigin(new Headers({host:'Pulse.Example.com',origin:defaultOrigin})),ownOrigin);
  assert.equal(installOrigin(new Headers()),'https://pulse.install.test');
  delete process.env.PULSE_PUBLIC_URL;
  assert.equal(installOrigin(new Headers()),null);
 } finally {if(publicURL===undefined)delete process.env.PULSE_PUBLIC_URL;else process.env.PULSE_PUBLIC_URL=publicURL;}
});

test('Windows and Mac steps name the install’s address; Android without a build points at the home-screen app', () => {
 for(const key of ['windows','macos']){
  const g=GUIDES.find(x=>x.key===key),steps=guideSteps(g,ownOrigin);
  const at=steps.indexOf(`When Pulse asks for your company’s Pulse address, enter ${ownOrigin}.`);
  assert.ok(at>0&&steps[at+1].startsWith('Choose Sign in'),key);
  assert.equal(guideSteps(g,null).length,g.steps.length-1);
  assert.ok(guideSteps(g,null).every(s=>!s.includes('{address}')));
 }
 for(const g of GUIDES.filter(x=>!['windows','macos'].includes(x.key)))assert.deepEqual(guideSteps(g,ownOrigin),g.steps);
 assert.equal(phoneHint(ownOrigin),`Not built for this address yet: open ${ownOrigin} in Chrome → ⋮ → Add to Home screen`);
});
