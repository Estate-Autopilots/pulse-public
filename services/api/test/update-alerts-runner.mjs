import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createApp} from '../dist/app.js';
import {drainWebPush} from '../dist/web-push.js';
const configs=JSON.parse(process.env.TEST_CONFIGS),people=JSON.parse(process.env.TEST_PEOPLE);
const api=new Pool({...configs.api,max:1}),worker=new Pool({...configs.worker,max:1}),app=createApp(api,api);
const owner=new Pool({...configs.owner,max:1}),ownerRole=process.env.TEST_OWNER_ROLE;
assert.match(ownerRole,/^[a-z_][a-z0-9_]*$/);
const org=process.env.TEST_ORG;
async function tenant(sql,args=[],pool=worker){
  const c=await pool.connect();
  try{await c.query('begin');if(pool===owner)await c.query(`set local role ${ownerRole}`);
    await c.query("select set_config('pulse.org_id',$1,true)",[org]);
    const r=await c.query(sql,args);await c.query('commit');return r.rows;
  }catch(e){await c.query('rollback');throw e;}finally{c.release();}
}
async function staff(path,person='a',payload){
  const r=await app.inject({method:payload?'POST':'GET',url:'/api/v0/'+path,
    headers:{'cf-access-authenticated-user-email':people[person].email},payload});
  assert.equal(r.statusCode,200,r.body);return r.json();
}
const bell=async(person='a')=>(await staff('notices',person)).rows.filter(n=>n.eventType==='update.posted');
const local=async id=>(await staff('companion/updates?since=2026-01-01T00:00:00Z')).rows.find(n=>n.subjectId===id);
const deliveries=id=>tenant('select q.*,n.person_id from pulse.notification_delivery q join pulse.notification n on n.id=q.notification_id where n.subject_id=$1 and q.channel=\'web\'',[id]);
try{
  const key=randomUUID(),secret=randomBytes(32).toString('base64url');
  const issued=await app.inject({method:'POST',url:'/api/v1/operator/service-keys',headers:{authorization:`Bearer ${process.env.PULSE_OPERATOR_TOKEN}`},
    payload:{action:'issue',id:key,hash:createHash('sha256').update(secret).digest('hex'),scopes:['updates.post'],label:'Synthetic publisher'}});
  assert.equal(issued.statusCode,200,issued.body);
  for(const p of ['a','b']){
    await tenant("insert into pulse.web_push_subscription(org_id,person_id,endpoint,keys,created_at) values($1,$2,$3,'{}',clock_timestamp()-interval '1 hour')",
      [org,people[p].id,`https://fcm.googleapis.com/fcm/send/${randomUUID()}`]);
    await staff('companion/notification-settings',p,{quiet:false,dnd:false,types:{update:true}});
  }
  const marker='PRIVATE-UPDATE-CONTENT-'+randomUUID();
  let slot=1;
  async function post(audience=[people.a.id,people.b.id,people.a.id]){
    const payload={slot:`2026-10-${String(slot++).padStart(2,'0')}-am`,headline:marker,
      sections:{live:[{title:marker}]},audience,onBehalfOf:people.sender.id};
    const send=()=>app.inject({method:'POST',url:'/api/v1/service/updates',headers:{authorization:`Bearer psvc_${key}_${secret}`},payload});
    const r=await send();assert.equal(r.statusCode,201,r.body);
    const replay=await send();assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().replayed,true);
    assert.equal(replay.json().updateId,r.json().updateId);return r.json().updateId;
  }
  const id=await post();
  const notes=await tenant("select * from pulse.notification where subject_id=$1 and event_type='update.posted'",[id]);
  assert.equal(notes.length,2);assert.deepEqual(notes.map(n=>n.person_id).sort(),[people.a.id,people.b.id].sort());
  for(const n of notes){assert.equal(n.title,'New update from Project');assert.equal(n.href,`/updates/${id}`);
    assert.equal(n.subject_type,'update');assert.equal(n.kind,'update');assert.equal(new Date(n.expires_at)-new Date(n.created_at),48*3600000);
    assert.equal(n.telegram_status,'recipient_not_connected');}
  const entry=(await bell()).find(n=>n.subjectId===id);assert.ok(entry);assert.equal(entry.group,'update');assert.equal(entry.open.href,`/updates/${id}`);
  assert.equal((await bell('outside')).length,0);assert.equal((await bell('sender')).length,0);
  // ATT (0860, 21 Oct 2026): a new update is for-your-information. It waits in the bell, quiet (reason fyi), and never
  // toasts or pushes, whatever the old per-type switch says, so no web delivery is captured for it.
  assert.deepEqual(notes.map(n=>[n.priority,n.quiet,n.quiet_reason]),[['fyi',true,'fyi'],['fyi',true,'fyi']]);
  assert.equal((await deliveries(id)).length,0);
  assert.equal((await local(id)).pingAllowed,false);
  const selfId=await post([people.sender.id,people.sender.id]);
  assert.equal((await bell('sender')).filter(n=>n.subjectId===selfId).length,1);
  const revoked=await post([people.b.id]);
  await tenant("update pulse.person set status='inactive' where id=$1",[people.b.id]);
  await drainWebPush(worker);assert.equal((await deliveries(revoked)).length,0);
  assert.equal((await bell()).some(n=>n.subjectId===revoked),false);
  console.log('Update alerts: fan-out/replay/self, bell isolation, quiet FYI (no push) and revocation passed');
}finally{await app.close();await api.end();await worker.end();await owner.end();}
