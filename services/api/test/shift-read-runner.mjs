// POLISH-1: a person who is neither admin nor HR reads their own shift, and their daily brief follows it.
import assert from 'node:assert/strict';import {Pool} from 'pg';import {writeFile} from 'node:fs/promises';
import {createApp} from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),app=createApp(pool,pool),shift=JSON.parse(process.env.TEST_SHIFT);let checks=0;
const equal=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
async function call(who,url,payload){const r=await app.inject({url,method:payload?'POST':'GET',headers:{'cf-access-authenticated-user-email':who},...(payload?{payload}:{})});return {status:r.statusCode,data:r.json()};}
const staff=process.env.TEST_STAFF_EMAIL;
const briefs=await call(staff,'/api/v0/briefs');equal(briefs.status,200,'a plain staff member reads their briefs');
equal(briefs.data.settings.shift,{start:shift.start,end:shift.end,workDays:shift.days},'the brief schedule follows their own shift');
equal((await call(staff,'/api/v0/shifts')).status,403,'the shift admin view stays with HR');
await writeFile(process.env.TEST_REPORT,JSON.stringify({checks}));await app.close();await pool.end();
