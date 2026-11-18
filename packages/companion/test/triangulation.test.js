import test from 'node:test';
import assert from 'node:assert/strict';
import { triangulate, dwellDecision, demoPayload, surfaceState } from '../src/index.js';
const at=Date.parse('2026-10-08T05:00:00Z');
const signals={region:{inside:true,at},wifi:{strength:'strong',at},ip:{matched:true,at}};
const decide=(extra={})=>dwellDecision({signals,at,dwellMinutes:3,leaveMinutes:15,consent:true,autoConsent:true,hrAuto:true,workingDay:true,state:'out',...extra});
test('arrival requires multiple evidence and a full server dwell',()=>{
 assert.equal(triangulate({region:signals.region},at).confident,false);
 assert.equal(triangulate({wifi:{strength:'weak',at},ip:signals.ip},at).confident,false);
 const first=decide();assert.equal(first.kind,'dwelling');
 assert.equal(decide({previous:first,at:at+179999}).kind,'dwelling');
 assert.equal(decide({previous:first,at:at+180000}).kind,'auto-check-in');
});
test('Wi-Fi switching off retains dwell when region and public IP hold',()=>{
 const first=decide(); const next=decide({previous:first,at:at+180000,signals:{region:signals.region,wifi:{strength:null,at:at+180000},ip:{matched:true,at:at+180000}}});
 assert.equal(next.score,80);assert.equal(next.kind,'auto-check-in');assert.equal(next.since,at);
});
test('each opt-in and working day is required; no automatic return after checkout',()=>{
 for(const extra of [{consent:false},{autoConsent:false},{hrAuto:false},{workingDay:false},{state:'done'}])assert.notEqual(decide({previous:{since:at-180000},...extra}).kind,'auto-check-in');
});
test('stale or conflicting evidence resets dwell; a held geofence does not imply a departure',()=>{
 assert.equal(decide({previous:{since:at-180000},signals:{wifi:{strength:'strong',at:at-11*60000}}}).since,null);
 assert.equal(decide({state:'in',signals:{region:signals.region},previous:{lastPresence:at-60000}}).leftAt,null);
});
test('departure reminds first then proposes last-presence checkout for confirmation',()=>{
 const left=decide({signals:{},state:'in',previous:{lastPresence:at-60000}});
 assert.equal(left.kind,'leave-reminder');assert.equal(left.lastPresence,at-60000);
 const next=decide({signals:{},state:'in',at:at+15*60000,previous:left});assert.equal(next.kind,'checkout-needs-confirmation');assert.equal(next.lastPresence,at-60000);
});
test('widget, ribbon and activity mapping respects breaks, checkout, signout and offline state',()=>{
 for(const state of ['out','in','break','done','leave','off']){
  const p=demoPayload(state,at+5*3600000);const s=surfaceState(p,at+5*3600000);
  assert.equal(s.active,['in','break'].includes(state));assert.equal(s.actions.length,['in','break'].includes(state)?2:['out','done'].includes(state)?1:0);
  assert.equal(s.timerSince!==null,s.active);
 }
 assert.equal(surfaceState(null).active,false);
 const p=demoPayload('in',at);p.pending=true;assert.equal(surfaceState(p,at).pending,true);
});
