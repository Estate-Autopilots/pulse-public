// EST-647 on a disposable database: /api/v0/me carries the organisation's module switches from the
// tenant/modules config document. No document: every module on. EST-648: an off module's routes answer 404 like a
// route that does not exist. Synthetic identities only.
import assert from 'node:assert/strict';import {Pool} from 'pg';import {writeFile} from 'node:fs/promises';import {createApp} from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG)),worker=new Pool(JSON.parse(process.env.TEST_WORKER_CONFIG)),app=createApp(pool,pool),org=process.env.PULSE_ORG_ID;
let checks=0;const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const me=async()=>{const r=await app.inject({url:'/api/v0/me',headers:{'cf-access-authenticated-user-email':'person@modules.example'}});assert.equal(r.statusCode,200,r.body);return r.json();};
const hrSelf=()=>app.inject({url:'/api/v0/hr/self',headers:{'cf-access-authenticated-user-email':'person@modules.example'}});
async function own(sql,args=[]){const c=await owner.connect();try{await c.query('begin');await c.query('set local role pulse_owner');await c.query("select set_config('pulse.org_id',$1,true)",[org]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
const tick=async()=>{const c=await worker.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true)",[org]);await c.query('select pulse.companion_presence_tick(null)');await c.query('commit');}catch(e){await c.query('rollback');throw e;}finally{c.release();}};
const entries=async()=>Number((await own('select count(*)::int n from pulse.attendance_entry where org_id=$1',[org]))[0].n);
const put=async(version,body)=>{await own("update pulse.tenant_config set is_active=false where org_id=$1 and doc_kind='tenant' and doc_key='modules'",[org]);
  await own("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) values($1,'tenant','modules',$2,$3,true)",[org,version,JSON.stringify(body)]);};
try{
  const before=await me(),hrBefore=(await hrSelf()).statusCode;
  eq(before.modules,{off:['pulse_hq']},'no modules document: every module is on but the organisation-only ones');
  eq([before.role,before.name,before.roles,typeof before.hrAccess,before.photoAt],['person','Synthetic person',['person'],'boolean',null],'the rest of /me is unchanged');
  const off=['designers','map','acquisition','chats','briefs','money','hr'];
  await put(1,{off});
  // DE-EA: a company with a document has only the company-chosen modules it names in on (or its pack brings).
  eq((await me()).modules,{off:[...off,'chat_import','connectors','creative','sales_xray','pulse_hq']},'the active document switches modules off');
  const hrOff=await hrSelf();
  eq([hrOff.statusCode,hrOff.json()],[404,{message:'Route GET:/api/v0/hr/self not found',error:'Not Found',statusCode:404}],'an off module answers 404 like an unknown route');
  // A device in the office long enough to be checked in automatically: with HR off the tick records nothing.
  const [person]=(await own("select p.id from pulse.person p join pulse.account a on a.holder_person_id=p.id where a.handle='person@modules.example'"));
  await own('select pulse.hr_defaults()');
  // PostgreSQL's 24:00 includes the final minute; 23:59 excludes late-night CI runs.
  await own("update pulse.hr_policy set attendance_enabled=true,presence_auto_checkin=true,work_days='{1,2,3,4,5,6,7}',shift_start='00:00',shift_end='24:00' where org_id=$1",[org]);
  const [office]=await own("insert into pulse.presence_office(org_id,name,lat,lng,radius_m) values($1,'Synthetic office',18.52,73.86,150) returning id",[org]);
  const [device]=await own("insert into pulse.native_device(org_id,person_id,name,platform) values($1,$2,'Synthetic laptop','windows') returning id",[org,person.id]);
  await own("insert into pulse.companion_presence(org_id,device_id,person_id,office_id,consent,auto_consent,region_inside,region_at,wifi_strength,wifi_at,dwell_started_at,last_present_at) values($1,$2,$3,$4,true,true,true,now(),40,now(),now()-interval '1 hour',now())",[org,device.id,person.id,office.id]);
  await tick();
  eq(await entries(),0,'HR off: the presence tick records no check-in');
  await put(2,{off:['hr','crm','map'],extra:true});
  eq((await me()).modules,{off:['map','hr','chat_import','connectors','creative','sales_xray','pulse_hq']},'a document that fails the schema keeps only its known keys');
  await own("update pulse.tenant_config set is_active=false where org_id=$1 and doc_kind='tenant' and doc_key='modules'",[org]);
  eq((await me()).modules,{off:['pulse_hq']},'no active document: every module is on again');
  eq((await hrSelf()).statusCode,hrBefore,'switched on again, the module answers as before');
  await tick();
  // ATT (0861): the engine counts the dwell from its own first confident tick; the hour the laptop has been at the
  // office is that memory, then the next tick checks the person in.
  await own("update pulse.attendance_presence_state set confident_since=confident_since-interval '1 hour' where person_id=$1",[person.id]);
  await tick();
  eq(await entries(),1,'HR on again: the same presence checks the person in');
  await writeFile(process.env.TEST_REPORT,JSON.stringify({checks}));
}finally{await pool.end();await owner.end();await worker.end();}
