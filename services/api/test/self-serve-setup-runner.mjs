// SELF-SERVE (owner, 4 Nov 2026): the HTTP side of signing up by type (tests/core/test_self_serve_setup.py runs it on
// synthetic people with the mail sink: nothing leaves the machine). Every kind of space signs up with an e-mailed code
// and opens set up for its type (cards, words, client types, starters, home); a professional adds a client whose
// e-mailed link opens their space with one click and no password, and sees the appointment the team booked; an address
// with an account signs in first; a link that was not e-mailed asks for details; Start another space; About you; the
// connector's app name for the sign-in page. Writes a report for the Python side to check the database.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { testMail } from '../dist/auth-mail.js';

const E = process.env, pool = new Pool(JSON.parse(E.TEST_API_CONFIG)), app = createApp(pool, pool);
let checks = 0, ipNo = 10;
const call = async (path, body, { token, ip = '198.51.100.20' } = {}) => {
  checks++;
  const r = await app.inject({ method: body === undefined ? 'GET' : 'POST', url: '/api/v0/' + path, headers: { 'x-pulse-client-ip': ip, ...(token ? { 'x-pulse-session': token } : {}) }, ...(body === undefined ? {} : { payload: body }) });
  return { status: r.statusCode, data: r.json() };
};
const run = Date.now().toString(36);
const mailTo = async (to, title) => { for (let i = 0; i < 40; i++) { const m = testMail.filter((x) => x.to === to && (!title || x.title === title)).at(-1); if (m) return m; await delay(50); } throw new Error(`no mail to ${to}`); };
const ok = (r, what) => { assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const report = { spaces: {}, timings: {} };

/** Sign up with the two answers: a code to the e-mail, then the account and its first space. */
async function signup(key, profiles, space, extra = {}) {
  const ip = `198.51.100.${ipNo++}`, email = `ss.${key}.${run}@gmail.example`, name = extra.name ?? `Synthetic ${key.replace(/_/g, ' ')}`;
  const t0 = performance.now();
  ok(await call('auth/signup-code', { name, email, handle: '', orgName: '' }, { ip }), `${key} code`);
  const code = (await mailTo(email, 'Your Pulse sign-up code')).body.match(/sign-up code is (\d{6})/)[1];
  const setup = { profiles, space, timeZone: 'Asia/Kolkata', ...(space === 'personal' ? {} : { orgName: extra.orgName ?? `Synthetic ${key} ${run}` }), ...(extra.served ? { served: extra.served } : {}) };
  const made = ok(await call('auth/signup-confirm', { name, email, handle: '', orgName: '', code, setup }, { ip }), `${key} confirm`);
  report.timings[key] = Math.round(performance.now() - t0);
  assert.match(made.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(made.maxAge, 2592000);
  assert.equal(made.personal, space === 'personal'); assert.equal(made.home, space === 'personal' ? '/my-day' : '/dashboard');
  const token = made.token;
  const guide = ok(await call('account/onboarding', undefined, { token }), `${key} guide`).guide;
  assert.equal(guide.lead, true); assert.equal(guide.space, space); assert.ok(guide.items.length >= 3);
  assert.ok(guide.items.every((i) => i.label && i.href.startsWith('/') && i.note && i.done === false), `${key}: fresh cards, nothing done yet`);
  const about = ok(await call('account/about', undefined, { token }), `${key} about`);
  assert.deepEqual(about.profiles.sort(), [...profiles].sort()); assert.equal(about.space.kind, space); assert.equal(about.admin, true);
  const me = ok(await call('account', undefined, { token }), `${key} account`);
  assert.equal(me.account.hasPassword, false, 'no password was asked for'); assert.equal(me.account.email, email);
  report.spaces[key] = { org: made.org, email, space, items: guide.items.map((i) => i.key), words: about.words };
  return { token, made, guide, about, email, name, ip };
}

try {
  // 1. Every kind of space, signed up with an e-mailed code, opens set up for its type.
  const personal = await signup('student', ['student', 'creator'], 'personal', { name: 'Synthetic Rila Shah' });
  assert.deepEqual(personal.guide.items.map((i) => i.key), ['todo', 'project', 'app']);
  assert.equal(personal.made.name, "Synthetic Rila Shah's Pulse");
  assert.equal(personal.about.words?.clients ?? 'Clients', 'Clients');
  const practice = await signup('practice', ['professional'], 'practice', { name: 'Synthetic Omoza Pesub', orgName: `Synthetic Omoza Pesub Practice ${run}`, served: 'patients' });
  assert.deepEqual(practice.guide.items.map((i) => i.key), ['client', 'appointment', 'invoice', 'words', 'app']);
  assert.equal(practice.guide.items[0].label, 'Add your first patient'); assert.equal(practice.about.words.clients, 'Patients'); assert.equal(practice.about.words.runs, 'Sessions');
  for (const [key, profiles] of [['agency', ['freelancer', 'owner']], ['shop', ['owner']], ['maker', ['owner']], ['real_estate', ['owner', 'employee']], ['school', ['owner']], ['ngo', ['other']], ['other', ['owner']]])
    await signup(key, profiles, key);
  assert.equal(report.spaces.shop.words.clients, 'Customers'); assert.equal(report.spaces.school.words.team, 'Class'); assert.equal(report.spaces.ngo.words.projects, 'Programmes');
  // A creator who models: a personal space too. And asking again for an address that has an account answers the same.
  await signup('creator', ['creator'], 'personal', { name: 'Synthetic Mira Kapoor' });
  {
    const ip = '198.51.100.90';
    ok(await call('auth/signup-code', { name: 'Synthetic Again', email: practice.email, handle: '', orgName: '' }, { ip }), 'again code');
    // (The "sign in instead" e-mail itself is account-code-runner's; within a minute of the first code the ration holds it.)
  }
  // Refusals: a bad setup is a plain 400 before any code is used.
  {
    const ip = '198.51.100.91', email = `ss.bad.${run}@gmail.example`;
    ok(await call('auth/signup-code', { name: 'Synthetic Bad', email, handle: '', orgName: '' }, { ip }), 'bad code');
    const code = (await mailTo(email, 'Your Pulse sign-up code')).body.match(/sign-up code is (\d{6})/)[1];
    const bad = await call('auth/signup-confirm', { name: 'Synthetic Bad', email, code, setup: { profiles: [], space: 'personal' } }, { ip });
    assert.equal(bad.status, 400); assert.match(bad.data.error, /describes you/);
    const wrong = await call('auth/signup-confirm', { name: 'Synthetic Bad', email, code: code === '000000' ? '111111' : '000000', setup: { profiles: ['other'], space: 'personal' } }, { ip });
    assert.equal(wrong.status, 401);
    ok(await call('auth/signup-confirm', { name: 'Synthetic Bad', email, code, setup: { profiles: ['other'], space: 'personal' } }, { ip }), 'the code still works after a refused setup');
  }

  // 2. The psychologist adds a client; the client's e-mailed link opens their space with one click.
  const T = practice.token;
  const clientEmail = `ss.client.${run}@gmail.example`;
  const added = ok(await call('practice/clients', { name: 'Synthetic Asha Rao', email: clientEmail, phone: '+91 90000 00101', message: 'See you on Tuesday.' }, { token: T }), 'add client');
  assert.equal(added.sent, true); assert.equal(added.word, 'Patient'); assert.match(added.link, /\/invited#[A-Za-z0-9_-]{43}$/);
  const invite = await mailTo(clientEmail, 'Synthetic Omoza Pesub has set up your space on Pulse');
  assert.match(invite.body, /no password needed/); assert.match(invite.body, /See you on Tuesday\./); assert.ok(invite.body.includes(added.link));
  const linkToken = added.link.split('#')[1];
  // Only the e-mail carries the key that proves the address (review, 5 Nov 2026); the reply to the professional does not.
  const mailed = invite.body.match(/\/invited#([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})/);
  assert.ok(mailed, 'the e-mailed link carries the key'); assert.equal(mailed[1], linkToken);
  const linkKey = mailed[2];
  assert.ok(!JSON.stringify(added).includes(linkKey), 'the key is never in the reply (link, WhatsApp text)');
  const guideAfter = ok(await call('account/onboarding', undefined, { token: T }), 'guide after a client').guide;
  assert.equal(guideAfter.items.find((i) => i.key === 'client').done, true, 'the first card is found done');
  // The team books the first appointment (tomorrow 11:00 IST); a bad time is a plain refusal.
  assert.equal((await call('appointments', { clientId: added.id, startsAt: 'soon' }, { token: T })).status, 400);
  const at = new Date(Date.now() + 86400000); at.setUTCHours(5, 30, 0, 0);
  const appt = ok(await call('appointments', { clientId: added.id, startsAt: at.toISOString(), minutes: 50, place: 'https://meet.example/synthetic', note: 'First session' }, { token: T }), 'book');
  assert.equal(appt.client, 'Synthetic Asha Rao'); assert.equal(appt.minutes, 50);
  const list = ok(await call('appointments', undefined, { token: T }), 'list');
  assert.equal(list.upcoming.length, 1); assert.ok(list.clients.some((c) => c.id === added.id));
  assert.equal(ok(await call('account/onboarding', undefined, { token: T }), 'guide after a booking').guide.items.find((i) => i.key === 'appointment').done, true);
  // The professional's copy of the link (or anyone it is shared with on WhatsApp) cannot make the client's account: no
  // one click without the key, and a guessed key is refused. The real one click below succeeding (it refuses an address
  // that already has an account) shows no account was made for the client's address here.
  const shared = ok(await call('auth/connect-peek', { token: linkToken }, { ip: '198.51.100.130' }), 'shared peek');
  assert.equal(shared.oneClick, false); assert.equal(shared.hasAccount, false);
  const squat = await call('auth/connect-join', { token: linkToken, oneClick: true, name: 'Synthetic Someone Else' }, { ip: '198.51.100.130' });
  assert.equal(squat.status, 400, 'the shared link has no one click'); assert.match(squat.data.error, /needs your details/);
  const guessed = await call('auth/connect-join', { token: linkToken, key: linkKey.replace(/^./, (ch) => ch === 'A' ? 'B' : 'A'), oneClick: true, name: 'Synthetic Someone Else' }, { ip: '198.51.100.130' });
  assert.equal(guessed.status, 400, 'a wrong key is refused');
  assert.equal(ok(await call('auth/connect-peek', { token: linkToken, key: linkToken }, { ip: '198.51.100.130' }), 'peek, wrong key').oneClick, false);
  // The client's side: one click (no password), into their space, where the appointment is.
  const peek = ok(await call('auth/connect-peek', { token: linkToken, key: linkKey }, { ip: '198.51.100.120' }), 'peek');
  assert.equal(peek.oneClick, true); assert.equal(peek.hasAccount, false); assert.equal(peek.client, true);
  const t1 = performance.now();
  const joined = ok(await call('auth/connect-join', { token: linkToken, key: linkKey, oneClick: true, name: 'Synthetic Asha Rao' }, { ip: '198.51.100.120' }), 'one click');
  report.timings.clientOneClick = Math.round(performance.now() - t1);
  assert.equal(joined.home, '/client'); assert.equal(joined.org, practice.made.org); assert.match(joined.token, /^[A-Za-z0-9_-]{43}$/);
  const space = ok(await call('client-portal', undefined, { token: joined.token }), 'client space');
  assert.equal(space.appointments.length, 1); assert.equal(space.appointments[0].place, 'https://meet.example/synthetic'); assert.equal(space.appointments[0].with, 'Synthetic Omoza Pesub');
  assert.equal(space.provider.name, `Synthetic Omoza Pesub Practice ${run}`);
  const clientMe = ok(await call('account', undefined, { token: joined.token }), 'client account');
  assert.equal(clientMe.account.hasPassword, false); assert.equal(clientMe.account.email, clientEmail);
  assert.equal((await call('auth/connect-join', { token: linkToken, key: linkKey, oneClick: true }, { ip: '198.51.100.120' })).status, 400, 'the link works once');
  assert.equal((await call('appointments', undefined, { token: joined.token })).status, 403, 'a client cannot read the team’s appointments');
  report.client = { email: clientEmail, clientId: added.id, org: practice.made.org };
  // Next time the client signs in with an e-mailed code (no password ever set).
  ok(await call('auth/sign-in-code', { username: clientEmail }, { ip: '198.51.100.121' }), 'client sign-in code');
  const signin = await mailTo(clientEmail, 'Your Pulse sign-in code');
  const back = ok(await call('auth/code-sign-in', { username: clientEmail, code: signin.body.match(/sign-in code is (\d{6})/)[1] }, { ip: '198.51.100.121' }), 'client signs in with a code');
  assert.equal(back.org, practice.made.org);

  // 3. A client whose address already has a Pulse account: sign in first (no one-click account for a taken address).
  const known = ok(await call('practice/clients', { name: 'Synthetic Rila Shah', email: personal.email }, { token: T }), 'add a known client');
  const knownKey = (await mailTo(personal.email, 'Synthetic Omoza Pesub has set up your space on Pulse')).body.match(/\/invited#[A-Za-z0-9_-]{43}\.([A-Za-z0-9_-]{43})/)[1];
  const knownPeek = ok(await call('auth/connect-peek', { token: known.link.split('#')[1], key: knownKey }, { ip: '198.51.100.122' }), 'known peek');
  assert.equal(knownPeek.oneClick, true); assert.equal(knownPeek.hasAccount, true);
  const refused = await call('auth/connect-join', { token: known.link.split('#')[1], key: knownKey, oneClick: true }, { ip: '198.51.100.122' });
  assert.equal(refused.status, 409); assert.match(refused.data.error, /sign in with an e-mailed code/);
  // Signed in, the same link is accepted into the existing account.
  const accepted = ok(await call('account/connect-accept', { token: known.link.split('#')[1], mode: 'individual' }, { token: personal.token }), 'accept signed in');
  assert.equal(accepted.home, '/client');
  // 4. Not e-mailed (no address): the link asks for details (no one click).
  const quiet = ok(await call('practice/clients', { name: 'Synthetic Walk In', phone: '+91 90000 00102' }, { token: T }), 'add without e-mail');
  assert.equal(quiet.sent, false); assert.equal(quiet.email, null);
  assert.equal(ok(await call('auth/connect-peek', { token: quiet.link.split('#')[1] }, { ip: '198.51.100.123' }), 'quiet peek').oneClick, false);
  assert.equal((await call('auth/connect-join', { token: quiet.link.split('#')[1], oneClick: true, name: 'Synthetic Walk In' }, { ip: '198.51.100.123' })).status, 400);
  // Refusals for adding a client.
  assert.equal((await call('practice/clients', { name: 'x' }, { token: T })).status, 400);
  assert.equal((await call('practice/clients', { name: 'Synthetic Y', email: 'not-an-email' }, { token: T })).status, 400);
  assert.equal((await call('practice/clients', { name: 'Synthetic Y' }, { token: joined.token })).status, 403, 'a client cannot add clients');
  // Cancel: gone from the client's space.
  ok(await call(`appointments/${appt.id}/cancel`, {}, { token: T }), 'cancel');
  assert.equal(ok(await call('client-portal', undefined, { token: back.token }), 'client space again').appointments.length, 0);

  // 5. One person, several spaces: the student starts a practice of their own; About you changes their types.
  const second = ok(await call('account/start', { setup: { profiles: ['student', 'professional'], space: 'practice', orgName: `Synthetic Rila Coaching ${run}`, served: 'students' } }, { token: personal.token }), 'start another space');
  assert.notEqual(second.org, personal.made.org); assert.equal(second.home, '/dashboard');
  const secondGuide = ok(await call('account/onboarding', undefined, { token: second.token }), 'second guide').guide;
  assert.equal(secondGuide.items[0].label, 'Add your first student');
  const orgs = ok(await call('account', undefined, { token: second.token }), 'orgs').orgs;
  assert.ok(orgs.length >= 3, 'personal space, the practice it is a client of, and the new practice');
  const saved = ok(await call('account/about', { profiles: ['professional', 'other'] }, { token: second.token }), 'about save');
  assert.deepEqual(saved.profiles.sort(), ['other', 'professional']);
  assert.equal((await call('account/about', { profiles: ['astronaut'] }, { token: second.token })).status, 400);
  report.secondOrg = second.org; report.studentEmail = personal.email;

  // 6. The ChatGPT or Claude connector: the sign-in and sign-up pages name the app it registered.
  const reg = await app.inject({ method: 'POST', url: '/api/v0/oauth/register', headers: { 'content-type': 'application/json', 'x-pulse-client-ip': '198.51.100.130' },
    payload: { client_name: 'Synthetic Assistant', redirect_uris: ['https://assistant.example/callback'], token_endpoint_auth_method: 'none' } });
  checks++;
  assert.equal(reg.statusCode, 201, reg.body);
  const named = ok(await call(`oauth/authorize/app?client_id=${reg.json().client_id}`, undefined, { ip: '198.51.100.130' }), 'app name');
  assert.equal(named.name, 'Synthetic Assistant');
  assert.equal(ok(await call('oauth/authorize/app?client_id=pcl_nobody', undefined, { ip: '198.51.100.130' }), 'no app').name, null);
  report.mcpClient = reg.json().client_id;
  // 7. That new person's connector end to end on the shared address: consent in their own space, a PKCE token, MCP whoami
  // as them in their space (never the shared address's organisation).
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const ask = { client_id: reg.json().client_id, redirect_uri: 'https://assistant.example/callback', response_type: 'code', scope: 'people.read', state: 'synthetic', code_challenge: challenge, code_challenge_method: 'S256' };
  const consent = ok(await call(`oauth/authorize?${new URLSearchParams(ask)}`, undefined, { token: personal.token }), 'consent facts in their own space');
  assert.equal(consent.app.name, 'Synthetic Assistant'); assert.equal(consent.company, "Synthetic Rila Shah's Pulse");
  const approved = ok(await call('oauth/authorize', { ...ask, approve: true }, { token: personal.token }), 'approve');
  const code = new URL(approved.redirect).searchParams.get('code'); assert.ok(code);
  const exchange = (body) => app.inject({ method: 'POST', url: '/api/v0/oauth/token', headers: { 'content-type': 'application/json', 'x-pulse-client-ip': '198.51.100.131' }, payload: body });
  const tok = await exchange({ grant_type: 'authorization_code', code, redirect_uri: ask.redirect_uri, code_verifier: verifier, client_id: ask.client_id }); checks++;
  assert.equal(tok.statusCode, 200, tok.body);
  const { access_token: access, refresh_token: refresh } = tok.json();
  const mcp = (bearer, body) => app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-pulse-client-ip': '198.51.100.131' }, payload: body });
  const who = await mcp(access, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }); checks++;
  assert.equal(who.statusCode, 200, who.body);
  assert.ok(who.body.includes('Synthetic Rila Shah'), who.body.slice(0, 600)); assert.ok(who.body.includes("Synthetic Rila Shah's Pulse"), 'acting in their own space');
  const again = await exchange({ grant_type: 'refresh_token', refresh_token: refresh, client_id: ask.client_id }); checks++;
  assert.equal(again.statusCode, 200, again.body);
  // A code works once; sending it again ends the connection it made (RFC 6749 4.1.2), in the person's own space too.
  assert.equal((await exchange({ grant_type: 'authorization_code', code, redirect_uri: ask.redirect_uri, code_verifier: verifier, client_id: ask.client_id })).statusCode, 400, 'a code works once');
  const ended = await mcp(again.json().access_token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } }); checks++;
  assert.ok(ended.body.includes('"status":401') || ended.statusCode === 401, 'the replayed code ended the connection');
  const bad = await mcp('pat_' + 'x'.repeat(43), { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } }); checks++;
  assert.ok(bad.statusCode === 401 || bad.body.includes('"status":401'), 'an unknown token is refused');

  report.checks = checks;
  await writeFile(E.TEST_REPORT, JSON.stringify(report));
  console.log(`self-serve-setup-runner: ${checks} checks; sign-up to first space (ms): ${JSON.stringify(report.timings)}`);
} finally { await app.close(); await pool.end(); }
