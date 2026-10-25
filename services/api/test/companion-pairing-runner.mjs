// EST-658 on a disposable database: the app names the company before pairing (native/about), and a company that
// requires an admin's approval keeps a new device waiting after the person's approval until an admin decides.
import assert from 'node:assert/strict';import {Pool} from 'pg';import {writeFile} from 'node:fs/promises';import {createApp} from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG)),app=createApp(pool,pool);const roles=JSON.parse(process.env.TEST_ROLES);
let checks=0;const receipts=[];
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;receipts.push({label,passed:true});};
const ok=(v,label)=>{assert.ok(v,label);checks++;receipts.push({label,passed:true});};
async function call(path,body,{role='person',token,anonymous=false}={}){const headers=anonymous?{}:token?{authorization:'Bearer '+token}:{'cf-access-authenticated-user-email':role+'@pairing.example'};const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{payload:body})});return {status:r.statusCode,data:r.json()};}
async function own(sql,args=[]){const c=await owner.connect();try{await c.query('begin');await c.query('set local role pulse_owner');await c.query("select set_config('pulse.org_id',$1,true)",[process.env.PULSE_ORG_ID]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
const start=async(name)=>(await call('native/pair/start',{platform:'windows',name},{anonymous:true})).data;
const poll=async(p)=>(await call('native/pair/poll',{pairId:p.pairId,pollSecret:p.pollSecret},{anonymous:true})).data;

// About: no sign-in, the company's name and the approval mode, nothing else.
let about=await call('native/about',undefined,{anonymous:true});
eq(about.status,200,'about answers without a sign-in');
eq(about.data,{product:'Pulse',company:{name:process.env.TEST_ORG_NAME},pairing:{approval:'self'}},'about names the company; self approval by default');

// Self mode is unchanged: the person's approval issues the device.
const self=await start('Synthetic self laptop');
eq((await call('native/pair/decide',{code:self.code,approve:true})).data.status,'approved','self mode: the person approves');
eq((await poll(self)).status,'approved','self mode: tokens after the person approves');

// The company requires an admin.
await own(`insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) values($1,'tenant','companion',1,'{"pairing_approval":"admin"}',true)`,[process.env.PULSE_ORG_ID]);
eq((await call('native/about',undefined,{anonymous:true})).data.pairing,{approval:'admin'},'about reports admin approval');
const req=await start('Synthetic studio PC');
eq((await call('native/pair/decide',{code:req.code,approve:true})).data,{status:'awaiting_admin',platform:'windows',name:'Synthetic studio PC'},'the person\'s approval waits for an admin');
eq((await poll(req)).status,'awaiting_admin','poll says awaiting_admin after the person approves');
const life=(await own("select extract(epoch from expires_at-decided_at)::int s,device_id from pulse_priv.native_pair where code=$1",[req.code]))[0];
eq([life.s,life.device_id],[86400,null],'the waiting request lives 24 hours and has no device yet');
eq((await call('native/pair/'+req.code)).status,404,'the code cannot be approved again on /connect');
eq((await call('native/pair/decide',{code:req.code,approve:true},{role:'other'})).status,404,'another person cannot take over the waiting request');

// Only admins see and decide.
const list=await call('admin/devices/pairings',undefined,{role:'admin'});
eq(list.status,200,'an admin lists waiting devices');
const row=list.data.pairings.find(p=>p.code===req.code);
eq(Object.keys(row).sort(),['code','name','person','platform','requestedAt'],'a waiting request shows code, platform, device name, person and request time only');
eq([row.platform,row.name,row.person],['windows','Synthetic studio PC',{id:roles.person,name:'Synthetic pairing person'}],'the request names the person and the device');
for(const role of ['person','hr']){
  eq((await call('admin/devices/pairings',undefined,{role})).status,403,role+' cannot list waiting devices');
  eq((await call('admin/devices/pairings/'+req.code+'/decide',{approve:true},{role})).status,403,role+' gets 403 on the decide route');
}
eq((await poll(req)).status,'awaiting_admin','refused decisions change nothing');
eq((await call('admin/devices/pairings/'+req.code+'/decide',{},{role:'admin'})).status,400,'the admin must approve or deny');
eq((await call('admin/devices/pairings/ZZZZ-ZZZZ/decide',{approve:true},{role:'admin'})).status,404,'unknown code');

// Admin approval issues the person's device; admin deny ends the request.
eq((await call('admin/devices/pairings/'+req.code.replace('-','').toLowerCase()+'/decide',{approve:true},{role:'admin'})).data.status,'approved','the admin approves');
const paired=await poll(req);
eq(paired.status,'approved','poll returns tokens after both approvals');ok(/^[A-Za-z0-9_-]{43}$/.test(paired.accessToken),'device token issued');
eq(paired.person.id,roles.person,'the device belongs to the person, not the admin');
eq((await call('companion',undefined,{token:paired.accessToken})).status,200,'the admin-approved device works');
eq((await call('admin/devices/pairings',undefined,{token:paired.accessToken})).status,403,'a device credential cannot reach the admin routes');
eq((await call('admin/devices/pairings/'+req.code+'/decide',{approve:true},{role:'admin'})).status,404,'a decided request cannot be decided again');
const denied=await start('Synthetic unknown PC');
await call('native/pair/decide',{code:denied.code,approve:true});
eq((await call('admin/devices/pairings/'+denied.code+'/decide',{approve:false},{role:'admin'})).data.status,'denied','the admin denies');
eq((await poll(denied)).status,'denied','an admin deny gives denied');
eq((await call('admin/devices/pairings',undefined,{role:'admin'})).data.pairings.filter(p=>[req.code,denied.code].includes(p.code)),[],'decided requests leave the list');

// A waiting request expires after its 24 hours.
const late=await start('Synthetic late PC');
await call('native/pair/decide',{code:late.code,approve:true});
await own("update pulse_priv.native_pair set expires_at=now()-interval '1 second' where code=$1",[late.code]);
eq((await poll(late)).status,'expired','an unanswered request expires');
eq((await call('admin/devices/pairings/'+late.code+'/decide',{approve:true},{role:'admin'})).status,404,'an expired request cannot be approved');

await writeFile(process.env.TEST_REPORT,JSON.stringify({checks,receipts},null,2));
await app.close();await pool.end();await owner.end();
console.log(`companion pairing: ${checks} checks passed`);
