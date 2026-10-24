import test from 'node:test';
import assert from 'node:assert/strict';
import {activeRule,automaticHalfDay,noticeFlag,professionalTax,proposals,proposalsFor,specialRoute,validateConfig} from '../dist/hr-rules.js';
const version=(key,effectiveFrom='2026-10-09',version=1)=>({key,config:structuredClone(proposals[key]),effectiveFrom,version,confirmedAt:'2026-10-09T00:00:00Z'});
test('every proposal remains off until a dated confirmation exists',()=>{
 for(const key of Object.keys(proposals)) {
  assert.equal(activeRule([],key,'2026-10-09'),undefined);
  assert.equal(activeRule([version(key,'2026-11-01')],key,'2026-10-31'),undefined);
  assert.equal(activeRule([version(key,'2026-11-01')],key,'2026-11-01')?.version,1);
  const zoned=proposalsFor('Asia/Kolkata');
  assert.deepEqual(validateConfig(key,structuredClone(zoned[key]),'Asia/Kolkata'),zoned[key]);
 }
});
test('R51: the half-day cutoff is on the company\'s own clock (EA keeps India time)',()=>{
 assert.equal(proposalsFor('Asia/Kolkata').half_day.timezone,'Asia/Kolkata');
 assert.equal(proposalsFor('Europe/London').half_day.timezone,'Europe/London');
 assert.deepEqual(validateConfig('half_day',proposalsFor('Europe/London').half_day,'Europe/London'),proposalsFor('Europe/London').half_day);
 assert.throws(()=>validateConfig('half_day',proposalsFor('Asia/Kolkata').half_day,'Europe/London'),/company's clock/);
 assert.throws(()=>validateConfig('half_day',proposalsFor('Europe/London').half_day,'Asia/Kolkata'),/company's clock/);
});
test('half-day strict thresholds, approved remote exemption and complete-record gate',()=>{
 const r=version('half_day'),d={netMinutes:270,arrival:'13:00',complete:true,working:true,approvedRemote:false};
 assert.equal(automaticHalfDay(undefined,{...d,netMinutes:1}),false);
 assert.equal(automaticHalfDay(r,d),false);
 assert.equal(automaticHalfDay(r,{...d,netMinutes:269}),true);
 assert.equal(automaticHalfDay(r,{...d,arrival:'13:01'}),true);
 for(const patch of [{complete:false},{working:false},{approvedRemote:true}])assert.equal(automaticHalfDay(r,{...d,netMinutes:1,...patch}),false);
});
test('short leave counts working notice; long leave counts calendar notice, never blocks',()=>{
 const r=version('advance_notice');assert.equal(noticeFlag(undefined,2,0,0),null);
 assert.equal(noticeFlag(r,2,2,10).late,true);assert.equal(noticeFlag(r,2,3,3).late,false);
 assert.equal(noticeFlag(r,3,100,13).late,true);assert.equal(noticeFlag(r,3,0,14).late,false);
});
test('special routes respect thresholds and overlapping probation and notice dates',()=>{
 const r=version('special_routing'),d={paid:false,days:5,consecutive:5,from:'2026-10-15',to:'2026-10-21',probationFrom:null,probationTo:null,noticeFrom:null,noticeTo:null};
 assert.equal(specialRoute(undefined,{...d,days:6}),null);assert.equal(specialRoute(r,d),null);
 assert.equal(specialRoute(r,{...d,days:6}).stage,'cofounder');
 assert.equal(specialRoute(r,{...d,paid:true,noticeFrom:'2026-10-21',noticeTo:'2026-11-20'}).reason,'leave during notice period');
 assert.equal(specialRoute(r,{...d,paid:true,probationFrom:'2026-09-01',probationTo:'2026-11-30',consecutive:2}),null);
 assert.equal(specialRoute(r,{...d,paid:true,probationFrom:'2026-09-01',probationTo:'2026-11-30',consecutive:3}).stage,'hr');
});
test('PT inclusive slabs, women threshold, February, OFF, exemptions and unknown inputs',()=>{
 const r=version('professional_tax');
 for(const [category,gross,january,february] of [['men',7500,0,0],['men',7500.01,175,175],['men',10000,175,175],['men',10000.01,200,300],['women',25000,0,0],['women',25000.01,200,300]]) {
  assert.deepEqual(professionalTax(r,gross,category,'MH',false,'2026-01'),{amount:january,review:false});
  assert.equal(professionalTax(r,gross,category,'MH',false,'2026-02').amount,february);
 }
 assert.equal(professionalTax(undefined,50000,'men','MH',false,'2026-02').amount,0);
 assert.equal(professionalTax(r,50000,'women','MH',true,'2026-02').amount,0);
 assert.equal(professionalTax(r,50000,'men','other',false,'2026-02').amount,0);
 assert.equal(professionalTax(r,50000,null,'MH',false,'2026-02').review,true);
 assert.equal(professionalTax(r,50000,'men',null,false,'2026-02').review,true);
 assert.equal(activeRule([version('professional_tax'),version('professional_tax','2026-11-01',2)],'professional_tax','2026-10-31').version,1);
});
test('invalid configuration cannot be confirmed',()=>{
 for(const [key,patch] of [['late_marks',{threshold:0}],['late_marks',{window:'rolling'}],['late_marks',{deduction:.1}],['half_day',{arrivalCutoff:'25:00'}],['half_day',{timezone:'UTC'}],['leave_balance',{yearStart:13}],['leave_balance',{monthlyDays:1.2}],['emergency',{recordWorkingDays:0}]])assert.throws(()=>validateConfig(key,{...proposals[key],...patch}));
 const tax=structuredClone(proposals.professional_tax);tax.slabs[1].upTo=7000;assert.throws(()=>validateConfig('professional_tax',tax));
});
