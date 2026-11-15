import test from 'node:test';
import assert from 'node:assert/strict';
import {pingAllowed,pingSettings,pushEndpoint} from '../dist/notification-policy.js';
test('quiet hours cross midnight in the person timezone with exact boundaries',()=>{
 const settings=pingSettings({quiet:true,timezone:'Asia/Kolkata'},'UTC');
 for(const [at,allowed] of [['2026-10-08T15:29:59Z',true],['2026-10-08T15:30:00Z',false],['2026-10-09T02:29:59Z',false],['2026-10-09T02:30:00Z',true]])assert.equal(pingAllowed('chat',settings,new Date(at)),allowed,at);
 assert.equal(pingAllowed('chat',pingSettings({...settings,start:'12:00',end:'13:00'},'UTC'),new Date('2026-10-09T07:00:00Z')),false);
});
test('new users receive night-time messages until they enable quiet hours',()=>{assert.equal(pingAllowed('chat',pingSettings({},'UTC'),new Date('2026-10-08T20:40:00Z')),true);});
test('DND and each disabled type suppress pings without changing unread data',()=>{
 assert.equal(pingAllowed('chat',pingSettings({quiet:false,dnd:true},'UTC')),false);
 const settings=pingSettings({quiet:false,types:{chat:false}},'UTC');
 assert.equal(pingAllowed('chat',settings),false);assert.equal(pingAllowed('mention',settings),true);
 assert.throws(()=>pingSettings({timezone:'Secret/Invalid'},'UTC'));assert.throws(()=>pingSettings({start:'25:00'},'UTC'));
 // R51: without a zone of their own, a person's quiet hours follow the company's.
 assert.equal(pingSettings({},'Europe/London').timezone,'Europe/London');assert.equal(pingSettings({},'Asia/Kolkata').timezone,'Asia/Kolkata');
});
test('push endpoints cannot target internal services or credentialed/redirect URLs',()=>{
 for(const endpoint of ['http://fcm.googleapis.com/a','https://127.0.0.1/a','https://fcm.googleapis.com.evil.example/a','https://user@fcm.googleapis.com/a','https://fcm.googleapis.com:444/a'])assert.throws(()=>pushEndpoint(endpoint));
 assert.equal(pushEndpoint('https://fcm.googleapis.com/fcm/send/synthetic'),'https://fcm.googleapis.com/fcm/send/synthetic');
});
