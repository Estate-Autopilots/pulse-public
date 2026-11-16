import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarise,tabMonth} from '../dist/people-work.js';
import {evidenceLines,groupItems} from '../dist/review-groups.js';

// Synthetic people and projects only (PEOPLE-LIVE).
const thisMonth=new Date().toISOString().slice(0,7);
test('A tracker tab names the month of rows that have no date of their own',()=>{
 assert.equal(tabMonth('VOV Mar 2026'),'2026-03');assert.equal(tabMonth('sept 2026'),'2026-09');assert.equal(tabMonth('June 26'),'2026-06');
 assert.equal(tabMonth('Ridihu (March)',2025),'2025-03');assert.equal(tabMonth('Sheet1'),null);assert.equal(tabMonth('Maple Heights'),null);
});
test('The summary counts confirmed work, keeps suggestions apart and ranks confirmed clients first',()=>{
 const tasks=[{title:'VOV — Alpha',status:'done',day:`${thisMonth}-02`,link:{status:'owned'}},{title:'VOV — Beta',status:'done',day:`${thisMonth}-03`,link:{status:'accepted'}},
  {title:'Model Video — Beta',status:'open',day:`${thisMonth}-04`,link:{status:'owned'}},{title:'Reel — Gamma',status:'done',period:'Graphics',day:null,link:{status:'suggested'}}];
 const projects=[{title:'Alpha',clientName:'Client A',accepted:true,active:true,tasks:1,projectStatus:'active',to:`${thisMonth}-02`},{title:'Gamma',clientName:'Client C',accepted:false,tasks:5}];
 const s=summarise(tasks,projects,[{status:'accepted',deliveredAt:`${thisMonth}-05T10:00:00Z`},{status:'suggested',deliveredAt:`${thisMonth}-05T10:00:00Z`}],[{m:`${thisMonth}-01`,n:2}]);
 assert.deepEqual(s.workingOn.map(w=>w.kind),['VOV','Model Video']);assert.equal(s.workingOnSuggested,false);
 const now=s.trend.at(-1);assert.equal(now.month,thisMonth);assert.equal(now.tasks,2);assert.equal(now.deliveries,3);assert.equal(s.trend.length,6);
 assert.equal(s.creditedDeliveries,2);assert.equal(s.activeProjects,1);assert.deepEqual(s.clients.slice(0,2),['Client A','Client C']);
 // Only suggestions: what they work on still shows, marked as suggested.
 const only=summarise([tasks[3]],[],[],[]);assert.deepEqual(only.workingOn.map(w=>w.kind),['Reel']);assert.equal(only.workingOnSuggested,true);
});
test('Evidence lines name the method, tab and row, never a raw Drive id',()=>{
 const lines=evidenceLines([{method:'structured import',sheet:'Sheet1',row:12,source_id:'1AbCdEfGhIjKlMnOpQrStUvWxYz0123'},{method:'baseline registry',source_id:'projects.csv'}]);
 assert.deepEqual(lines,['structured import · tab “Sheet1” · row 12','baseline registry · projects.csv']);
 assert.deepEqual(evidenceLines(null),[]);
});
test('Project pods group by the proposed pod and PM; a missing pod comes from the PM or a pod-titled client sheet',()=>{
 const pods=['Pod 1','Pod 2','Shared'];
 const rows=[
  {id:'a',kind:'project_pod',title:'Alpha',confidence:.97,proposed:{pod:'Pod 1',pgsCandidate:'Asha Rao'},evidence:[{method:'registry'}],hints:[{role:'Assigned PM',pod:'Pod 1',name:'Asha Rao'}]},
  {id:'b',kind:'project_pod',title:'Beta',confidence:.95,proposed:{pod:'Pod 1',pgsCandidate:'Asha Rao'},evidence:[]},
  {id:'c',kind:'project_pod',title:'Gamma',confidence:.9,proposed:{pod:null,pgsCandidate:'Ravi'},evidence:[],hints:[{role:'Assigned PM',pod:'Pod 2',name:'Ravi Kalah'}]},
  {id:'d',kind:'project_pod',title:'Delta',confidence:0,proposed:{pod:null},evidence:[],hints:[{role:'Runs the client sheet',pod:'Pod 1',sheetPod:'Pod 2'}]},
  {id:'e',kind:'project_pod',title:'Epsilon',confidence:0,proposed:{pod:null},evidence:[]},
  {id:'f',kind:'project_pod',title:'Zeta',confidence:.96,proposed:{pod:'Pod 1',pgsCandidate:'Ravi'},evidence:[],hints:[{role:'Assigned PM',pod:'Pod 2',name:'Ravi Kalah'}]},
  {id:'i',kind:'project_pod',title:'Eta',confidence:0,proposed:{pod:null},evidence:[],hints:[{role:'PGS for the client',pod:'Pod 2',name:'Ravi Kalah',sheetPod:'Pod 1'}]},
  {id:'g',kind:'data_gap',title:'Alpha',entity_type:'project',proposed:{missing:['client']},evidence:{}},
  {id:'h',kind:'duplicate',title:'Two Alphas',proposed:{},evidence:{}},
  {id:'j',kind:'project_pod',title:'Theta',confidence:.99,source_key:'onboard_project_fill:pod:theta',proposed:{pod:'Pod 1'},evidence:{ruleId:'synthetic@1:pods:default'}},
  {id:'k',kind:'project_pod',title:'Iota',confidence:.95,source_key:'configured:iota',proposed:{pod:'Pod 1'},evidence:{ruleId:'synthetic@1:pods:configured'}},
  {id:'l',kind:'onboard_project_fill',title:'Kappa',confidence:.95,source_key:'onboard_project_fill:deliverable_type:kappa',proposed:{field:'deliverable_type',deliverableType:'model_video'},evidence:{ruleId:'synthetic@1:creative_types:model_video'}},
 ];
 const g=groupItems(rows,pods);const by=k=>g.find(x=>x.ids.includes(k));
 assert.equal(by('a'),by('b'));assert.equal(by('a').pod,'Pod 1');assert.equal(by('a').count,2);assert.equal(by('a').high,2);
 assert.equal(by('c').pod,'Pod 2');assert.match(by('c').note,/Ravi is the assigned PM and works in Pod 2/);assert.equal(by('c').canAccept,true);
 assert.equal(by('d').pod,'Pod 2');assert.match(by('d').note,/client sheet titled “Pod 2” names these projects/);
 // The sheet says Pod 1, the PGS works in Pod 2: no pod is proposed, the group asks for one.
 assert.equal(by('i').pod,null);assert.equal(by('i').canAccept,false);assert.match(by('i').note,/Sources disagree/);
 assert.equal(by('e').pod,null);assert.equal(by('e').canAccept,false);assert.equal(by('e').label,'No pod or PM in any source');
 assert.match(by('f').note,/own pod is Pod 2: check before accepting/);
 assert.match(by('g').label,/Projects missing client/);assert.match(by('g').note,/Choose the client/);
 assert.equal(by('h').canAccept,false);
 // Fill suggestions never join a bulk-acceptable pod group.
 assert.equal(by('j'),by('k'));assert.notEqual(by('j'),by('a'));assert.equal(by('j').canAccept,false);assert.equal(by('a').count,2);
 assert.equal(by('l').canAccept,false);assert.match(by('l').note,/one by one/);
 // Groups that can be accepted come first; ids never leave the server in the API response (stripped there).
 assert.equal(g.findIndex(x=>!x.canAccept)>g.findLastIndex(x=>x.canAccept),true);
});
