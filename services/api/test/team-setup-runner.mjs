// ONBOARD: the public team setup routes (no sign-in, limited per address) and HR's Team setup routes (admins and HR).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const call = async (method, url, token, payload, ip = randomBytes(6).toString('hex')) => { const r = await app.inject({ method, url, headers: { 'x-pulse-client-ip': ip, ...(token ? { 'x-pulse-session': token } : {}) }, ...(payload === undefined ? {} : { payload }) }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
const signIn = async username => (await call('POST', '/api/v0/auth/sign-in', null, { username, password: 'Synthetic-account-2026!' })).body.token;
try {
 const admin = await signIn('auth.admin'), person = await signIn('auth.person');
 assert.ok(admin && person);
 assert.equal((await call('GET', '/api/v0/hr/team-setup', person)).status, 403);
 assert.equal((await call('POST', '/api/v0/hr/team-setup', person, { action: 'rotate' })).status, 403);
 assert.equal((await call('GET', '/api/v0/hr/team-setup', null)).status, 401);
 const empty = await call('GET', '/api/v0/hr/team-setup', admin);
 assert.equal(empty.status, 200); assert.equal(empty.body.setup, null);
 assert.equal((await call('POST', '/api/v0/hr/team-setup', admin, {})).status, 400);
 assert.equal((await call('POST', '/api/v0/hr/team-setup', admin, { action: 'decide', decision: 'dismiss', id: '00000000-0000-4000-8000-000000000001' })).status, 404);
 const code = (await call('POST', '/api/v0/hr/team-setup', admin, { action: 'rotate' })).body.setup.code;
 assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
 // Public: the code is checked first; a wrong one says so in plain words, and nothing about anyone.
 const wrong = await call('POST', '/api/v0/auth/team-setup-check', null, { code: 'ZZZZ-ZZZZ', name: 'Tara Kapoor' });
 assert.equal(wrong.status, 400); assert.match(wrong.body.error, /team code/);
 assert.deepEqual((await call('POST', '/api/v0/auth/team-setup-check', null, { code, name: 'Tara Kapoor' })).body, { domain: 'example.test', suggestion: null });
 assert.equal((await call('POST', '/api/v0/auth/team-setup', null, { code, name: 'Tara Kapoor' })).status, 400, 'the answer is required');
 const bad = await call('POST', '/api/v0/auth/team-setup', null, { code, name: 'Tara Kapoor', hasGoogle: true, email: 'tara@other.test' });
 assert.equal(bad.status, 400); assert.match(bad.body.error, /@example\.test/);
 assert.deepEqual((await call('POST', '/api/v0/auth/team-setup', null, { code, name: 'Tara Kapoor', hasGoogle: true, email: 'tara.kapoor@example.test' })).body, { ok: true });
 // Ten sends from one address in 15 minutes, then a pause.
 const ip = randomBytes(6).toString('hex'); let last = 0;
 for (let i = 0; i < 11; i++) last = (await call('POST', '/api/v0/auth/team-setup', null, { code, name: 'Tara Kapoor', hasGoogle: true, email: 'tara.kapoor@example.test' }, ip)).status;
 assert.equal(last, 429);
 const state = (await call('GET', '/api/v0/hr/team-setup', admin)).body;
 assert.equal(state.requests.length, 1); assert.equal(state.requests[0].email, 'tara.kapoor@example.test');
 const done = await call('POST', '/api/v0/hr/team-setup', admin, { action: 'decide', decision: 'use-email', id: state.requests[0].id, personId: process.env.PULSE_PERSON_ID, email: 'tara.kapoor@example.test' });
 assert.equal(done.status, 200); assert.equal(done.body.requests[0].status, 'done');
 console.log('team setup runner: ok');
} finally { await app.close(); await pool.end(); }
