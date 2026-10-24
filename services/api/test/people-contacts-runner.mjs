// PEOPLE-CONTACTS acceptance on a disposable tenant with synthetic people only (tests/core/test_people_contacts.py):
// who may change a photo (people and contacts), My info, bank details sealed with a throwaway keyring (the person and
// the HR role only; HR checks a change; nobody else sees even the masked line), IFSC lookup (offline and a local
// stand-in directory), name and birth-date requests HR approves, HR's bank nudges, and Account access: one-time sign-in
// links (confirmed click only, once, 15 minutes, two-step kept), devices with per-device sign-out, bulk confirmation.
// Mail goes to the in-memory sink (PULSE_CI=1); nothing is sent anywhere.
import assert from 'node:assert/strict';import {Pool} from 'pg';import {chmod,writeFile} from 'node:fs/promises';import {createHash,randomBytes} from 'node:crypto';import {join} from 'node:path';import {createServer} from 'node:http';
import {createApp} from '../dist/app.js';import {testMail} from '../dist/auth-mail.js';import {bankContext,loadKeyring,open} from '../dist/document-keys.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const app=createApp(pool,pool);const R=JSON.parse(process.env.TEST_ROLES);const ORG=process.env.PULSE_ORG_ID;
let checks=0;const receipts=[];
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;receipts.push(label);};
const ok=(v,label)=>{assert.ok(v,label);checks++;receipts.push(label);};
async function call(path,body,{role='person',token,anon}={}){
 const headers=anon?{'x-pulse-client-ip':'198.51.100.7'}:token?{'x-pulse-session':token,'x-pulse-client-ip':'198.51.100.7'}:{'cf-access-authenticated-user-email':role+'@people.example'};
 const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{payload:body})});
 let data;try{data=r.json();}catch{data=r.rawPayload;}return {status:r.statusCode,data};
}
async function own(sql,args=[]){const c=await owner.connect();try{await c.query('begin');await c.query('set local role pulse_owner');await c.query("select set_config('pulse.org_id',$1,true)",[ORG]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
/** As the API's database role with a viewer set: what row security and grants allow, without the routes. */
async function asApi(viewer,sql,args=[]){const c=await pool.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)",[ORG,viewer]);const r=await c.query(sql,args);await c.query('rollback');return {rows:r.rows};}catch(e){await c.query('rollback');return {error:e.code};}finally{c.release();}}
const notes=async(person,type)=>own('select title,href,subject_id from pulse.notification where person_id=$1 and event_type=$2 order by created_at',[person,type]);
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

try{
// ------------------------------------------------------------------------------------------- 1. photos
eq((await call(`people/${R.person}/photo`,{dataUrl:PNG})).status,200,'a person changes their own photo');
eq((await call(`people/${R.other}/photo`,{dataUrl:PNG})).status,403,'a member cannot change a colleague’s photo');
eq((await call(`people/${R.other}/photo`,{dataUrl:PNG},{role:'hr'})).status,200,'HR changes a colleague’s photo');
eq((await call(`people/${R.contact}/photo`,{dataUrl:PNG},{role:'hr'})).status,403,'HR cannot change a contact’s photo');
eq((await call(`people/${R.contact}/photo`,{dataUrl:PNG},{role:'leadership'})).status,403,'nor can leadership');
eq((await call(`people/${R.contact}/photo`,{dataUrl:PNG},{role:'admin'})).status,200,'an admin changes a contact’s photo');
eq((await call(`people/${R.person}/photo`,{dataUrl:PNG.replace('image/png','image/jpeg')})).status,400,'a PNG labelled as a JPEG is refused');
eq((await asApi(R.hr,"insert into pulse.person_photo(org_id,person_id,mime,bytes) values($1,$2,'image/png','\\x89504e47') on conflict(person_id) do update set bytes=excluded.bytes",[ORG,R.contact])).error,'42501','row security refuses HR writing a contact’s photo directly');
eq((await call(`contacts/${R.contact}`,undefined,{role:'admin'})).data.canPhoto,true,'the contact page tells an admin they may change it');
ok((await call(`contacts/${R.contact}`,undefined,{role:'admin'})).data.photoAt,'and when it changed');

// ---------------------------------------------------------------------------------------------- 2. IFSC
process.env.PULSE_IFSC_LOOKUP='off';
let ifsc=(await call('ifsc/hdfc0001234')).data;
eq([ifsc.ifsc,ifsc.valid,ifsc.bank,ifsc.branch,ifsc.known,ifsc.source],['HDFC0001234',true,'HDFC Bank',null,null,'bank code'],'offline: the bank from the first four letters');
eq((await call('ifsc/HDFC1001234')).data.valid,false,'the fifth character must be a zero');
const directory=createServer((req,res)=>{const code=decodeURIComponent(req.url.slice(1));if(code==='EXMP0001234'){res.setHeader('content-type','application/json');res.end(JSON.stringify({BANK:'Example Bank',BRANCH:'Baner',CITY:'Pune',STATE:'Maharashtra',IFSC:code}));}else{res.statusCode=404;res.end('"Not Found"');}});
await new Promise((done)=>directory.listen(0,'127.0.0.1',done));
delete process.env.PULSE_IFSC_LOOKUP;process.env.PULSE_IFSC_URL=`http://127.0.0.1:${directory.address().port}/`;
ifsc=(await call('ifsc/EXMP0001234')).data;
eq([ifsc.bank,ifsc.branch,ifsc.city,ifsc.known,ifsc.source],['Example Bank','Baner','Pune',true,'directory'],'the directory names the bank and branch');
eq((await call('ifsc/EXMP0009999')).data.known,false,'an IFSC the directory does not know is said so');
directory.close();process.env.PULSE_IFSC_LOOKUP='off';

// ----------------------------------------------------------------------------------------- 3. bank details
const KEYS=process.env.TEST_KEY_DIR,keyFile=join(KEYS,'document-master.key');
await writeFile(keyFile,`people-2026-10 ${randomBytes(32).toString('base64')}\n`,{mode:0o600});await chmod(keyFile,0o600);process.env.PULSE_DOCUMENT_KEY_FILE=keyFile;
let info=(await call(`people/${R.person}/info`)).data;
eq([info.self,info.can.bank,info.bankDetails.status],[true,true,'missing'],'My info: the person sees their own bank card, still empty');
eq((await call(`people/${R.person}/info`,undefined,{role:'other'})).status,403,'another member cannot open someone’s My info');
const account={holder:'Synthetic Person',bank:'Example Bank',branch:'Baner, Pune',ifsc:'EXMP0001234',account:'000123456789',confirm:'000123456789',upi:'9876543210@ybl'};
eq((await call(`onboarding/${R.person}/bank`,{...account,confirm:'000123456780'})).status,400,'two different account numbers are refused');
eq((await call(`onboarding/${R.person}/bank`,{...account,upi:'not a upi'})).status,400,'a malformed UPI ID is refused');
let saved=await call(`onboarding/${R.person}/bank`,account);
eq([saved.status,saved.data.status,saved.data.summary.last4,saved.data.summary.upi],[200,'pending','6789','98•••10@ybl'],'the person saves: waiting for HR’s check, last four and a masked UPI only');
const row=(await own('select bank,bank_key,bank_key_id,bank_summary::text summary,bank_masked from pulse_priv.person_onboarding where person_id=$1',[R.person]))[0];
ok(!row.summary.includes('000123456789')&&!row.summary.includes('9876543210')&&!Buffer.from(row.bank).toString('latin1').includes('000123456789'),'the database never holds the number or the UPI ID in the clear');
eq(JSON.parse(open((await loadKeyring()).ring,{keyId:row.bank_key_id,dataKey:row.bank_key,data:row.bank},bankContext(ORG,R.person)).toString()).upi,'9876543210@ybl','only the keyring opens them');
eq((await notes(R.hr,'people.bank')).length,1,'HR is told in Pulse that the person changed their bank details');
eq([(await notes(R.leadership,'people.bank')).length,(await notes(R.admin,'people.bank')).length],[0,0],'leadership and admins are not (they cannot see bank details)');
info=(await call(`people/${R.person}/info`,undefined,{role:'leadership'})).data;
eq([info.bankDetails,info.bank],[null,null],'leadership opens My info without bank details, not even the masked line');
eq((await call(`onboarding/${R.person}/bank`,account,{role:'leadership'})).status,403,'leadership cannot change bank details');
eq((await call(`onboarding/${R.person}/bank`,account,{role:'admin'})).status,403,'nor can an admin');
for(const role of ['other','leadership','admin'])eq((await call(`people/${R.person}/bank/reveal`,{},{role})).status,403,`${role} cannot open the account number`);
let shown=(await call(`people/${R.person}/bank/reveal`,{},{role:'hr'})).data;
eq([shown.account,shown.upi,shown.branch],['000123456789','9876543210@ybl','Baner, Pune'],'HR opens the full number to pay salary');
ok((await own("select 1 from privacy.access_log where subject_person_id=$1 and viewer_id=$2 and resource='onboarding.bank.account' and purpose='payroll_view'",[R.person,R.hr])).length===1,'and that opening is in the access log');
eq((await call(`people/${R.person}/bank/reveal`,{})).data.account,'000123456789','the person opens their own');
eq((await call(`people/${R.person}/bank/confirm`,{})).status,403,'the person cannot check their own bank details');
eq((await call(`people/${R.person}/bank/confirm`,{},{role:'admin'})).status,403,'an admin cannot check them');
let checked=await call(`people/${R.person}/bank/confirm`,{},{role:'hr'});
eq([checked.status,checked.data.status,checked.data.checkedBy],[200,'confirmed','Synthetic hr'],'HR checks the change');
eq((await call(`people/${R.person}/bank/confirm`,{},{role:'hr'})).status,400,'nothing is left to check');
saved=await call(`onboarding/${R.other}/bank`,{...account,holder:'Synthetic Other',upi:''},{role:'hr'});
eq(saved.data.status,'confirmed','bank details HR enters are checked already');
eq((await notes(R.other,'profile.bank')).length,1,'and the person is told HR changed them');
const roster=(await call('hr/onboard',undefined,{role:'hr'})).data.people;
eq([roster.find((p)=>p.id===R.person).bank,roster.find((p)=>p.id===R.other).bank,roster.find((p)=>p.id===R.lead).bank],['confirmed','confirmed','missing'],'Onboard team shows who has bank details and who is checked');
const nudge=(await call('hr/onboard/nudge',{kind:'bank',personIds:[R.lead,R.person]},{role:'hr'})).data;
eq([nudge.sent,nudge.skipped],[1,1],'a bank nudge reaches only someone without bank details');
eq((await notes(R.lead,'profile.reminder')).map((n)=>n.href),[`/people/${R.lead}?tab=info`],'the nudge opens their own My info');
eq((await call('hr/onboard/nudge',{kind:'bank',personIds:[R.lead]},{role:'leadership'})).status,403,'leadership does not nudge');

// ------------------------------------------------------------------------------------------- 4. My info
eq((await call(`people/${R.person}/info`,{about:'Synthetic: I edit property films.',pronouns:'they/them',languages:'Marathi, Hindi, English, hindi'})).status,200,'the person writes about themself');
info=(await call(`people/${R.person}/info`)).data.profile;
eq([info.about,info.pronouns,info.languages],['Synthetic: I edit property films.','they/them',['Marathi','Hindi','English']],'about, pronouns and languages (repeats dropped)');
eq((await call(`people/${R.person}`,undefined,{role:'other'})).data.pronouns,'they/them','colleagues see the pronouns on the profile');
eq((await call(`people/${R.person}/info`,{about:'x'},{role:'other'})).status,403,'another member cannot write it');
eq((await call(`people/${R.person}/info`,{about:'x'},{role:'leadership'})).status,403,'nor can leadership');
ok((await own("select 1 from pulse.record_change where entity_id=$1 and field in ('about','pronouns','languages')",[R.person])).length===3,'each change is in the record’s history');

// ----------------------------------------------------------------------------- 5. what HR approves: name, birth date
eq((await call(`onboarding/${R.person}/details`,{dob:'1995-04-01'})).status,200,'the person sets their date of birth the first time');
eq((await call(`onboarding/${R.person}/details`,{dob:'1996-04-01'})).status,403,'once on file, only HR changes it');
eq((await call(`onboarding/${R.person}/details`,{dob:'1995-04-01',city:'Pune'})).status,200,'the same date with other details is fine');
let asked=await call('me/changes',{field:'name',value:'Synthetic Person Renamed',note:'After marriage'});
eq(asked.status,200,'the person asks HR to change their name');
eq([(await notes(R.hr,'people.change')).length,(await notes(R.admin,'people.change')).length,(await notes(R.leadership,'people.change')).length],[1,1,0],'HR and admins are told');
eq((await call(`profile-changes/${asked.data.id}`,{approve:true})).status,403,'the person cannot approve it');
eq((await call(`profile-changes/${asked.data.id}`,{approve:true},{role:'leadership'})).status,403,'leadership cannot approve it');
eq((await call(`profile-changes/${asked.data.id}`,{approve:false},{role:'hr'})).status,400,'a decline says why');
eq((await call(`profile-changes/${asked.data.id}`,{approve:false,note:'Please attach the certificate'},{role:'hr'})).status,200,'HR declines with a reason');
eq((await notes(R.person,'profile.changed'))[0].title,'HR declined the change to your name: Please attach the certificate','the person reads why');
asked=await call('me/changes',{field:'name',value:'Synthetic Person Renamed'});
eq((await call(`profile-changes/${asked.data.id}`,{approve:true},{role:'hr'})).status,200,'HR approves the second request');
const renamed=(await own('select p.display_name,pp.locked from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id=$1',[R.person]))[0];
eq([renamed.display_name,renamed.locked.includes('name')],['Synthetic Person Renamed',true],'the name changes and the sources no longer overwrite it');
asked=await call('me/changes',{field:'dob',value:'1996-04-01'});
eq((await call(`profile-changes/${asked.data.id}`,{approve:true},{role:'admin'})).status,200,'an admin approves a birth-date correction');
eq((await own("select details->>'dob' d from pulse_priv.person_onboarding where person_id=$1",[R.person]))[0].d,'1996-04-01','the date changes');
asked=await call('me/changes',{field:'name',value:'Synthetic Person Third'});
eq((await call(`profile-changes/${asked.data.id}/withdraw`,{})).status,200,'the person withdraws a request');
eq((await call(`profile-changes/${asked.data.id}/withdraw`,{},{role:'other'})).status,400,'nobody else can withdraw it');
eq((await call('me/changes',{field:'dob',value:'2020-02-30'})).status,400,'an impossible date is refused');
const own_=await call('me/changes',{field:'name',value:'Synthetic HR Renamed'},{role:'hr'});
eq((await call(`profile-changes/${own_.data.id}`,{approve:true},{role:'hr'})).status,403,'HR cannot approve their own change');
eq((await asApi(R.other,'select count(*)::int n from pulse.profile_change')).rows[0].n,0,'a member sees nobody else’s requests');

// ---------------------------------------------------------------------------------- 6. Account access
const hash=(t)=>createHash('sha256').update(t).digest('hex');
eq((await call(`people/${R.person}/login`,{action:'signin'},{role:'hr'})).status,400,'a sign-in link needs a confirmed click');
const before=testMail.length;
let sent=await call(`people/${R.person}/login`,{action:'signin',confirmed:true},{role:'hr'});
eq([sent.status,sent.data.sent,sent.data.to],[200,true,'pe•••@delivery.example'],'HR sends a one-time sign-in link; the screen shows where, masked');
eq(testMail.length,before+1,'exactly one e-mail');
const mail=testMail.at(-1);eq([mail.to,mail.title],['person@delivery.example','Sign in to Pulse'],'to the delivery address');
const first=new URL(mail.body.match(/https?:\/\/\S+/)[0]);eq(first.pathname,'/login/link','the link opens the sign-in page; the token is in the fragment');
sent=await call(`people/${R.person}/login`,{action:'signin',confirmed:true},{role:'hr'});
const second=new URL(testMail.at(-1).body.match(/https?:\/\/\S+/)[0]).hash.slice(1);
eq((await call('auth/link-sign-in',{token:first.hash.slice(1)},{anon:true})).status,400,'a newer link replaces the older one');
const signed=await call('auth/link-sign-in',{token:second},{anon:true});
eq(signed.status,200,'the link signs the person in: '+JSON.stringify(signed.data));ok(signed.data.token,'with a session');
eq((await call('me',undefined,{token:signed.data.token})).data.person,R.person,'as that person');
eq((await call('auth/link-sign-in',{token:second},{anon:true})).status,400,'it works once');
for(const role of ['other','leadership'])eq((await call(`people/${R.person}/login`,{action:'signin',confirmed:true},{role})).status,403,`${role} cannot send one`);
eq((await call(`people/${R.admin}/login`,{action:'signin',confirmed:true},{role:'hr'})).status,403,'HR cannot send one for an admin account');
await call(`people/${R.person}/login`,{action:'signin',confirmed:true},{role:'hr'});
const late=new URL(testMail.at(-1).body.match(/https?:\/\/\S+/)[0]).hash.slice(1);
await own("update pulse_priv.auth_link set expires_at=now()-interval '1 minute' where token_hash=$1",[hash(late)]);
eq((await call('auth/link-sign-in',{token:late},{anon:true})).status,400,'after 15 minutes it no longer works');
eq((await call(`people/${R.other}/login`,{action:'signin',confirmed:true},{role:'hr'})).data.error,'This person has no password yet: send an invitation instead','someone without a password gets an invitation instead');
// Two-step stays: the link alone is not enough.
await own("insert into pulse_priv.auth_key values($1,gen_random_bytes(32)) on conflict do nothing",[ORG]);
await own("insert into pulse_priv.auth_account(org_id,realm,actor,totp) select $1,'staff',$2,pgp_sym_encrypt_bytea(gen_random_bytes(20),encode(key,'hex')) from pulse_priv.auth_key where org_id=$1 on conflict(org_id,realm,actor) do update set totp=excluded.totp",[ORG,R.person]);
await call(`people/${R.person}/login`,{action:'signin',confirmed:true},{role:'hr'});
const guarded=new URL(testMail.at(-1).body.match(/https?:\/\/\S+/)[0]).hash.slice(1);
eq((await call('auth/link-sign-in',{token:guarded},{anon:true})).data,{twoStep:true,failed:false},'with two-step on, the link asks for the code');
eq((await call('auth/link-sign-in',{token:guarded,code:'000000'},{anon:true})).data,{twoStep:true,failed:true},'a wrong code does not sign in');
eq((await own('select used_at from pulse_priv.auth_link where token_hash=$1',[hash(guarded)]))[0].used_at,null,'and does not use the link up');
await own("delete from pulse_priv.auth_account where actor=$1",[R.person]);
// Devices: the session from the link, and a Pulse app.
const device=(await own("insert into pulse.native_device(org_id,person_id,name,platform) values($1,$2,'Synthetic phone','android') returning id",[ORG,R.person]))[0].id;
let history=(await call(`admin/auth-history/${R.person}`,undefined,{role:'hr'})).data;
const session=history.sessions.find((s)=>!/Native app/.test(s.device));
ok(session,'Account access lists the browser the link signed in');
eq(history.lastSignIn?.at?.length>0,true,'with the last sign-in');
eq((await call(`people/${R.person}/login`,{action:'device-end',id:session.id},{role:'hr'})).status,200,'HR signs that device out');
eq((await call('me',undefined,{token:signed.data.token})).status,401,'its session has ended');
eq((await call(`people/${R.person}/login`,{action:'device-end',id:device},{role:'hr'})).status,200,'HR removes the phone');
ok((await own('select revoked_at from pulse.native_device where id=$1',[device]))[0].revoked_at,'the phone must pair again');
eq((await call(`people/${R.person}/login`,{action:'device-end',id:session.id},{role:'hr'})).status,400,'an ended session cannot be ended twice');
const actions=(await own("select action from pulse_priv.auth_event where actor=$1",[R.person])).map((r)=>r.action);
for(const a of ['signin_link_issued','signin_link_used','signin_link_failed','admin_session_ended','admin_device_removed'])ok(actions.includes(a),`account history: ${a}`);
eq((await call(`people/${R.person}/login`,{action:'disable',confirmed:true},{role:'hr'})).status,200,'HR suspends the account');
eq((await call(`people/${R.person}/login`,{action:'signin',confirmed:true},{role:'hr'})).data.error,'This account is suspended. Restore it first','a suspended account gets no sign-in link');
eq((await call(`people/${R.person}/login`,{action:'enable'},{role:'hr'})).status,200,'and restores it');
const bulk=await call('admin/resend-expired',{},{role:'hr'});
eq([bulk.status,bulk.data.confirm],[200,true],'bulk links ask for confirmation first and send nothing');
// ------------------------------------------------------------------------------------- 7. the organisation's types
let types=(await call('types')).data;
eq([types.contact.find((t)=>t.key==='talent').label,types.client.find((t)=>t.key==='internal').system,types.canEdit],['Model',true,false],'everyone reads the types; the defaults name talent "Model"');
for(const role of ['person','hr','leadership'])eq((await call('settings/types',{entity:'contact',label:'Architect'},{role})).status,403,`${role} cannot add a type`);
let made=await call('settings/types',{entity:'contact',label:'Architect',plural:'Architects',color:'teal',hint:'Designs the projects',fields:[{label:'COA number',type:'text'},{label:'Studio size',type:'choice',options:'Solo, Small, Large'}]},{role:'admin'});
eq([made.status,made.data.key,made.data.fields.map((f)=>f.key)],[200,'architect',['coa_number','studio_size']],'an admin adds a contact type with its own fields');
eq((await call('settings/types',{entity:'contact',label:'architect'},{role:'admin'})).status,400,'two types cannot share a name');
eq((await call(`contacts/${R.contact}`,{contactType:'nonsense'},{role:'admin'})).status,400,'a record cannot get a type the organisation does not have');
eq((await call(`contacts/${R.contact}`,{contactType:'architect'},{role:'admin'})).status,200,'a contact gets the new type');
eq((await call(`contacts/${R.contact}`,{'custom.studio_size':'Huge'},{role:'admin'})).status,400,'a choice field takes one of its options');
eq((await call(`contacts/${R.contact}`,{'custom.studio_size':'Small','custom.coa_number':'CA/2019/12345'},{role:'admin'})).status,200,'its own fields are saved');
eq((await call(`contacts/${R.contact}`)).data.custom,{studio_size:'Small',coa_number:'CA/2019/12345'},'and read back');
eq((await call('settings/types',{entity:'contact',key:'architect',label:'Architect studio',color:'violet'},{role:'admin'})).data.label,'Architect studio','a type is renamed and recoloured; its key stays');
eq((await call('settings/types',{entity:'contact',key:'other',archived:true},{role:'admin'})).status,400,'"Other" cannot be archived');
eq((await call('settings/types',{entity:'contact',key:'architect',archived:true},{role:'admin'})).data.archived,true,'an admin archives a type');
eq((await call(`contacts/${R.contact}`,{designation:'Principal'},{role:'admin'})).status,200,'a record keeps its archived type when edited');
const another=(await call('contacts',{name:'Synthetic Second',contactType:'architect'},{role:'admin'}));
eq(another.status,400,'a new record cannot get an archived type');
eq((await call('settings/types',{entity:'contact',key:'architect',archived:false},{role:'admin'})).data.archived,false,'and it is restored');
ok((await own("select 1 from pulse.record_change where entity_type='org' and field='contact_type.architect'")).length>=3,'type changes are in the organisation’s history');
eq((await call('settings/types',{entity:'client',label:'Hospital'},{role:'admin'})).data.key,'hospital','client types are added the same way');
eq((await call(`clients/${R.client}`,{clientType:'hospital'},{role:'admin'})).status,200,'and given to a client');

// ------------------------------------------------------------------------------------------- 8. a contact's profile
eq((await call(`contacts/${R.contact}/notes`,{body:'Synthetic: prefers calls after 11.'})).status,200,'a member writes a note about a contact');
eq((await call(`contacts/${R.contact}/notes`,{body:'x'},{role:'hr'})).status,403,'an HR-only account does not');
let timeline=(await call(`contacts/${R.contact}/more?part=timeline`)).data;
eq(timeline.notes.map((n)=>n.body),['Synthetic: prefers calls after 11.'],'the note is on the timeline');
ok(timeline.events.some((e)=>e.kind==='project'&&e.title==='Synthetic Heights'),'with the client’s project');
eq((await call(`contacts/notes/${timeline.notes[0].id}/remove`,{},{role:'other'})).status,403,'someone else cannot remove it');
eq((await call(`contacts/notes/${timeline.notes[0].id}/remove`,{})).status,200,'the author removes it');
eq((await call(`contacts/${R.contact}/more?part=timeline`)).data.notes.length,0,'and it is gone from the profile');
const files=(await call(`contacts/${R.contact}/more?part=files`)).data.files;
eq(files.map((f)=>f.name).sort(),['Call notes Synthetic Rao.docx','Synthetic Heights brochure.pdf','Synthetic Rao approval.pdf'],'files: their projects’ documents and every file naming them');
const found=(await call(`contacts/${R.contact}/more?part=suggestions`,undefined,{role:'admin'})).data;
eq([found.canLink,found.suggestions.some((x)=>x.kind==='project'&&x.id===R.project2)],[true,true],'Pulse proposes the project whose files name them');
eq((await call(`contacts/${R.contact}/links`,{kind:'project',targetId:R.project2},{role:'leadership'})).status,403,'only an admin links it');
eq((await call(`contacts/${R.contact}/links`,{kind:'project',targetId:R.project2},{role:'admin'})).status,200,'an admin links it');
ok((await call(`contacts/${R.contact}`)).data.projects.some((p)=>p.projectId===R.project2),'the project is now theirs');
eq((await call(`contacts/${R.contact}/more?part=money`)).data.money,null,'a member sees no money');
const money=(await call(`contacts/${R.contact}/more?part=money`,undefined,{role:'leadership'})).data.money;
eq([money.amounts,money.invoices.length,money.invoices[0].number,money.invoices[0].due,money.invoices[0].status],[true,1,'INV-SYN-1',18000,'open'],'leadership sees the client’s invoice with amounts');
ok((await own("select 1 from pulse.audit_event where resource='money' and resource_id=$1",['contact:'+R.contact])).length>=1,'and that read is audited');
eq((await call(`contacts/${R.contact}/more?part=deliveries`,undefined,{role:'hr'})).status,403,'HR-only accounts do not open contacts’ work');
}finally{await app.close();await pool.end();await owner.end();}
await writeFile(process.env.TEST_REPORT,JSON.stringify({checks,receipts},null,1));
console.log(`people-contacts: ${checks} checks passed`);
