// FIX-LIVE-2 (BC-137, 2477) on a disposable database: the Pulse phone app is the web app in a shell on the shared
// address, and its own requests carry no company. A person of another company signs in inside it; the page registers
// the app; the app collects, uses and refreshes its credential. Before 2477 the page's approval answered "This code
// has expired" (404), every time, for everyone outside the install's company. Synthetic only.
import assert from 'node:assert/strict';import {Pool} from 'pg';import {writeFile} from 'node:fs/promises';import {createHash,randomBytes} from 'node:crypto';import {createApp} from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG)),app=createApp(pool,pool);
const orgs=JSON.parse(process.env.TEST_ORGS),people=JSON.parse(process.env.TEST_PEOPLE),sessions=JSON.parse(process.env.TEST_SESSIONS);
let checks=0;const receipts=[];
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;receipts.push({label,passed:true});};
const ok=(v,label)=>{assert.ok(v,label);checks++;receipts.push({label,passed:true});};
const hash=s=>createHash('sha256').update(s).digest('hex');
async function call(path,body,{token,session}={}){
 const headers=token?{authorization:'Bearer '+token}:session?{'x-pulse-session':session}:{};
 const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers:{'x-pulse-client-ip':'198.51.100.71',...headers,...(body===undefined?{}:{'content-type':'application/json'})},payload:body===undefined?undefined:JSON.stringify(body)});
 let data=null;try{data=r.json();}catch{data=r.body;}return {status:r.statusCode,data};
}
// Statements in one owner transaction, inside one company (row security on, as production).
async function inOrg(db,role,org,steps){const c=await db.connect();try{await c.query('begin');if(role)await c.query(`set local role ${role}`);await c.query("select set_config('pulse.org_id',$1,true)",[org]);const out=[];for(const [sql,args=[]] of steps)out.push((await c.query(sql,args)).rows);await c.query('commit');return out.length===1?out[0]:out;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
const own=(org,...steps)=>inOrg(owner,'pulse_owner',org,steps),asApi=(org,...steps)=>inOrg(pool,null,org,steps);
const pairIn=async(org,id)=>(await own(org,['select count(*)::int n from pulse_priv.native_pair where id=$1',[id]]))[0].n;
// What the app does natively on the shared address: ask for a pairing request, then collect its credential.
const start=async(platform='android')=>(await call('native/pair/start',{platform,name:'Pulse app · Synthetic phone'})).data;
const poll=async s=>(await call('native/pair/poll',{pairId:s.pairId,pollSecret:s.pollSecret}));

// 1. A person of another company registers the app from inside it.
eq((await call('me',undefined,{session:sessions.other})).data.person,people.other,'the other company’s person is signed in on the shared address');
const first=await start();ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(first.code),'the app gets a code');
eq(await pairIn(orgs.home,first.pairId),1,'the shared address files the app’s code under the install’s company');
const enrolled=await call('native/shell/enroll',{code:first.code,expectedPersonId:people.other},{session:sessions.other});
eq(enrolled.status,200,'the page registers its phone app (was 404 "This code has expired")');eq(enrolled.data.status,'approved','approved without typing a code');
eq([await pairIn(orgs.home,first.pairId),await pairIn(orgs.other,first.pairId)],[0,1],'the request moved into the person’s company');
const collected=await poll(first);
eq(collected.status,200,'the app collects its credential from the shared address');eq(collected.data.status,'approved','approved');
eq(collected.data.deviceId,enrolled.data.deviceId,'for the device the page registered');eq(collected.data.person.id,people.other,'and the person who signed in');
eq((await poll(first)).data.status,'expired','the request cannot be redeemed twice');
eq((await own(orgs.other,['select person_id,shell from pulse.native_device where id=$1',[enrolled.data.deviceId]]))[0],{person_id:people.other,shell:true},'the device is the person’s, in their company');

// 2. The app's own calls with its credential run in its company.
const t1=collected.data;
eq((await call('companion/updates',undefined,{token:t1.accessToken})).status,200,'the background check works with the device credential');
const me=await call('me',undefined,{token:t1.accessToken});eq([me.status,me.data.person],[200,people.other],'and it is the person of the other company');
const r1=await call('native/refresh',{refreshToken:t1.refreshToken});eq(r1.status,200,'the device credential refreshes on the shared address');
eq((await call('companion/updates',undefined,{token:r1.data.accessToken})).status,200,'the new credential works');
// A replayed refresh still revokes the whole family, now in the right company.
eq((await call('native/refresh',{refreshToken:t1.refreshToken})).status,401,'a used refresh credential is refused');
eq((await call('companion/updates',undefined,{token:r1.data.accessToken})).status,401,'and the replay revokes its family');

// 3. What does not move: a computer's code, an expired code, a code of a third company, an unknown request.
const laptop=await start('windows');
ok([403,404].includes((await call('native/shell/enroll',{code:laptop.code},{session:sessions.other})).status),'a computer’s code is not registered this way');
eq(await pairIn(orgs.home,laptop.pairId),1,'and stays where it was');
const late=await start();await own(orgs.home,["update pulse_priv.native_pair set expires_at=now()-interval '1 minute' where id=$1",[late.pairId]]);
eq((await call('native/shell/enroll',{code:late.code},{session:sessions.other})).status,404,'an expired code is not registered');
eq(await pairIn(orgs.home,late.pairId),1,'and is not moved');
const elsewhere='ABCD-EFGH',secret=randomBytes(32).toString('base64url');
const foreign=(await own(orgs.third,["select pulse.native_pair_start($1,$2,'android','Synthetic third phone') id",[elsewhere,hash(secret)]]))[0].id;
eq((await call('native/shell/enroll',{code:elsewhere},{session:sessions.other})).status,404,'a code another company holds is never taken from it');
eq(await pairIn(orgs.third,foreign),1,'it stays in that company');
const theirs=await poll({pairId:foreign,pollSecret:secret});eq([theirs.status,theirs.data.status],[200,'pending'],'its holder still polls it where it is, and it is still waiting');
eq((await poll({pairId:first.pairId,pollSecret:randomBytes(32).toString('base64url')})).status,404,'a wrong poll secret finds nothing');
eq((await call('native/refresh',{refreshToken:randomBytes(32).toString('base64url')})).status,401,'an unknown refresh credential is refused');
eq((await call('companion/updates',undefined,{token:randomBytes(32).toString('base64url')})).status,401,'an unknown device credential is refused');

// 4. The lookups name a company only to the holder of the secret, and put the request's company back (as the API).
const [found,after]=await asApi(orgs.third,['select org_id from pulse.native_credential_org($1)',[hash(r1.data.refreshToken)]],['select pulse.current_org()::text o']);
eq([found[0]?.org_id,after[0].o],[orgs.other,orgs.third],'the credential’s company, and the transaction’s own company afterwards');
eq((await asApi(orgs.home,['select * from pulse.native_credential_org($1)',['not-a-hash']])).length,0,'nothing for a malformed hash');
eq((await asApi(orgs.home,['select * from pulse.native_credential_org($1)',[hash('unknown')]])).length,0,'nothing for an unknown hash');
eq((await asApi(orgs.home,['select * from pulse.native_pair_org($1,$2)',[first.pairId,hash('wrong')]])).length,0,'a pairing request needs its poll secret');
eq((await asApi(orgs.home,['select org_id from pulse.native_pair_org($1,$2)',[foreign,hash(secret)]]))[0].org_id,orgs.third,'and with it, names its company');

// 5. The install's own company works as before.
const mine=await start();
eq((await call('native/shell/enroll',{code:mine.code,expectedPersonId:people.home},{session:sessions.home})).status,200,'a person of the install’s company registers the app');
eq(await pairIn(orgs.home,mine.pairId),1,'the request stays in the install’s company');
const t2=(await poll(mine)).data;eq(t2.status,'approved','collected');
eq((await call('me',undefined,{token:t2.accessToken})).data.person,people.home,'their device credential is theirs');
eq((await call('native/refresh',{refreshToken:t2.refreshToken})).status,200,'and refreshes');

await writeFile(process.env.TEST_REPORT,JSON.stringify({checks,receipts},null,2));
await pool.end();await owner.end();console.log('native-shared-address checks',checks);
