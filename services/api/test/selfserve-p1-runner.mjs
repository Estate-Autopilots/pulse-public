// SELFSERVE-P1 (real-phone QA, 5 Nov 2026) against the built API at the shared address (tests/core/test_selfserve_p1.py),
// mail in the sink: a company started at sign-up on the shared Pulse. (3) Its founder opens Finance and Billing and
// lands on the first-run setup. (1) HR's "Copy link" set-password link of a person in it works, signed out, at the
// shared address, once; the person is in their company and signs in there later. (2) Someone HR added who joins with
// the company's invitation link and a verified account e-mail is the same person (no twin); someone who joins with an
// unverified e-mail stays a second record, but the pickers show the person who signs in, not the HR record.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';

const { createApp } = await import('../dist/app.js');
const { testMail } = await import('../dist/auth-mail.js');
const home = process.env.PULSE_ORG_ID;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const PASSWORD = 'Correct-horse-battery-9';
const call = async (who, url, payload) => {
  const headers = { 'x-pulse-client-ip': crypto.randomUUID(), 'user-agent': 'selfserve-p1-runner Chrome on Android' };
  if (who?.token) headers['x-pulse-session'] = who.token;
  const r = await app.inject({ url, method: payload ? 'POST' : 'GET', headers, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const must = async (who, url, payload) => { const r = await call(who, url, payload); assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.data).slice(0, 600)}`); checks++; return r.data; };
const refused = async (who, url, payload, status) => { const r = await call(who, url, payload); eq(r.status, status, `${url} should answer ${status}: ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
const signupCode = (to) => testMail.filter((m) => m.to === to && m.title === 'Your Pulse sign-up code').at(-1)?.body.match(/Pulse sign-up code is (\d{6})/)?.[1];
/** A personal Pulse account by e-mailed code (the shared sign-up page); orgName starts a company with it. */
const signUp = async (name, email, orgName = '') => {
  await must(null, '/api/v0/auth/signup-code', { name, email, orgName });
  const code = signupCode(email); ok(code, `a sign-up code for ${email}`);
  return must(null, '/api/v0/auth/signup-confirm', { name, email, orgName, handle: '', code });
};

try {
  // ------------------------------------------------------------------------------- 3. the founder runs the company
  const FOUNDER = 'owner@sahyadri-foods.example';
  let s = await signUp('Sahyadri Owner', FOUNDER, 'Sahyadri Foods');
  const company = s.org; const founder = { token: s.token };
  ok(company && company !== home, 'a company of its own, not the install company');
  eq([s.personal, s.home], [false, '/welcome'], 'a company just started opens on its first-run setup');
  let me = await must(founder, '/api/v0/me');
  eq([me.org, me.role, me.orgName], [company, 'admin', 'Sahyadri Foods']);
  const founderId = me.person;
  await must(founder, '/api/v0/finance/entries');   // was 403 "Finance entries are for leadership and the Finance role"
  await must(founder, '/api/v0/finance/entries/options');
  await must(founder, '/api/v0/erp');               // /billing was "Billing is unavailable"
  const acct = await must(founder, '/api/v0/account');
  eq(acct.orgs.filter((o) => o.current).map((o) => [o.id, o.install]), [[company, false]], 'not the platform organisation (no Licences)');
  eq((await must(founder, '/api/v0/brand')).name, 'Sahyadri Foods', 'its own brand and code at the shared address');
  await refused(null, '/api/v0/finance/entries', undefined, 401);

  // ------------------------------------------------------------------------------- 1. Copy link, at the shared address
  const porom = await must(founder, '/api/v0/people', { name: 'Porom Kale', role: 'Sales executive', email: 'porom.kale@gmail.example' });
  const copied = await must(founder, `/api/v0/people/${porom.id}/login`, { action: 'copy', confirmed: true });
  ok(/\/login\/set-password#[A-Za-z0-9_-]{43}$/.test(copied.link), `a set-password link: ${copied.link}`);
  const link = new URL(copied.link).hash.slice(1);
  s = await must(null, '/api/v0/auth/set-password', { token: link, password: PASSWORD });   // signed out, shared address
  eq(s.org, company, 'redeemed inside its own company');
  const poromSession = { token: s.token };
  me = await must(poromSession, '/api/v0/me');
  eq([me.org, me.person, me.name, me.orgName], [company, porom.id, 'Porom Kale', 'Sahyadri Foods'], 'the session opens her company at the shared address');
  ok(!JSON.stringify(await must(poromSession, '/api/v0/work/projects?show=all')).includes('Agency'), 'nothing of the agency');
  await refused(null, '/api/v0/auth/set-password', { token: link, password: PASSWORD }, 400);   // works once
  // Later, signed out at the shared address: her e-mail and the password she chose open her company.
  s = await must(null, '/api/v0/auth/account-sign-in', { login: 'porom.kale@gmail.example', password: PASSWORD });
  eq(s.org, company, 'signs in later into her company');

  // ------------------------------------------------------------------------------- 2. joining is the same person
  // Ruvin has a Pulse account with a verified e-mail; HR added him with that e-mail; he joins with the shared link.
  const RUVIN = 'ruvin.more@gmail.example';
  s = await signUp('Ruvin More', RUVIN);
  const ruvinAccount = { token: s.token }; eq(s.personal, true);
  const ruvin = await must(founder, '/api/v0/people', { name: 'Ruvin More', role: 'Delivery', email: RUVIN });
  let inv = await must(founder, '/api/v0/account/invites', { kind: 'staff', title: 'Delivery' });
  s = await must(ruvinAccount, '/api/v0/account/accept', { token: new URL(inv.link).hash.slice(1) });
  eq(s.org, company);
  me = await must({ token: s.token }, '/api/v0/me');
  eq([me.org, me.person], [company, ruvin.id], 'linked to the record HR added, not a second Ruvin');
  // Meera joins with the link and a new account whose e-mail nobody proved: no link to HR's record (anyone with the
  // link could type it), so two records, and the pickers show the one who signs in.
  const meeraRecord = await must(founder, '/api/v0/people', { name: 'Meera Pesub', role: 'Accounts', email: 'meera.pesub@gmail.example' });
  inv = await must(founder, '/api/v0/account/invites', { kind: 'staff', title: 'Accounts' });
  s = await must(null, '/api/v0/auth/join', { token: new URL(inv.link).hash.slice(1), name: 'Meera Pesub', handle: 'meera.pesub', email: 'meera.pesub@gmail.example', password: PASSWORD });
  const meera = (await must({ token: s.token }, '/api/v0/me')).person;
  ok(meera && meera !== meeraRecord.id, 'an unproven e-mail makes its own record');
  const options = await must(founder, '/api/v0/work/options');
  const ids = (options.people ?? []).filter((x) => !x.agent).map((x) => x.id);
  ok(ids.includes(meera) && !ids.includes(meeraRecord.id), `the assignee picker shows Meera who signs in, not HR's record: ${JSON.stringify(options.people?.map((x) => [x.id, x.name]))}`);
  ok(ids.includes(ruvin.id) && ids.includes(porom.id) && ids.includes(founderId), 'everyone who signs in is in the picker');
  eq(ids.filter((x) => x === ruvin.id).length, 1, 'once');

  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, company, founder: founderId, porom: porom.id, ruvin: ruvin.id, meera, meeraRecord: meeraRecord.id, link }));
} finally { await app.close().catch(() => {}); await pool.end().catch(() => {}); }
