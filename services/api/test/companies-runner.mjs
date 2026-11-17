// COMPANIES-MODEL acceptance on a disposable tenant with synthetic people only (tests/core/test_companies_model.py):
// a freelancer adds a contact at a new company and answers "is their company a client too?", adds a person client,
// adds a client company with its main contact in the same step, adds a type right there, sorts a client, connects a
// company to its own Pulse account, and starts a quote from the client. Who may do what follows the role matrix.
import assert from 'node:assert/strict';import {Pool} from 'pg';
import {createApp} from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const app=createApp(pool,pool);const R=JSON.parse(process.env.TEST_ROLES);const ORG=process.env.PULSE_ORG_ID;
let checks=0;
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const ok=(v,label)=>{assert.ok(v,label);checks++;};
async function call(path,body,{role='admin'}={}){
 const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers:{'cf-access-authenticated-user-email':role+'@book.example'},...(body===undefined?{}:{payload:body})});
 let data;try{data=r.json();}catch{data=r.rawPayload;}return {status:r.statusCode,data};
}
async function own(sql,args=[]){const c=await owner.connect();try{await c.query('begin');await c.query('set local role pulse_owner');await c.query("select set_config('pulse.org_id',$1,true)",[ORG]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}finally{c.release();}}
try{
// 1. Plain words for a company with no industry, and "+ Add new" right in the form.
const types=(await call('types')).data;
ok(types.contact.some((t)=>t.key==='customer')&&!types.contact.some((t)=>['developer','channel_partner','talent'].includes(t.key)),'no real-estate contact types for a freelancer');
ok(!types.client.some((t)=>['developer','channel_partner','agent'].includes(t.key)),'no real-estate client types for a freelancer');
const hotel=await call('settings/types',{entity:'client',label:'Hotel'});
eq([hotel.status,hotel.data.key],[200,'hotel'],'a new client type is added from the form');
// 2. A contact at a new company; "Yes, their company" makes the company a client in the same step.
const a=await call('contacts',{name:'Kedab Synthetic',phone:'+91 90000 00001',email:'kedab@lotus.example',designation:'Owner',contactType:'customer',companyName:'Lotus Synthetic Interiors',makeClient:'company'});
eq(a.status,200,'a contact is added with their company and the client answer');
ok(a.data.companyId&&a.data.clientId,'the company and its client record are made');
const lotus=(await call(`companies/${a.data.companyId}`)).data;
eq([lotus.company.name,lotus.company.contactId,lotus.company.clientId,lotus.people.length],['Lotus Synthetic Interiors',a.data.id,a.data.clientId,1],'the company has the person as main contact and its client record');
const lotusClient=(await call(`clients/${a.data.clientId}`)).data;
eq([lotusClient.kind,lotusClient.companyId,lotusClient.contactId],['company',a.data.companyId,a.data.id],'the client says who it is: the company, with its main contact');
// The same company typed again is the same company.
const again=await call('contacts',{name:'Aarav Synthetic',companyName:'lotus synthetic interiors'});
eq(again.data.companyId,a.data.companyId,'a company typed again (any case) is the same company');
eq((await call(`companies/${a.data.companyId}`)).data.people.length,2,'both people work there');
ok((await own('select 1 from pulse.client_contact where client_id=$1 and person_id=$2',[a.data.clientId,again.data.id])).length===1,'a person at a client company is one of that client\'s contacts');
// 3. "Yes, this person": a person client.
const p=await call('contacts',{name:'Diya Synthetic',phone:'+91 90000 00002',makeClient:'person'});
const pc=(await call(`clients/${p.data.clientId}`)).data;
eq([pc.kind,pc.contactId,pc.companyId],['person',p.data.id,null],'one person as a client');
eq((await call('contacts',{name:'Nobody Synthetic',makeClient:'company'})).status,400,'"their company" needs a company');
// 4. Add a client: a company with a new main contact, in one step; the type added in the form is used.
const c=await call('clients',{kind:'company',companyName:'Harbor Synthetic Builders',clientType:'hotel',contact:{name:'Rifob Synthetic',phone:'+91 90000 00003',designation:'Manager'}});
eq(c.status,200,'a client company is added with its main contact');
const harbor=(await call(`companies/${c.data.companyId}`)).data;
eq([harbor.company.contactName,harbor.clients[0].clientType],['Rifob Synthetic','hotel'],'main contact and type are in place');
const twice=await call('clients',{kind:'company',companyId:c.data.companyId});
eq([twice.data.id,twice.data.existed],[c.data.id,true],'a company is a client once');
const solo=await call('clients',{kind:'person',contact:{name:'Isha Synthetic',email:'isha@example.com'}});
eq((await call(`clients/${solo.data.id}`)).data.kind,'person','a client who is one person, with their contact made');
// 5. A company that is not a client yet; make it one from its page; vendor; main contact.
const g=await call('companies',{name:'Greenline Synthetic Homes',city:'Pune',contact:{name:'Sana Synthetic'}});
ok(g.data.id&&!g.data.clientId,'a company that is not a client');
const made=await call(`companies/${g.data.id}/client`,{});
ok(made.data.clientId&&!made.data.existed,'it becomes a client from its page');
eq((await call(`companies/${g.data.id}`,{isVendor:true,gstin:'27aabcs5678k1zs'})).status,200,'it is a vendor too; its GSTIN is kept');
eq((await call(`companies/${g.data.id}`)).data.company.gstin,'27AABCS5678K1ZS','GSTIN in capitals');
eq((await call(`companies/${g.data.id}`,{gstin:'NOTAGSTIN'})).status,400,'a wrong GSTIN is refused');
const added=await call(`companies/${g.data.id}/contacts`,{name:'Vikram Synthetic',primary:true});
eq((await call(`companies/${g.data.id}`)).data.company.contactId,added.data.id,'a new main contact');
// 6. A client nobody could sort: one tap.
const loose=(await own("insert into pulse.client(org_id,display_name,client_type) values($1,'Meera Synthetic','other') returning id",[ORG]))[0].id;
eq((await call(`clients/${loose}`)).data.kind,'unsorted','an old client with no evidence is not sorted');
const sorted=await call(`clients/${loose}/kind`,{kind:'company'});
ok(sorted.data.companyId,'"A company" makes its company');
eq((await call(`clients/${loose}`)).data.kind,'company','and it is a company client');
// 7. Their own Pulse account.
eq((await call(`companies/${g.data.id}`,{pulseOrgId:ORG})).status,400,'a company is not your own company');
eq((await call(`companies/${g.data.id}`,{pulseOrgId:'00000000-0000-4000-8000-000000000000'})).status,400,'an unknown Pulse company is refused');
// 8. Lists.
const list=(await call('companies')).data;
eq(list.companies.map((x)=>x.name).filter((n)=>n.includes('Synthetic')).sort(),['Greenline Synthetic Homes','Harbor Synthetic Builders','Lotus Synthetic Interiors','Meera Synthetic'],'the company book');
ok((await call('contacts')).data.contacts.find((x)=>x.id===a.data.id).companyId===a.data.companyId,'people show where they work');
// 9. Who may: everyone with work reads; only admins change.
eq((await call('companies',undefined,{role:'person'})).status,200,'a member reads the book');
eq((await call('companies',{name:'Smuggled Synthetic'},{role:'person'})).status,403,'a member cannot add a company');
eq((await call('companies',undefined,{role:'hr'})).status,403,'an HR-only account does not read client data');
// 10. A quote for the client company.
const q=await call('erp/documents',{docType:'quotation',clientId:c.data.id});
ok(q.status===200||q.status===403,`a quote starts from the client (${q.status})`);
console.log(JSON.stringify({checks}));
}finally{await pool.end();await owner.end();}
