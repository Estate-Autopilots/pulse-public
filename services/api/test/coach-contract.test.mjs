// R50: the coach.v1 contract without a database. Synthetic evidence only: forbidden fields refused by the schema, cited
// suggestions only, the stub is deterministic, a late or broken provider ends as timed out or failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { askCoach, checkEvidence, checkSuggestions, stubProvider, PROVIDERS, ACTIVATION_GATES, coachServerOn } from '../dist/coach-contract.js';

const packet={contract:'coach.v1',purpose:'internal_job_fit',subject:'subject',method:{weightsVersion:0,accepted:false},scale:['Learning','Working','Strong','Expert'],evidence:[
 {id:'e1',requirement:{skill:'Synthetic video editing',importance:'required',minLevel:3,recentMonths:12},outcome:'matched',points:1.8,weight:3,record:{skill:'Synthetic video editing',via:'same',level:3,basis:'self',recent:true,lastUsed:'2026-08'}},
 {id:'e2',requirement:{skill:'Synthetic shoot direction',importance:'required',minLevel:2,recentMonths:null},outcome:'missing',points:0,weight:3,record:{skill:'Synthetic shoot direction',via:'same',level:1,basis:'self',recent:true,lastUsed:null}},
 {id:'e3',requirement:{skill:'Synthetic spreadsheets',importance:'preferred',minLevel:null,recentMonths:6},outcome:'matched',points:0.5,weight:1,record:{skill:'Synthetic spreadsheets',via:'exact',level:2,basis:'verified',recent:false,lastUsed:'2024-01'}},
 {id:'e4',requirement:{skill:'Synthetic scripting',importance:'preferred',minLevel:null,recentMonths:null},outcome:'unknown',points:0,weight:1,record:null},
 {id:'e5',requirement:{skill:'Synthetic colour grading',importance:'preferred',minLevel:null,recentMonths:null},outcome:'matched',points:1,weight:1,record:{skill:'Synthetic colour grading',via:'same',level:3,basis:'verified',recent:true,lastUsed:'2026-09'}}]};
const clone=x=>structuredClone(x);

test('the packet schema takes the narrow evidence and refuses every other field',()=>{
 assert.equal(checkEvidence(packet).ok,true);
 const refused=[
  p=>{p.salary=120000;},p=>{p.payroll={month:'2026-09'};},p=>{p.chat=['Synthetic: I am an expert'];},p=>{p.whatsapp='Synthetic';},
  p=>{p.activity=[{app:'Premiere',minutes:300}];},p=>{p.attendance={late:240};},p=>{p.leave=3;},p=>{p.contact={phone:'+910000000000'};},
  p=>{p.name='Editor One';},p=>{p.personId='0b5a9a3e-1111-4c4c-8888-123456789abc';},p=>{p.job={title:'Synthetic launch editor'};},
  p=>{p.evidence[0].notes='Synthetic private note';},p=>{p.evidence[0].record.verifiedBy='Editor Two';},p=>{p.evidence[0].requirement.note='Synthetic';},
  p=>{p.evidence[0].record.file='Synthetic contract.pdf';},p=>{p.method.salaryBand=3;},p=>{p.subject='Editor One';},p=>{p.contract='coach.v2';},
  p=>{p.purpose='performance_review';},p=>{p.evidence[0].outcome='rejected';},p=>{p.evidence[0].id='person-1';},
 ];
 for(const change of refused){const p=clone(packet);change(p);const r=checkEvidence(p);assert.equal(r.ok,false,JSON.stringify(p).slice(0,200));assert.equal(r.failure,'schema');}
 // Identifiers and e-mail addresses are refused even inside allowed fields.
 for(const value of ['Edit for 0b5a9a3e-1111-4c4c-8888-123456789abc','Ask synthetic.person@example.test']){
  const p=clone(packet);p.evidence[0].requirement.skill=value;assert.deepEqual(checkEvidence(p),{ok:false,failure:'identifier'});
 }
});

test('suggestions must cite this packet, stay within the kinds and the number, and carry no identifiers',()=>{
 const ok={contract:'coach.v1',suggestions:[{kind:'verify',text:'Synthetic: verify it',cites:['e1']}]};
 assert.deepEqual(checkSuggestions(packet,ok,5),{ok:true,suggestions:ok.suggestions});
 const bad=[
  [{contract:'coach.v1',suggestions:[{kind:'verify',text:'Synthetic',cites:[]}]},'schema'],
  [{contract:'coach.v1',suggestions:[{kind:'verify',text:'Synthetic'}]},'schema'],
  [{contract:'coach.v1',suggestions:[{kind:'reject',text:'Synthetic: reject them',cites:['e1']}]},'schema'],
  [{contract:'coach.v1',suggestions:[{kind:'hire',text:'Synthetic: hire them',cites:['e1']}]},'schema'],
  [{contract:'coach.v1',suggestions:[{kind:'verify',text:'Synthetic',cites:['e1'],score:0.92}]},'schema'],
  [{contract:'coach.v1',suggestions:[],decision:'shortlist'},'schema'],
  [{contract:'coach.v1',suggestions:[{kind:'verify',text:'Synthetic',cites:['e9']}]},'citation'],
  [{contract:'coach.v1',suggestions:[{kind:'verify',text:'Synthetic',cites:['e1','e1']}]},'schema'],
  [{contract:'coach.v1',suggestions:[{kind:'verify',text:'Mail synthetic.person@example.test',cites:['e1']}]},'identifier'],
  [{contract:'coach.v1',suggestions:Array.from({length:3},()=>({kind:'learn',text:'Synthetic',cites:['e4']}))},'too_many'],
  ['Synthetic free text','schema'],[null,'schema'],
 ];
 for(const [answer,failure] of bad)assert.deepEqual(checkSuggestions(packet,answer,2),{ok:false,failure},JSON.stringify(answer));
});

test('the stub is deterministic, cites what it reads and suggests next steps, never decisions',async()=>{
 const signal=new AbortController().signal;
 const a=await stubProvider.suggest(clone(packet),{signal,max:5}),b=await stubProvider.suggest(clone(packet),{signal,max:5});
 assert.deepEqual(a,b);
 assert.deepEqual(a.suggestions.map(s=>[s.kind,s.cites]),[['verify',['e1']],['ask_check',['e2']],['record_work',['e3']],['ask_check',['e4']]]);
 assert.match(a.suggestions[1].text,/at Learning, below the Working asked/);
 assert.equal(checkSuggestions(packet,a,5).ok,true);
 assert.equal((await stubProvider.suggest(clone(packet),{signal,max:2})).suggestions.length,2);
 assert.deepEqual(Object.keys(PROVIDERS),['stub'],'only the stub exists');
});

test('a late, broken or failing provider ends as timed out or failed; the answer is not passed on',async()=>{
 const slow={name:'stub',version:'slow-test',suggest:(_p,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')));})};
 const t0=Date.now(),late=await askCoach(slow,packet,{timeoutMs:150,max:5});
 assert.equal(late.status,'timed_out');assert.ok(Date.now()-t0<2000);assert.equal('suggestions' in late,false);
 const broken={name:'stub',version:'broken-test',suggest:async()=>({contract:'coach.v1',suggestions:[{kind:'verify',text:'Synthetic',cites:['e42']}]})};
 assert.deepEqual(await askCoach(broken,packet,{timeoutMs:1000,max:5}).then(o=>[o.status,o.failure]),['failed','citation']);
 const leaky={name:'stub',version:'leaky-test',suggest:async()=>({contract:'coach.v1',suggestions:[],salary:1})};
 assert.deepEqual(await askCoach(leaky,packet,{timeoutMs:1000,max:5}).then(o=>[o.status,o.failure]),['failed','schema']);
 const throws={name:'stub',version:'throws-test',suggest:async()=>{throw new Error('Synthetic outage');}};
 assert.deepEqual(await askCoach(throws,packet,{timeoutMs:1000,max:5}).then(o=>[o.status,o.failure]),['failed','error']);
 const answered=await askCoach(stubProvider,packet,{timeoutMs:1000,max:5});
 assert.equal(answered.status,'answered');assert.equal(answered.suggestions.length,4);assert.equal(answered.version,'stub-1');
});

test('off by default: the server switch and the open gates',()=>{
 const before=process.env.PULSE_COACH;delete process.env.PULSE_COACH;assert.equal(coachServerOn(),false);
 process.env.PULSE_COACH='1';assert.equal(coachServerOn(),true);
 if(before===undefined)delete process.env.PULSE_COACH;else process.env.PULSE_COACH=before;
 assert.deepEqual(ACTIVATION_GATES.map(g=>[g.id,g.status]),[['E16','open'],['E08','open'],['provider-terms','open'],['build','open']]);
});
