import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerAccountSecurity} from '../dist/account-security.js';
import {authMailAvailable} from '../dist/auth-mail.js';
import {runWithCompany} from '../dist/tenant-context.js';

const keys=['PULSE_CI','NODE_ENV','PULSE_AUTH_MAIL_MODE','PULSE_GMAIL_SEND_ENABLED','PULSE_PUBLIC_URL'];
const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
afterEach(()=>{for(const k of keys)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];});
function configured(enabled='0') {
 Object.assign(process.env,{PULSE_CI:'0',NODE_ENV:'production',PULSE_AUTH_MAIL_MODE:'disabled',PULSE_GMAIL_SEND_ENABLED:enabled,PULSE_PUBLIC_URL:'https://pulse-staging.estateautopilots.com'});
}
function setup() {
 const calls=[],app=Fastify();
 const client={query:async(sql,params)=>{
  calls.push({sql,params});
  if(sql.includes('auth_allow'))return {rows:[{ok:true}]};
  return {rows:[{d:params?.[1]==='known'?{actor:'00000000-0000-0000-0000-000000000001',username:'synthetic',delivery:'synthetic@example.test'}:null}]};
 }};
 registerAccountSecurity(app,{open:fn=>fn(client),tx:()=>{throw Error('Unexpected authenticated route');}});
 return {app,calls};
}
test('disabled recovery matches for known/unknown accounts in both realms without lookup or token writes',async()=>{
 configured();const {app,calls}=setup();
 try {
  for(const realm of ['auth','portal/auth'])for(const action of ['forgot','forgot-username']){
   const responses=[];
   for(const username of ['known','absent']){
    const r=await app.inject({method:'POST',url:'/api/v0/'+realm+'/'+action,payload:{username}});
    assert.equal(r.statusCode,503);responses.push(r.json());
   }
   assert.deepEqual(responses[0],responses[1]);
   assert.deepEqual(responses[0],{code:'MAIL_UNAVAILABLE',error:'Mail is unavailable; ask your admin for a new link.'});
  }
  assert.equal(calls.length,16);assert.ok(calls.every(c=>c.sql.includes('auth_allow')));
 }finally{await app.close();}
});
test('configured availability respects tenant sender boundaries and the safe test sink',()=>{
 configured('1');assert.equal(authMailAvailable(),true);
 runWithCompany({host:'tenant.example.test',company:{org:'synthetic',signIn:'password',status:'active',rehearsal:false}},()=>assert.equal(authMailAvailable(),false));
 process.env.PULSE_AUTH_MAIL_MODE='sink';assert.equal(authMailAvailable(),true);
});
test('recipient delivery failure and unknown account keep the same conditional response',async()=>{
 // The staging recipient guard refuses the synthetic recipient before any external transport call.
 configured('1');const {app,calls}=setup();
 try{
  const known=await app.inject({method:'POST',url:'/api/v0/auth/forgot',payload:{username:'known'}});
  const unknown=await app.inject({method:'POST',url:'/api/v0/auth/forgot',payload:{username:'absent'}});
  assert.equal(known.statusCode,200);assert.equal(unknown.statusCode,200);
  assert.deepEqual(known.json(),unknown.json());assert.match(known.json().message,/mail delivery is available/);
  assert.doesNotMatch(known.body,/sent|will arrive|token|synthetic@example/);
  assert.equal(calls.filter(c=>c.sql.includes('auth_recover')).length,2);
 }finally{await app.close();}
});
