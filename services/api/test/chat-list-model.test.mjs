import test from 'node:test';import assert from 'node:assert/strict';import {markDuplicateChannels,audienceKey} from '../dist/chat-list-model.js';
// The owner's list showed "Leadership" twice plus "EA Leadership": a pod channel with messages, an empty team mirror
// and an empty Google group mirror of the same audience (9 Oct 2026).
const pod={id:'f1',kind:'pod',name:'Leadership',lastAt:'2026-10-08T10:00:00Z'};
const team={id:'93',kind:'team',name:'Leadership',lastAt:null};
const group={id:'54',kind:'group',name:'EA Leadership',lastAt:null};
test('empty mirrors of one audience point at the conversation people use',()=>{
 const out=markDuplicateChannels([team,group,pod]);
 assert.deepEqual(out.map(c=>[c.id,c.duplicateOf]),[['93','f1'],['54','f1'],['f1',null]]);
});
test('a mirror with messages is never hidden',()=>{
 const busy={...group,lastAt:'2026-10-07T09:00:00Z'};
 const out=markDuplicateChannels([pod,busy,team]);
 assert.equal(out.find(c=>c.id==='54').duplicateOf,null);assert.equal(out.find(c=>c.id==='93').duplicateOf,'f1');
});
test('without messages the pod is preferred, then the team; direct and moderation channels are untouched',()=>{
 const quiet={...pod,lastAt:null};const dm={id:'d1',kind:'direct',name:'Leadership',lastAt:null};const mod={id:'m1',kind:'group',name:'Leadership',lastAt:null,moderationOnly:true};
 const out=markDuplicateChannels([group,team,quiet,dm,mod]);
 assert.deepEqual(out.map(c=>[c.id,c.duplicateOf]),[['54','f1'],['93','f1'],['f1',null],['d1',null],['m1',null]]);
});
test('audience names ignore case, spacing and the EA prefix only',()=>{
 assert.equal(audienceKey(' EA  Leadership '),'leadership');assert.notEqual(audienceKey('Social Media'),audienceKey('Social'));
 const out=markDuplicateChannels([{id:'a',kind:'team',name:'Social',lastAt:null},{id:'b',kind:'group',name:'Social Media',lastAt:null}]);
 assert.ok(out.every(c=>c.duplicateOf===null));
});
test('a group people made is never a mirror, even with the same name and no messages',()=>{
 const mine={id:'c1',kind:'custom',name:'Leadership',lastAt:null};
 const out=markDuplicateChannels([pod,mine,team]);
 assert.equal(out.find(c=>c.id==='c1').duplicateOf,null);assert.equal(out.find(c=>c.id==='93').duplicateOf,'f1');
});
