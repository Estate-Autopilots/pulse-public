import test from 'node:test';import assert from 'node:assert/strict';import {deviceStatus,parseScreenshot,SCREENSHOT_LIMIT} from '../dist/pulse-app-model.js';
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(16)]);
test('screenshots: PNG, JPEG and WebP data URLs only, with matching bytes and a size limit',()=>{
 assert.equal(parseScreenshot(null),null);assert.equal(parseScreenshot(''),null);
 const shot=parseScreenshot(`data:image/png;base64,${png.toString('base64')}`);assert.equal(shot.type,'image/png');assert.equal(shot.bytes.length,png.length);
 assert.throws(()=>parseScreenshot(`data:image/jpeg;base64,${png.toString('base64')}`),/not the image/);
 assert.throws(()=>parseScreenshot('data:text/html;base64,PGgxPg=='),/PNG, JPEG or WebP/);
 assert.throws(()=>parseScreenshot('https://example.invalid/x.png'),/PNG, JPEG or WebP/);
 const big=Buffer.concat([png,Buffer.alloc(SCREENSHOT_LIMIT)]);assert.throws(()=>parseScreenshot(`data:image/png;base64,${big.toString('base64')}`),/under 4 MB/);
});
const now=Date.parse('2026-10-09T10:00:00Z');
const base={platform:'macos',last_seen:'2026-10-09T09:50:00Z',created_at:'2026-10-01T00:00:00Z',health:'healthy',capabilities:{},last_attendance:'2026-10-09T04:00:00Z',purposes:[],paused:true,notice_published:true,last_event:null,presence_consent:false,app_version:'1.0.0'};
test('device health answers "is this Mac connected and tracked?" in plain words',()=>{
 const s=deviceStatus(base,now);assert.equal(s.connected,'connected');assert.equal(s.attendance,'working');assert.deepEqual(s.activity,{state:'off',why:'Not opted in'});
 assert.deepEqual(deviceStatus({...base,notice_published:false},now).activity,{state:'off',why:'Notice not published'});
 assert.deepEqual(deviceStatus({...base,purposes:['activity_context'],capabilities:{focus:'denied'}},now).activity,{state:'off',why:'OS permission missing'});
 assert.equal(deviceStatus({...base,purposes:['activity_context']},now).activity.state,'paused');
 assert.deepEqual(deviceStatus({...base,purposes:['activity_context'],paused:false,last_event:'2026-10-09T09:00:00Z'},now).activity,{state:'on',why:'Collecting'});
 assert.equal(deviceStatus({...base,last_seen:null,last_attendance:null},now).connected,'not-seen');
 assert.equal(deviceStatus({...base,last_seen:null,last_attendance:null},now).attendance,'none-yet');
 assert.equal(deviceStatus({...base,platform:'android'},now).activity.state,'not-applicable');
 assert.equal(deviceStatus({...base,capabilities:{push:'denied'}},now).pings,'blocked');
});
