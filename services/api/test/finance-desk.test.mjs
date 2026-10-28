import assert from 'node:assert/strict';
import test from 'node:test';
import {createApp} from '../dist/app.js';

const person = '00000000-0000-0000-0000-000000000001';
const org = '00000000-0000-0000-0000-000000000002';
const headers = {'cf-access-authenticated-user-email':'ca@example.test','content-type':'application/json'};
function fixture({accountant=true, role='person', denyFinance=false}={}) {
  const calls=[];
  let claimed=false;
  const client={
    async query(sql,args=[]) {
      calls.push({sql,args});
      if (['begin','commit','rollback'].includes(sql) || sql.includes('set_config') || sql.includes('pulse.audit_') || sql.includes('last_active_at')) return {rows:[]};
      if (sql.includes('select p.id person,p.display_name name')) return {rows:[{person,name:'Synthetic CA',status:'active',username:'fixture-ca',accounts:['ca@example.test'],roles:[role],accountant}]};
      if (sql.includes('pulse.auth_enforcement')) return {rows:[{blocked:false}]};
      if (sql.includes('pulse.org_modules')) return {rows:[{m:{tasks:true,chats:true,finance:true,attendance:false}}]}; // UX-TENANT: every module on
      if (sql.includes('pulse.hr_is_cofounder')) return {rows:[{approve:role==='leadership'}]};
      if (sql.includes('pulse.finance_desk_authorize')) { if(denyFinance) throw Object.assign(new Error('Expired or no verified two-step session'),{code:'42501'});return {rows:[]}; }
      if (sql.includes('pulse.finance_desk_state')) return {rows:[{data:{records:[],files:[],sends:[]}}]};
      if (sql.includes('pulse.finance_desk_file_get')) return {rows:[{data:{name:'synthetic.pdf',mime:'application/pdf',data:Buffer.from('%PDF-fixture').toString('base64')}}]};
      if (sql.includes('pulse.finance_desk_send_claim')) {
        if(claimed)throw Object.assign(new Error('Already claimed'),{code:'23505'});
        claimed=true;return {rows:[{data:{to:'ca@example.test',subject:'Fixture',emailBody:'Fixture',synthetic:true}}]};
      }
      if (sql.includes('pulse.finance_desk_send_finish')) return {rows:[]};
      if (sql.includes("doc_key='modules'")) return { rows: [] }; // no modules document: every module on
      throw new Error('Unexpected RF1 query: '+sql);
    },release() {},
  };
  return {app:createApp({query:async()=>({rows:[{org_id:org}]})},{connect:async()=>client}),calls};
}

test('Accountant central boundary denies all staff/HR/chat and legacy finance endpoints',async()=>{
  const {app,calls}=fixture();
  try {
    for(const path of ['finance','money','people','hr/self','chats','attendance','projects','companion','settings','notifications','review-data','audit']) {
      const response=await app.inject({method:'GET',url:'/api/v0/'+path,headers});
      assert.equal(response.statusCode,403,path);
    }
    for(const path of ['finance/source','finance/desk/approve-send','finance/desk/accountants']) {
      const response=await app.inject({method:'POST',url:'/api/v0/'+path,headers,payload:{key:'close:2026-09',synthetic:true}});
      assert.equal(response.statusCode,403,path);
    }
    assert(!calls.some(c=>c.sql.includes('finance_desk_send_claim')));
  } finally {await app.close();}
});

test('Accountant finance view audits even Access identity and delegates verified-session validation to SQL',async()=>{
  const {app,calls}=fixture();
  try {
    const response=await app.inject({method:'GET',url:'/api/v0/finance/desk?pilot=synthetic',headers});
    assert.equal(response.statusCode,200);
    assert.equal(response.json().accountant,true);
    assert.equal(response.json().canApprove,false);
    assert(calls.some(c=>c.sql.includes("pulse.audit_write('accountant_view'")&&c.args[0]==='/api/v0/finance/desk'));
    assert(calls.some(c=>c.sql.includes('pulse.session_hash')&&c.args[0]===''));
    assert(calls.some(c=>c.sql.includes('finance_desk_authorize(false)')));
  } finally {await app.close();}
  const denied=fixture({denyFinance:true});
  try {
    assert.equal((await denied.app.inject({method:'GET',url:'/api/v0/finance/desk',headers})).statusCode,403);
    assert(!denied.calls.some(c=>c.sql.includes('finance_desk_state')));
  } finally {await denied.app.close();}
});

test('Evidence downloads are private and accountant cannot disable required two-step verification',async()=>{
  const {app}=fixture();
  try {
    const response=await app.inject({method:'GET',url:'/api/v0/finance/desk/files/synthetic-key?pilot=synthetic',headers});
    assert.equal(response.statusCode,200);
    assert.equal(response.headers['cache-control'],'private, no-store');
    assert.match(response.headers['content-disposition'],/attachment/);
    assert.equal(response.body,'%PDF-fixture');
    const disabled=await app.inject({method:'POST',url:'/api/v0/auth/account',headers,payload:{action:'totp-disable'}});
    assert.equal(disabled.statusCode,403);
  } finally {await app.close();}
});

test('Founder fixture send consumes approval once and never uses an external provider',async()=>{
  const {app,calls}=fixture({accountant:false,role:'leadership'});
  try {
    const request={method:'POST',url:'/api/v0/finance/desk/approve-send',headers,payload:{key:'close:2026-09',synthetic:true}};
    const first=await app.inject(request);
    assert.equal(first.statusCode,200);
    assert.equal(first.json().status,'sink');
    const second=await app.inject(request);
    assert.equal(second.statusCode,409);
    assert.equal(calls.filter(c=>c.sql.includes('finance_desk_send_finish')).length,1);
    const live=await app.inject({...request,payload:{key:'close:2026-09'}});
    assert.equal(live.statusCode,409);
  } finally {await app.close();}
});
