// TEAM-TELEMETRY (21 Nov 2026): the Chats list's "peerFormer" (a direct chat whose other person has left) after the
// list's faster rule. Prints the direct chat's row with TEST_OTHER as JSON; tests/core/test_chats.py checks it.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),app=createApp(pool,pool);
const call=async(url,payload,token)=>{const r=await app.inject({url,method:payload?'POST':'GET',headers:token?{'x-pulse-session':token}:{},...(payload?{payload}:{})});return {status:r.statusCode,data:r.headers['content-type']?.includes('json')?r.json():r.body};};
let r=await call('/api/v0/auth/sign-in',{username:'editor.one',password:'Synthetic-new-2026!'});
if(r.status!==200){r=await call('/api/v0/auth/sign-in',{username:'editor.one',password:'Synthetic-issued-2026!'});assert.equal(r.status,200);assert.equal((await call('/api/v0/auth/change-password',{current:'Synthetic-issued-2026!',next:'Synthetic-new-2026!'},r.data.token)).status,200);}
const list=await call('/api/v0/chats',null,r.data.token);assert.equal(list.status,200);
const row=list.data.channels.find(c=>c.kind==='direct'&&c.peerId===process.env.TEST_OTHER);assert.ok(row,'the direct chat is listed');
console.log(JSON.stringify({peerFormer:row.peerFormer,name:row.name}));
await pool.end();
