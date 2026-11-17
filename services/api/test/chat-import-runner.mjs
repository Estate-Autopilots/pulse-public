// R47 over HTTP: the preview's reader in the test (as in the browser), then the API's approved import, repeat and
// overlap, member-only reads, refusals and withdrawal. Synthetic export, people and conversations only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { decodeExport, parseWhatsAppExport, participantKey, sha256Hex } from '@pulse/chat-export';
import { createApp } from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),app=createApp(pool,pool);
const call=async(url,payload,token)=>{const r=await app.inject({url,method:payload?'POST':'GET',headers:token?{'x-pulse-session':token}:{},...(payload?{payload}:{})});return {status:r.statusCode,data:r.headers['content-type']?.includes('json')?r.json():r.body};};
const login=async username=>{const r=await call('/api/v0/auth/sign-in',{username,password:'Synthetic-issued-2026!'});assert.equal(r.status,200);const token=r.data.token;assert.equal((await call('/api/v0/auth/change-password',{current:'Synthetic-issued-2026!',next:'Synthetic-new-2026!'},token)).status,200);return token;};
const a=await login('editor.one'),b=await login('editor.two'),outsider=await login('project.lead'),admin=await login('pod.manager');
const group=(await call('/api/v0/chats/groups',{name:'Synthetic shoot crew',memberIds:[process.env.TEST_PERSON]},admin)).data.id;assert.ok(group);
const bytes=await readFile(new URL('../../../packages/chat-export/test/fixtures/android-24h-dmy.txt',import.meta.url));
// What the browser sends after its preview: the file, its fingerprint, the settings shown and each sender's decision.
async function prepare(raw,decide){
 const preview=parseWhatsAppExport(decodeExport(new Uint8Array(raw)),{timeZone:'Asia/Kolkata'});
 const participants=await Promise.all(preview.participants.map(async p=>({key:await participantKey(p.label),...decide(p)})));
 return {channelId:group,file:Buffer.from(raw).toString('base64'),fileSha256:await sha256Hex(new Uint8Array(raw)),timeZone:'Asia/Kolkata',dateOrder:preview.dateOrder,expectMessages:preview.stats.messages,participants,approvalRef:'E15 synthetic approval record',retentionNote:'Proposal: keep while the group exists; legal review pending'};
}
const decide=p=>p.label==='Mira Test'?{personId:process.env.TEST_PERSON}:p.phone?{skip:true}:{personId:null};
const body=await prepare(bytes,decide);
// Off by default: the page answers (the preview runs in the browser), the import is refused; only admins reach either.
let page=await call('/api/v0/chats/imports',null,admin);assert.equal(page.status,200);assert.equal(page.data.enabled,false);assert.equal(page.data.timeZone,'Asia/Kolkata');
assert.deepEqual(page.data.targets.map(t=>[t.id,t.kind,t.readers.length]),[[group,'custom',2]]);
assert.equal((await call('/api/v0/chats/imports',null,a)).status,403);
assert.equal((await call('/api/v0/chats/imports',body,admin)).status,404);
assert.equal((await call('/api/v0/chats/imports',body,a)).status,403);
process.env.PULSE_CHAT_IMPORT='1';
// Every sender needs a decision; the file must be the one previewed and read the same way.
const undecided=await call('/api/v0/chats/imports',{...body,participants:body.participants.slice(1)},admin);assert.equal(undecided.status,400);assert.match(undecided.data.error,/^Decide who/);
assert.equal((await call('/api/v0/chats/imports',{...body,fileSha256:'0'.repeat(64)},admin)).status,409);
assert.equal((await call('/api/v0/chats/imports',{...body,expectMessages:1},admin)).status,409);
assert.equal((await call('/api/v0/chats/imports',{...body,approvalRef:''},admin)).status,400);
const pod=(await call('/api/v0/chats',null,admin)).data.channels.find(c=>c.kind==='pod').id;
const podImport=await call('/api/v0/chats/imports',{...body,channelId:pod},admin);assert.equal(podImport.status,403);assert.match(podImport.data.error,/never a pod/);
// Mira (mapped) 1 text, Kabir (kept as written) 2 media + 3 text, the phone number skipped: 6 messages.
const first=await call('/api/v0/chats/imports',body,admin);assert.equal(first.status,200,JSON.stringify(first.data));assert.deepEqual([first.data.added,first.data.duplicates],[6,0]);
const again=await call('/api/v0/chats/imports',body,admin);assert.equal(again.status,409);assert.match(again.data.error,/already imported/);
const longer=Buffer.concat([bytes,Buffer.from('14/10/2026, 08:00 - Mira Test: Next synthetic day\n')]);
const overlap=await call('/api/v0/chats/imports',await prepare(longer,decide),admin);assert.equal(overlap.status,200);assert.deepEqual([overlap.data.added,overlap.data.duplicates],[1,6]);
// Members read it, in order, with names: a colleague by their Pulse name, anyone else as the export wrote them.
const history=(await call(`/api/v0/chats/${group}/history`,null,a)).data;
assert.deepEqual(history.messages.map(m=>[m.name,m.kind,m.body]),[
 ['Editor One','text','Morning, call sheet for the synthetic shoot:\n1. Reach by 10\n2. Bring the test camera'],['Kabir Sample','media',''],['Kabir Sample','text','Uploaded the synthetic cut'],
 ['Kabir Sample','text','ok'],['Kabir Sample','text','ok'],['Kabir Sample','media','Caption for the synthetic still'],['Editor One','text','Next synthetic day']]);
assert.equal(history.messages[0].local,'2026-10-12T09:02:00');assert.equal(history.messages[0].at,'2026-10-12T03:32:00.000Z');assert.equal(history.messages[2].edited,true);
// The skipped sender's number and words, not the bare digits '7700', which a random id or hash can contain.
{const seen=JSON.stringify(history);assert.equal(/7700\D{0,3}900\D{0,3}123/.test(seen)||seen.includes('Joining from the client side'),false,'a skipped phone number is nowhere');}
assert.equal(history.batches.length,2);
assert.equal((await call('/api/v0/chats',null,a)).data.channels.find(c=>c.id===group).imported,7);
assert.equal((await call('/api/v0/chats',null,a)).data.channels.find(c=>c.id===group).unread,0,'imported text is never unread');
// Nobody else reads it: not a colleague outside the group, not leadership or HR by role, not another admin.
for(const t of [b,outsider])assert.equal((await call(`/api/v0/chats/${group}/history`,null,t)).status,404);
assert.equal((await call(`/api/v0/chats/search?q=synthetic%20cut`,null,a)).data.messages.length,0,'chat search does not reach imported text');
page=(await call('/api/v0/chats/imports',null,admin)).data;assert.equal(page.batches.length,2);assert.equal(JSON.stringify(page).includes('call sheet'),false,'the import list holds provenance, never text');
// Withdrawing hides a batch from every read; nothing is deleted.
assert.equal((await call(`/api/v0/chats/imports/${overlap.data.id}/withdraw`,{note:'Synthetic: second export not approved'},a)).status,403);
assert.equal((await call(`/api/v0/chats/imports/${overlap.data.id}/withdraw`,{note:'Synthetic: second export not approved'},admin)).status,200);
assert.equal((await call(`/api/v0/chats/${group}/history`,null,a)).data.messages.length,6);
const cursor=await call(`/api/v0/chats/${group}/history?before=nonsense`,null,a);assert.equal(cursor.status,400);
await app.close();await pool.end();
