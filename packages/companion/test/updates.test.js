import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { canOfferUpdate, channel, newer, parseManifest, UpdateController, UPDATE_INTERVAL } from '../src/updates.js';
const url='https://github.com/Estate-Autopilots/pulse-companion/releases/download/companion-v0.3.2-abc123/Pulse.exe';
const fixture=()=>({version:'0.3.2',channel:'test',notes:'Chat arrives',platforms:{'windows-x86_64':{url,signature:'signature'}},files:[{name:'Pulse.exe',platform:'windows',url,size:100,sha256:'a'.repeat(64)}]});
const context={signedIn:true,payload:{shiftStartsAt:'2026-10-08T09:00:00Z',entry:{in:'2026-10-08T09:02:00Z'}}};
test('manifest validates channel, platforms, downloads, sizes, notes and version',()=>{
 assert.equal(parseManifest(fixture()).version,'0.3.2');
 for(const change of [m=>m.channel='stable',m=>m.version='latest',m=>m.notes='',m=>m.platforms['linux-x86_64']={url,signature:'x'},m=>m.platforms['windows-x86_64'].url='https://evil.test/Pulse.exe',m=>m.files[0].sha256='x',m=>m.files[0].size=-1]){const m=fixture();change(m);assert.throws(()=>parseManifest(m));}
 assert.throws(()=>channel('beta'));assert.equal(channel('stable'),'stable');
 assert.equal(newer('0.3.2','0.3.1'),true);assert.equal(newer('0.3.1','0.3.2'),false);assert.equal(newer('0.3.2','0.3.2'),false);
});
test('quiet first minutes, signed-out, demo, pending and busy actions; late check-in quiet too',()=>{
 const at=Date.parse('2026-10-08T10:00:00Z');assert.ok(canOfferUpdate({...context,at}));
 for(const flags of [{signedIn:false},{demo:true},{busy:true},{pending:true},{laterUntil:at+1},{payload:null},{payload:{...context.payload,pending:true}}])assert.equal(canOfferUpdate({...context,at,...flags}),false);
 for(const time of ['08:56','09:01','09:10'])assert.equal(canOfferUpdate({...context,at:Date.parse(`2026-10-08T${time}:00Z`)}),false);
 assert.equal(canOfferUpdate({...context,at:Date.parse('2026-10-08T09:12:00Z')}),true);
 assert.equal(canOfferUpdate({...context,payload:{...context.payload,entry:{in:'2026-10-08T10:00:00Z'}},at}),false);
});
test('waits for preparation; later persists for hours; no concurrent poll; logout invalidates download',async()=>{
 let time=Date.parse('2026-10-08T10:00:00Z'),finish,calls=0;
 const c=new UpdateController({check:async()=>{calls++;return fixture();},prepare:()=>new Promise(r=>finish=r),clock:()=>time});
 const work=c.poll(context);await Promise.resolve();assert.equal(c.offer(context),null);await c.poll(context,true);assert.equal(calls,1);
 finish();await work;assert.equal(c.offer(context).version,'0.3.2');c.later();assert.equal(c.offer(context),null);time+=UPDATE_INTERVAL;assert.ok(c.offer(context));
 const again=c.poll(context,true);await Promise.resolve();c.reset();finish();await again;assert.equal(c.candidate,null);assert.equal(c.offer(context),null);
});
test('failed download never produces an install offer and can retry on demand',async()=>{
 let fail=true;const c=new UpdateController({check:async()=>fixture(),prepare:async()=>{if(fail)throw Error('bad signature');}});
 await c.poll(context);assert.equal(c.candidate,null);fail=false;await c.poll(context,true);assert.ok(c.candidate);
});

test('release signing gate refuses publication when signing configuration is absent',()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 assert.throws(()=>execFileSync(process.execPath,['apps/desktop/scripts/check-release.mjs'],{cwd:root,stdio:'pipe',env:{...process.env,TAURI_SIGNING_PRIVATE_KEY:'',ANDROID_SIGNING_STORE_BASE64:'',ANDROID_SIGNING_PASSWORD:''}}),error=>/Updater public key is not provisioned|Missing Actions secret/.test(error.stderr.toString()));
});

test('launch discovery works signed out, offers nothing and downloads only after sign-in',async()=>{
 let checks=0,downloads=0;const c=new UpdateController({check:async()=>{checks++;return fixture();},prepare:async()=>{downloads++;}});
 await c.poll({...context,signedIn:false});assert.equal(checks,1);assert.equal(downloads,0);assert.equal(c.offer({...context,signedIn:false}),null);
 c.reset();await c.poll(context);assert.equal(checks,2);assert.equal(downloads,1);assert.ok(c.candidate);
});
