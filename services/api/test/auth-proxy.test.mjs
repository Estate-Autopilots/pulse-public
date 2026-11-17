import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiProxy,v0ProxyOptions} from '../../../apps/web/app/api/proxy.mjs';
process.env.PULSE_PUBLIC_LOGIN_ENABLED='1';process.env.PULSE_PUBLIC_URL='https://pulse.example.test';
function request(path,origin='https://pulse.example.test',extra={}){return new Request('https://pulse.example.test/api/v0/'+path,{method:'POST',headers:{'content-type':'application/json',origin,host:'pulse.example.test',...extra},body:'{}'});}
const context=path=>({params:Promise.resolve({path:path.split('/')})});
test('all public recovery routes require same origin',async()=>{
 for(const realm of ['', 'portal/'])for(const action of ['forgot','forgot-username','set-password','two-step','confirm-email']){
  const path=realm+'auth/'+action;let called=false;
  const proxy=createApiProxy({...v0ProxyOptions,fetchImpl:async()=>{called=true;return Response.json({ok:true});}});
  assert.equal((await proxy(request(path,'https://evil.example'),context(path))).status,403);assert.equal(called,false);
  assert.equal((await proxy(request(path),context(path))).status,200);
 }
});
test('challenge never sets an undefined session cookie',async()=>{
 const proxy=createApiProxy({...v0ProxyOptions,fetchImpl:async()=>Response.json({twoStep:true,challenge:'synthetic-challenge'})});
 const r=await proxy(request('auth/sign-in'),context('auth/sign-in'));assert.equal(r.headers.has('set-cookie'),false);assert.equal((await r.json()).twoStep,true);
});
test('remembered session is HttpOnly Secure SameSite and token is removed',async()=>{
 const proxy=createApiProxy({...v0ProxyOptions,fetchImpl:async()=>Response.json({token:'synthetic-cookie-value',maxAge:2592000})});
 const r=await proxy(request('auth/two-step'),context('auth/two-step'));assert.match(r.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax; Max-Age=2592000/);assert.equal((await r.json()).token,undefined);
});
test('forged identity and forwarded IP cannot select an account or bypass fallback rate bucket',async()=>{
 let headers;const proxy=createApiProxy({...v0ProxyOptions,fetchImpl:async(_url,options)=>{headers=options.headers;return Response.json({ok:true});}});
 await proxy(request('auth/forgot','https://pulse.example.test',{'cf-access-authenticated-user-email':'admin@example.test','x-pulse-session':'forged','x-forwarded-for':'198.51.100.99'}),context('auth/forgot'));
 assert.equal(headers['x-pulse-session'],undefined);assert.equal(headers['cf-access-authenticated-user-email'],undefined);assert.equal(headers['x-pulse-client-ip'],'unattributed-web');
});
test('client cookie isolates staff data but permits authenticated account switching',async()=>{
 const proxy=createApiProxy({...v0ProxyOptions,fetchImpl:async()=>Response.json({token:'synthetic-staff-session'})});
 assert.equal((await proxy(request('people','https://pulse.example.test',{cookie:'pulse_client_session=synthetic-client'}),context('people'))).status,403);
 const r=await proxy(request('auth/sign-in','https://pulse.example.test',{cookie:'pulse_client_session=synthetic-client'}),context('auth/sign-in'));assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/pulse_client_session=;.*Max-Age=0/);
});
