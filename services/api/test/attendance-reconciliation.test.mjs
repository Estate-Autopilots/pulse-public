import test from 'node:test';
import assert from 'node:assert/strict';
import {currentBaseline,closeSuggestion,attendanceDryRun,monthlyBaseline,suggestedClosePolicy} from '../dist/attendance-reconciliation.js';
const start='2026-10-01T17:00:00Z',end='2026-10-02T01:00:00Z',policy=suggestedClosePolicy('Asia/Kolkata');
test('overnight two-hour prompt boundary and 16-hour provisional cap never approve payroll',()=>{
 const z=Date.parse(end),a=Date.parse(start);
 assert.equal(closeSuggestion(start,end,z+120*60000-1,policy).state,'waiting');
 assert.equal(closeSuggestion(start,end,z+120*60000,policy).state,'done_for_day_prompt');
 assert.equal(closeSuggestion(start,end,a+960*60000-1,policy).state,'done_for_day_prompt');
 const capped=closeSuggestion(start,end,a+960*60000,policy);assert.equal(capped.state,'provisional_close_suggestion');assert.equal(capped.payrollApproved,false);assert.equal(Date.parse(capped.proposedEnd),Date.parse(end));
});
test('long-shift exceptions and clock skew require review',()=>{
 assert.equal(closeSuggestion(start,end,Date.parse(start)+20*3600000,policy,true).state,'long_shift_review');
 assert.equal(closeSuggestion(start,end,Date.parse(start)-1,policy).state,'needs_review');
 assert.equal(closeSuggestion(end,start,Date.parse(end),policy).state,'needs_review');
 assert.equal(closeSuggestion('bad',end,Date.parse(end),policy).state,'needs_review');
});
const row=(d,n=480,extra={})=>({id:d,personId:'self',date:d,in:d+'T00:00:00Z',out:new Date(Date.parse(d+'T00:00:00Z')+n*60000).toISOString(),missedOut:false,worked:n,breaks:[],comparable:'office:s1',...extra});
const rows=Array.from({length:10},(_,i)=>row(`2026-10-${String(i+1).padStart(2,'0')}`,420+i*10));
test('28-day comparable-day median, coverage and minimum-ten boundary retain originals',()=>{
 const copy=structuredClone(rows),b=currentBaseline(rows,'self','2026-10-28','office:s1',20,null,10,Date.parse('2026-10-29'));
 assert.equal(b.sampleDays,10);assert.equal(b.medianMinutes,465);assert.equal(b.coverage,.5);assert.equal(b.source,'accepted_comparable_shifts');assert.deepEqual(rows,copy);
 const low=currentBaseline(rows.slice(0,9),'self','2026-10-28','office:s1',20,540,10,Date.parse('2026-10-29'));assert.equal(low.medianMinutes,null);assert.equal(low.minutes,540);assert.equal(low.source,'confirmed_shift_policy');
 assert.equal(currentBaseline([], 'self','2026-10-28','office:s1',0,null).minutes,null);
});
test('mixed shifts, unknown history, unresolved corrections and duplicates never inflate baseline',()=>{
 const input=[...rows,row('2026-10-11',480,{comparable:'wfh:s1'}),row('2026-10-12',480,{pendingCorrection:true}),row('2026-10-13',480,{missedOut:true}),row('2026-10-14'),row('2026-10-14',480,{id:'duplicate'}),row('2026-09-30'),row('2026-10-15',480,{personId:'other'})];
 const b=currentBaseline(input,'self','2026-10-28','office:s1',24,null,10,Date.parse('2026-10-29'));assert.equal(b.sampleDays,10);assert.equal(b.recordedDays,13);
});
test('window boundary overlap is evaluated before restricting baseline dates',()=>{
 const input=[row('2026-09-30',480,{in:'2026-09-30T22:00:00Z',out:'2026-10-01T06:00:00Z'}),row('2026-10-01')];
 assert.equal(currentBaseline(input,'self','2026-10-28','office:s1',20,null,10,Date.parse('2026-10-29')).sampleDays,0);
});
test('dry-run worker only issues SELECT and never alters attendance or queues',async()=>{
 // R51: without a kept policy the suggestion reads the company's zone (a third SELECT).
 const queries=[];const c={query:async(sql)=>{queries.push(sql);assert.match(sql.trim(),/^select /);return {rows:sql.includes('org_time_zone')?[{z:'Asia/Kolkata'}]:[]};}};
 const result=await attendanceDryRun(c,'synthetic');assert.equal(result.automaticClosureEnabled,false);assert.equal(result.dryRun,true);assert.equal(queries.length,3);
});

test('monthly baselines retain units, exclude unknown and conflicting duplicates, and never infer hours',()=>{
 const rows=[{month:'2026-08',leaveDays:2,wfhDays:null,halfDays:0},{month:'2026-09',leaveDays:4,wfhDays:1,halfDays:null},{month:'2026-07',leaveDays:3,wfhDays:2,halfDays:0},{month:'2026-07',leaveDays:6,wfhDays:2,halfDays:0}];
 const copy=structuredClone(rows),b=monthlyBaseline(rows);assert.equal(b.counts.leaveDays.median,3);assert.equal(b.counts.leaveDays.sampleMonths,2);assert.equal(b.counts.wfhDays.median,1.5);assert.equal(b.hoursBaseline,null);assert.equal(b.identityAndEligibilityApproved,false);assert.deepEqual(rows,copy);
});
