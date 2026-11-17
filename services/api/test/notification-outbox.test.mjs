import test from 'node:test';
import assert from 'node:assert/strict';
import {drainNotificationChannel,providerOutcome} from '../dist/notification-outbox.js';
import {notificationTarget} from '../dist/notification-events.js';
import {pingSettings,pingAllowed} from '../dist/notification-policy.js';

test('provider responses distinguish retryable rejection, dead endpoint and ambiguous acceptance',()=>{
 for(const [code,outcome] of [[200,'accepted'],[202,'accepted'],[429,'retry'],[503,'retry'],[410,'expired'],[404,'expired'],[400,'failed'],[401,'failed'],[0,'uncertain'],[500,'uncertain']])assert.equal(providerOutcome(code),outcome);
});
test('approved overnight shift is opt-in and cannot override DND, channel or type preferences',()=>{
 const at=new Date('2026-10-09T01:00:00Z');
 const settings=pingSettings({quiet:true,timezone:'UTC',nightShift:true},'UTC');
 assert.equal(pingAllowed('attendance',settings,at,{approvedShift:false}),false);
 assert.equal(pingAllowed('attendance',settings,at,{approvedShift:true}),true);
 assert.equal(pingAllowed('attendance',pingSettings({...settings,nightShift:false},'UTC'),at,{approvedShift:true}),false);
 for(const patch of [{dnd:true},{channels:{native:false}},{types:{attendance:false}}])assert.equal(pingAllowed('attendance',pingSettings({...settings,...patch},'UTC'),at,{channel:'native',approvedShift:true}),false);
 const until=new Date(Date.now()+3600000).toISOString();
 assert.equal(pingAllowed('chat',pingSettings({snoozedUntil:until},'UTC'),new Date()),false);
 assert.throws(()=>pingSettings({snoozedUntil:new Date(Date.now()+172800000).toISOString()},'UTC'));
 assert.equal(notificationTarget('attendance.departure'),'MyDesk');
 // POLISH-2 (QA-E2E P2-3): every attendance notice a phone shows opens My desk through the native contract.
 for(const type of ['attendance.arrival','attendance.break','attendance.nudge','attendance.checkout'])assert.equal(notificationTarget(type),'MyDesk',type);
 assert.equal(notificationTarget('payroll.processed'),'Payroll');
 assert.equal(notificationTarget('unrecognized'),null);
});
test('provider runs with durable dispatch intent and no held database connection, and replay cannot resend',async()=>{
 let state='queued',checkedOut=0,sends=0;const queries=[];
 const pool={
  async query(){return {rows:[{org_id:'synthetic'}]};},
  async connect(){checkedOut++;return {
   async query(sql,args){queries.push(sql);
    if(sql.includes('notification_outbox_claim')){if(state!=='queued')return {rows:[]};state='leased';return {rows:[{id:'job',lease_token:'claim'}]};}
    if(sql.includes('notification_outbox_dispatch')){state='dispatching';return {rows:[{payload:{id:'event',personId:'person',expiresAt:new Date(Date.now()+3600000).toISOString(),destination:{}}}]};}
    if(sql.includes('notification_outbox_finish'))state=args[2];
    return {rows:[]};
   },release(){checkedOut--;}
  };}
 };
 const send=async()=>{assert.equal(checkedOut,0);assert.equal(state,'dispatching');assert.equal(queries.at(-1),'commit');sends++;return 'accepted';};
 assert.equal((await drainNotificationChannel(pool,'web',send)).sent,1);
 assert.equal((await drainNotificationChannel(pool,'web',send)).sent,0);
 assert.equal(sends,1);assert.equal(checkedOut,0);
});
test('transport timeout records uncertainty instead of scheduling a duplicate',async()=>{
 let finished;const pool={async query(){return {rows:[{org_id:'synthetic'}]};},async connect(){return {async query(sql,args){
  if(sql.includes('notification_outbox_claim'))return {rows:[{id:'job',lease_token:'claim'}]};
  if(sql.includes('notification_outbox_dispatch'))return {rows:[{payload:{id:'event',destination:{}}}]};
  if(sql.includes('notification_outbox_finish'))finished=args[2];return {rows:[]};
 },release(){}};}};
 assert.equal((await drainNotificationChannel(pool,'native',async()=>{throw Error('timeout');})).uncertain,1);
 assert.equal(finished,'uncertain');
});
