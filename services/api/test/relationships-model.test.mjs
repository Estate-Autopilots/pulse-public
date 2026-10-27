import test from 'node:test';import assert from 'node:assert/strict';
import {effective,groupEdges,node,KINDS} from '../dist/relationships-model.js';
// R46: synthetic rows as the graph query returns them.
const row=(over={})=>({thread:'t1',id:'v1',version:1,kind:'client',role:'developer',status:'proposed',action:'source',actor:null,note:null,at:'2026-10-12T00:00:00Z',standing:null,
 subjectType:'engagement',subjectId:'e1',objectType:'client',objectId:'c1',objectKey:null,objectLabel:'Northstar',validFrom:'2026-08-01',validTo:null,sourceFamily:'project',
 evidence:[{basis:'The project\'s source records'}],confidence:null,observedAt:null,actorName:null,sId:null,sStatus:null,sRole:null,sObjectType:null,sObjectId:null,sObjectKey:null,
 sObjectLabel:null,sValidFrom:null,sValidTo:null,sActor:null,sActorName:null,sAt:null,sNote:null,sSourceFamily:null,sEvidence:null,subjectLabel:'Lakeview',registryNo:42,
 projectKey:'lakeview@baner',objectName:'Northstar Developers',objectClientType:'developer',disputed:false,sameName:0,...over});
const who={kinds:['client'],me:'p1',admin:false};

test('a source proposal reads as proposed with its source, and only a named reviewer may decide',()=>{
 const e=effective(row(),who);
 assert.equal(e.status,'proposed');assert.equal(e.object.label,'Northstar Developers');assert.equal(e.object.sub,'Developer');assert.equal(e.object.href,'/clients/c1');
 assert.equal(e.subject.sub,'EA-0042');assert.deepEqual(e.source.evidence,['The project\'s source records']);assert.equal(e.source.label,'Project records');
 assert.equal(e.can.decide,true);assert.equal(e.can.undo,false);assert.equal(e.decided,null);assert.equal(e.pending,null);
 assert.equal(effective(row(),{kinds:['team'],me:'p1',admin:true}).can.decide,false);
});

test('a correction waiting keeps the confirmed relationship standing, from a source or a colleague',()=>{
 const base={standing:'v2',sId:'v2',sStatus:'confirmed',sRole:'developer',sObjectType:'client',sObjectId:'c1',sObjectLabel:'Northstar Developers',sActor:'p2',sActorName:'Reviewer',sAt:'2026-10-11T00:00:00Z',sSourceFamily:'project',sEvidence:[]};
 const fromSource=effective(row({...base,id:'v3',version:3,action:'source_changed',objectId:'c9',objectName:'Skyline Realty',objectClientType:'channel_partner'}),who);
 assert.equal(fromSource.status,'confirmed');assert.equal(fromSource.object.id,'c1');assert.equal(fromSource.decided.by,'Reviewer');
 assert.equal(fromSource.pending.object.id,'c9');assert.equal(fromSource.pending.fromSource,true);assert.equal(fromSource.pending.object.sub,'Channel partner');
 const fromColleague=effective(row({...base,id:'v3',version:3,action:'suggest',actor:'p1',actorName:'Colleague',sourceFamily:'person',objectId:'c9'}),who);
 assert.equal(fromColleague.pending.by,'Colleague');assert.equal(fromColleague.can.undo,true);
 // The source agreed again: the correction is withdrawn and the confirmed relationship stands with nothing pending.
 const withdrawn=effective(row({...base,id:'v4',version:4,status:'withdrawn',action:'source_gone'}),who);
 assert.equal(withdrawn.status,'confirmed');assert.equal(withdrawn.pending,null);
});

test('a written name with no record stays unresolved and links nowhere',()=>{
 const e=effective(row({kind:'team',role:'Assigned PM',objectType:'employee',objectId:null,objectLabel:'Opinem',objectName:null}),{kinds:['team'],me:null,admin:false});
 assert.equal(e.object.resolved,false);assert.equal(e.object.href,null);assert.match(e.object.sub,/no record/);
 assert.equal(node('development',null,'lakeview@baner','Lakeview · Baner',null).href,'/relationships?dev=lakeview%40baner');
});

test('engagement records of one RE project group together; a client groups its contacts',()=>{
 const edges=[
  effective(row({thread:'a',subjectId:'e1'}),who),
  effective(row({thread:'b',kind:'development',subjectId:'e1',objectType:'development',objectId:null,objectKey:'lakeview@baner',objectLabel:'Lakeview · Baner',objectName:null,role:null}),who),
  effective(row({thread:'c',kind:'development',subjectId:'e2',subjectLabel:'Lakeview (2)',registryNo:43,objectType:'development',objectId:null,objectKey:'lakeview@baner',objectLabel:'Lakeview · Baner',objectName:null,role:null}),who),
  effective(row({thread:'d',subjectId:'e3',subjectLabel:'Solo',projectKey:null}),who),
  effective(row({thread:'e',kind:'contact',subjectType:'client',subjectId:'c1',subjectLabel:'Northstar Developers',objectType:'contact',objectId:'k1',objectName:'Ravi',role:'Primary contact',projectKey:null}),who),
 ];
 const groups=groupEdges(edges);
 assert.deepEqual(groups.map(g=>[g.type,g.edges.length]),[['development',3],['engagement',1],['client',1]]);
 assert.equal(groups[0].label,'Lakeview · Baner');assert.deepEqual(groups[0].engagements.map(x=>x.sub),['EA-0042','EA-0043']);
 assert.equal(KINDS.length,6);
});
