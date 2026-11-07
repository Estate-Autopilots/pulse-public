// R52 over HTTP: a company's connectors are its admins' alone; the install preview writes nothing; EA Connect always
// installs Pulse's own manifest whatever a body says; roots, grants and upgrades are checked with plain refusals; the
// approval waits for the company's own credential; revoking is final; Settings shows the card. Synthetic data only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),app=createApp(pool,pool);
const META='https://www.googleapis.com/auth/drive.metadata.readonly',KEY=Buffer.alloc(32,9).toString('base64');
const call=async(url,payload,token)=>{const r=await app.inject({url,method:payload?'POST':'GET',headers:token?{'x-pulse-session':token}:{},...(payload?{payload}:{})});
 return {status:r.statusCode,data:r.headers['content-type']?.includes('json')?r.json():r.body};};
const login=async username=>{const r=await call('/api/v0/auth/sign-in',{username,password:'Synthetic-issued-2026!'});assert.equal(r.status,200,username);const token=r.data.token;
 assert.equal((await call('/api/v0/auth/change-password',{current:'Synthetic-issued-2026!',next:'Synthetic-new-2026!'},token)).status,200);return token;};
const member=await login('user1x'),hr=await login('user3x'),admin=await login('user4x');
// RELEASE-6: the module shows with PULSE_CONNECTORS=setup (tests/core/conftest.py) while nothing is read on this server.
assert.ok([undefined,'setup'].includes(process.env.PULSE_CONNECTORS),'the runner starts with connectors not reading on this server');

// Admins only; HR and members are refused everywhere, signed-out callers first sign in.
assert.equal((await call('/api/v0/connectors')).status,401);
for(const t of [member,hr]){
 assert.equal((await call('/api/v0/connectors',null,t)).status,403);
 assert.equal((await call('/api/v0/connectors/preview',{implementation:'ea_connect'},t)).status,403);
 assert.equal((await call('/api/v0/connectors',{implementation:'ea_connect'},t)).status,403);
}
const empty=(await call('/api/v0/connectors',null,admin)).data;
assert.deepEqual([empty.contract,empty.server,empty.installs,empty.gates.map(g=>g.id)],['connector.v1',false,[],['E13','E18','server']]);
assert.equal(empty.eaConnect.ok,true);assert.deepEqual(empty.eaConnect.scopes.map(s=>s.scope),[META]);

// The preview writes nothing and explains problems.
const bad=(await call('/api/v0/connectors/preview',{implementation:'plugin',manifest:{contract:'connector.v1'},publicKey:'nope'},admin)).data;
assert.equal(bad.ok,false);assert.ok(bad.problems.length>0);
assert.equal((await call('/api/v0/connectors',null,admin)).data.installs.length,0);

// EA Connect installs Pulse's own manifest: a body asking for more, or naming another company, changes nothing.
const greedy={...empty.eaConnect.connector,scopes:[{scope:'https://www.googleapis.com/auth/drive',why:'Synthetic: everything'}]};
const made=await call('/api/v0/connectors',{implementation:'ea_connect',manifest:greedy,orgId:'00000000-0000-4000-8000-000000000009',secretRef:'acme-drive',label:'EA Connect (synthetic)'},admin);
assert.equal(made.status,200,JSON.stringify(made.data));const ea=made.data.id;
assert.equal((await call('/api/v0/connectors',{implementation:'ea_connect'},admin)).status,409,'one live EA Connect per company');
let list=(await call('/api/v0/connectors',null,admin)).data.installs;
assert.deepEqual([list[0].id,list[0].label,list[0].credential.ref,list[0].health],[ea,'EA Connect (synthetic)','acme-drive','needs_secret']);
assert.deepEqual(list[0].scopes.map(s=>s.scope),[META]);

// Roots: a kind the connector reads, an id from the Drive address, a name.
assert.equal((await call(`/api/v0/connectors/${ea}/sources`,{kind:'mailbox',ref:'x',label:'Mail'},admin)).status,400);
assert.equal((await call(`/api/v0/connectors/${ea}/sources`,{kind:'folder',ref:'../etc',label:'Bad'},admin)).status,400);
assert.equal((await call(`/api/v0/connectors/${ea}/sources`,{kind:'folder',ref:'synthetic-root',label:'Root',entities:['mail.message.sent']},admin)).status,400);
const root=await call(`/api/v0/connectors/${ea}/sources`,{kind:'shared_drive',ref:'synthetic-drive',label:'Synthetic deliverables'},admin);assert.equal(root.status,200);
assert.equal((await call(`/api/v0/connectors/${ea}/sources`,{kind:'shared_drive',ref:'synthetic-drive',label:'Again'},admin)).status,409);
// The approval waits for the company's own credential in its secret store.
const early=await call(`/api/v0/connectors/${ea}/approve`,{scopes:[META],entities:['drive.file.created'],approvalRef:'E13 synthetic'},admin);
assert.equal(early.status,409);assert.match(early.data.error,/^the company's Google credential is not installed/);
const same=await call(`/api/v0/connectors/${ea}/upgrade`,{},admin);assert.equal(same.status,400);assert.match(same.data.error,/higher version/);

// A company plugin: its manifest and public key; grants are checked against the manifest and the scopes.
const manifest={contract:'connector.v1',key:'acme-sync',name:'Synthetic plugin',version:'1.0.0',publisher:'Synthetic Co',transport:'push',auth:'signed_push',
 scopes:[{scope:META,why:'Synthetic: read file metadata of approved folders'}],sources:['folder'],entities:[{type:'drive.file.created',schema:1},{type:'drive.file.updated',schema:1}]};
const p=await call('/api/v0/connectors',{implementation:'plugin',manifest,publicKey:KEY},admin);assert.equal(p.status,200,JSON.stringify(p.data));const pid=p.data.id;
assert.equal((await call(`/api/v0/connectors/${pid}/approve`,{scopes:[META],entities:['drive.file.created'],approvalRef:'E18 synthetic'},admin)).status,409,'a root first');
assert.equal((await call(`/api/v0/connectors/${pid}/sources`,{kind:'shared_drive',ref:'synthetic-drive',label:'Drive'},admin)).status,400,'this plugin reads folders only');
assert.equal((await call(`/api/v0/connectors/${pid}/sources`,{kind:'folder',ref:'plugin-root',label:'Plugin root'},admin)).status,200);
for(const [b,why] of [[{scopes:[META],entities:['drive.file.trashed'],approvalRef:'E18 synthetic'},/manifest lists/],[{scopes:[],entities:['drive.file.created'],approvalRef:'E18 synthetic'},/needs https/],
 [{scopes:[META],entities:['drive.file.created'],approvalRef:'x'},/where the approval is recorded/]]){
 const r=await call(`/api/v0/connectors/${pid}/approve`,b,admin);assert.equal(r.status,400,JSON.stringify(b));assert.match(r.data.error,why);
}
assert.deepEqual((await call(`/api/v0/connectors/${pid}/approve`,{scopes:[META],entities:['drive.file.created'],approvalRef:'E18 synthetic approval'},admin)).data,{status:'active',version:'1.0.0'});
const up=await call(`/api/v0/connectors/${pid}/upgrade`,{manifest:{...manifest,version:'1.1.0',entities:[...manifest.entities,{type:'drive.folder.created',schema:1}]}},admin);
assert.equal(up.status,200);assert.deepEqual(up.data.newEntities,['drive.file.updated','drive.folder.created']);
list=(await call('/api/v0/connectors',null,admin)).data.installs;const pl=list.find(i=>i.id===pid);
assert.deepEqual([pl.status,pl.health,pl.next,pl.proposed.version,pl.credential.kind],['active','needs_grant','Approve the new version','1.1.0','ed25519']);
assert.equal(JSON.stringify(list).includes(KEY),false,'the public key itself is not echoed, only its id');

// Settings → Connected sources shows the card.
const card=(await call('/api/v0/settings',null,admin)).data.sources.find(s=>s.key==='connectors');
assert.deepEqual([card.label,card.state],['Company connectors','attention']);

// Revoking needs a reason, is final, and is the admins' alone.
assert.equal((await call(`/api/v0/connectors/${pid}/revoke`,{reason:'Synthetic: not mine'},member)).status,403);
assert.equal((await call(`/api/v0/connectors/${pid}/revoke`,{reason:'x'},admin)).status,400);
assert.deepEqual((await call(`/api/v0/connectors/${pid}/revoke`,{reason:'Synthetic: the plugin is retired'},admin)).data,{status:'revoked'});
assert.equal((await call(`/api/v0/connectors/${pid}/revoke`,{reason:'Synthetic: again'},admin)).status,409);
assert.equal((await call(`/api/v0/connectors/${pid}/approve`,{scopes:[META],entities:['drive.file.created'],approvalRef:'E18 synthetic approval'},admin)).status,409);
assert.equal((await call('/api/v0/connectors/00000000-0000-4000-8000-000000000001/revoke',{reason:'Synthetic: nobody'},admin)).status,404);
assert.equal((await call('/api/v0/connectors/not-a-uuid/sources',{kind:'folder',ref:'x',label:'X y'},admin)).status,404);
list=(await call('/api/v0/connectors',null,admin)).data.installs;
assert.deepEqual(list.map(i=>[i.implementation,i.health]),[['ea_connect','needs_secret'],['plugin','revoked']]);
await app.close();await pool.end();
console.log('connectors runner: ok');
