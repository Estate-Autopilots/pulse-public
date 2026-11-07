import test from 'node:test';import assert from 'node:assert/strict';import {briefSlot} from '../dist/brief-model.js';
const s={subscribed:true,timezone:'Asia/Kolkata',dailyTime:null,weeklyDay:1,quietStart:'10:00',quietEnd:'16:00',shift:{start:'22:00',end:'06:00',workDays:[1,2,3,4,5]},holidays:[],leaveDates:[]};
test('overnight work belongs to its start date and shift timezone',()=>{const x=briefSlot(new Date('2026-10-06T00:00:00Z'),s);assert.equal(x.workDate,'2026-10-05');assert.equal(x.ready,true);assert.equal(x.overnight,true);});
test('leave, holidays, quiet hours, subscription and schedule are respected without streak penalties',()=>{
 assert.equal(briefSlot(new Date('2026-10-06T00:00:00Z'),{...s,leaveDates:[{from:'2026-10-05',to:'2026-10-05'}]}).reason,'Approved leave day');
 assert.equal(briefSlot(new Date('2026-10-06T00:00:00Z'),{...s,holidays:['2026-10-05']}).ready,false);
 assert.equal(briefSlot(new Date('2026-10-05T18:00:00Z'),{...s,quietStart:'22:00',quietEnd:'07:00'}).ready,false);
 assert.equal(briefSlot(new Date('2026-10-06T00:00:00Z'),{...s,subscribed:false}).ready,false);
 assert.equal(briefSlot(new Date('2026-10-05T12:00:00Z'),s).reason,'Scheduled time not reached');
});
