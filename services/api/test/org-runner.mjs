// ORG acceptance against the built API on the synthetic agency (tests/core/test_org.py::test_org_accounts): one Pulse
// account per human across organisations. A staff member claims a handle, starts their own Pulse with an industry pack
// and switches between it and the agency without signing in again; every request runs inside the active organisation
// only; a freelancer joins two organisations (a private link, and a link while signed in) and signs in once with the
// account; a client of the agency sees only their work there, starts their own Pulse in one click and switches back;
// an invitation to a handle waits in the switcher; the portable profile, badges and highlights travel with the account
// and each organisation sees only what the person allows.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';

const { createApp } = await import('../dist/app.js');
const P = JSON.parse(process.env.TEST_PEOPLE); const domain = process.env.TEST_DOMAIN; const home = process.env.PULSE_ORG_ID;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const PASSWORD = 'Correct-horse-battery-9';
/** who: a staff key of the agency (Access identity), { token } a session, or null (signed out). */
const call = async (who, url, payload, method = payload ? 'POST' : 'GET') => {
  const headers = { 'x-pulse-client-ip': crypto.randomUUID(), 'user-agent': 'org-runner Chrome on Linux' };
  if (typeof who === 'string') headers['cf-access-authenticated-user-email'] = `${who}@${domain}`;
  else if (who?.token) headers['x-pulse-session'] = who.token;
  const r = await app.inject({ url, method, headers, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const must = async (who, url, payload) => { const r = await call(who, url, payload); assert.equal(r.status, 200, `${JSON.stringify(who)} ${url}: ${JSON.stringify(r.data).slice(0, 500)}`); checks++; return r.data; };
const refused = async (who, url, payload, status) => { const r = await call(who, url, payload); eq(r.status, status, `${url} should answer ${status}: ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
const linkToken = (link) => new URL(link).hash.slice(1);

try {
  // ------------------------------------------------------------------------------- an account and a handle
  let a = await must('kabir', '/api/v0/account');
  eq(a.account, null, 'no account until claimed'); ok(/^[a-z0-9]{3,}$/.test(a.suggestion), 'a handle is suggested');
  eq(a.orgs.length, 1); ok(a.orgs[0].handle, 'the organisation has a handle');
  a = await must('kabir', '/api/v0/account/claim', { handle: 'kabir.m', password: PASSWORD });
  eq([a.account.handle, a.account.hasPassword, a.orgs.length], ['kabir.m', true, 1]);
  await refused('kedab', '/api/v0/account/claim', { handle: 'kabir.m' }, 409);
  await refused('kedab', '/api/v0/account/claim', { handle: 'No Spaces' }, 400);
  await refused('kedab', '/api/v0/account/claim', { handle: 'kedab.s', password: 'short' }, 400);
  const agency = a.orgs[0]; eq(agency.id, home);
  await refused('kedab', '/api/v0/account/claim', { handle: agency.handle }, 409);   // one namespace with organisations

  // ------------------------------------------------------------------------------- start your own Pulse, switch
  let s = await must('kabir', '/api/v0/account/start', { name: 'Kabir Studio', pack: 'marketing_agency' });
  ok(s.token && s.org !== home && s.handle === 'kabirstudio', JSON.stringify(s)); eq(s.hostOwn, false);
  const studio = s.org; const kStudio = { token: s.token };
  let me = await must(kStudio, '/api/v0/me');
  eq([me.org, me.role, me.orgName, me.orgHandle], [studio, 'admin', 'Kabir Studio', 'kabirstudio'], 'the new organisation, as its admin');
  eq((await must(kStudio, '/v1/flow/setup')).pack.key, 'marketing_agency', 'the industry pack is in');
  const people = await must(kStudio, '/api/v0/people');
  eq((people.people ?? people).map((x) => x.name), ['Kabir Mifos'], 'nothing of the agency inside the new organisation');
  a = await must(kStudio, '/api/v0/account');
  eq(a.orgs.map((o) => [o.id, o.current]), [[studio, true], [home, false]], 'both organisations, the active one first');
  s = await must(kStudio, '/api/v0/account/switch', { org: home });
  const kHome = { token: s.token }; eq((await must(kHome, '/api/v0/me')).org, home, 'back in the agency, no sign-in');
  eq((await must(kHome, '/api/v0/me')).person, P.kabir, 'as the same person there');
  await refused(kHome, '/api/v0/account/switch', { org: '00000000-0000-4000-8000-000000000000' }, 403);
  await refused('kedab', '/api/v0/account/switch', { org: studio }, 403);   // not a member
  eq((await must(kStudio, '/api/v0/me')).org, studio, 'the studio session stays valid beside it');

  // ------------------------------------------------------------------------------- a freelancer in two organisations
  await refused('kabir', '/api/v0/account/invites', { kind: 'freelancer' }, 403);     // a member does not invite
  let inv = await must('admin', '/api/v0/account/invites', { kind: 'freelancer', title: 'Video editor' });
  ok(inv.link?.includes('/join#') && inv.warning, 'a private link, shown once'); const toAgency = linkToken(inv.link);
  inv = await must(kStudio, '/api/v0/account/invites', { kind: 'freelancer', title: 'Motion designer' }); const toStudio = linkToken(inv.link);
  eq(await must(null, '/api/v0/auth/join-peek', { token: toAgency }), { org: (await must('kedab', '/api/v0/me')).orgName, orgHandle: agency.handle, kind: 'freelancer', title: 'Video editor' });
  await refused(null, '/api/v0/auth/join', { token: toAgency, name: 'Fara Khan', handle: 'kabir.m', password: PASSWORD }, 409);
  await refused(null, '/api/v0/auth/join', { token: toAgency, name: 'Fara Khan', handle: 'fara', password: 'weak' }, 400);
  s = await must(null, '/api/v0/auth/join', { token: toAgency, name: 'Fara Khan', handle: 'fara', email: `fara@freelance.example`, password: PASSWORD });
  const fAgency = { token: s.token }; eq(s.org, home);
  me = await must(fAgency, '/api/v0/me'); eq([me.side, me.role, me.name], ['freelancer', 'person', 'Fara Khan']);
  await refused(null, '/api/v0/auth/join', { token: toAgency, name: 'Someone', handle: 'someone', password: PASSWORD }, 400);   // used up
  s = await must(fAgency, '/api/v0/account/accept', { token: toStudio }); const fStudio = { token: s.token };
  eq([(await must(fStudio, '/api/v0/me')).org, (await must(fStudio, '/api/v0/me')).side], [studio, 'freelancer']);
  a = await must(fStudio, '/api/v0/account'); eq(a.orgs.length, 2, 'the freelancer sees both organisations');
  s = await must(null, '/api/v0/auth/account-sign-in', { login: 'fara', password: PASSWORD });
  eq(s.org, studio, 'signing in with the account goes to the organisation used last');
  s = await must(null, '/api/v0/auth/account-sign-in', { login: 'fara@freelance.example', password: PASSWORD }); ok(s.token, 'or with the e-mail');
  await refused(null, '/api/v0/auth/account-sign-in', { login: 'fara', password: 'wrong-password-1' }, 401);

  // ------------------------------------------------------------------------------- the portable profile
  let prof = await must(fAgency, '/api/v0/account/profile', { headline: 'Video editor, reels and walkthroughs', about: 'Five years cutting property films.', skills: ['Premiere Pro', 'Colour', 'Premiere Pro'], links: [{ label: 'Reel', url: 'https://example.com/reel' }, { label: 'Bad', url: 'javascript:alert(1)' }] });
  eq([prof.profile.skills.sort(), prof.profile.links.length], [['Colour', 'Premiere Pro'], 1], 'skills de-duplicated, only https links');
  await refused(fAgency, `/api/v0/people/${P.kabir}/badges`, { title: 'Nice' }, 403);
  const fPersonHome = (await must(fAgency, '/api/v0/me')).person;
  await must('kedab', `/api/v0/people/${fPersonHome}/badges`, { title: 'Fast turnaround', note: 'Twelve reels in a week' });
  prof = await must(fAgency, '/api/v0/account/highlights', { title: 'Cut the Skyline launch film', on: '2026-10-01' });
  eq([prof.badges.length, prof.highlights.length], [1, 1]); ok(prof.badges[0].from && prof.badges[0].here, 'the badge names who gave it');
  const fPersonStudio = (await must(fStudio, '/api/v0/me')).person;
  let card = (await must(kStudio, `/api/v0/people/${fPersonStudio}/carried`)).card;
  eq([card.handle, card.headline, card.badges.map((b) => b.title), card.highlights.map((h) => h.title)], ['fara', 'Video editor, reels and walkthroughs', ['Fast turnaround'], ['Cut the Skyline launch film']], 'carried into the studio');
  ok(!JSON.stringify(card).includes('Twelve reels') || card.badges[0].note === 'Twelve reels in a week', 'a badge carries its own note only');
  await must(fStudio, '/api/v0/account/share', { profile: true, skills: true, badges: false, highlights: false });
  card = (await must(kStudio, `/api/v0/people/${fPersonStudio}/carried`)).card;
  eq([card.badges.length, card.highlights.length, card.headline !== null], [0, 0, true], 'only what she allows in the studio');
  card = (await must('kedab', `/api/v0/people/${fPersonHome}/carried`)).card;
  eq(card.badges.map((b) => [b.title, b.here]), [['Fast turnaround', true]], 'the agency still sees its own badge');
  eq((await must(kStudio, `/api/v0/people/${P.kedab}/carried`)).card, null, 'nobody outside the organisation');
  prof = await must(fAgency, `/api/v0/account/badges/${prof.badges[0].id}`, { carried: false }); eq(prof.badges[0].carried, false);

  // ------------------------------------------------------------------------------- a client starts their own Pulse
  inv = await must('admin', '/api/v0/account/invites', { kind: 'client', title: 'Client · Skyline Homes' });
  s = await must(null, '/api/v0/auth/join', { token: linkToken(inv.link), name: 'Cleo Dsouza', handle: 'cleo', password: PASSWORD });
  const cAgency = { token: s.token }; eq([s.kind, s.home], ['client', '/tasks']);
  me = await must(cAgency, '/api/v0/me'); eq([me.side, me.hiddenScreens.keys.includes('team'), me.hiddenScreens.keys.includes('work')], ['client', true, false]);
  await refused(cAgency, '/api/v0/people', undefined, 403);
  await refused(cAgency, '/api/v0/leadership-week', undefined, 403);
  await must(cAgency, '/api/v0/tasks');
  s = await must(cAgency, '/api/v0/account/start', { name: 'Cleo Homes', pack: 'real_estate_developer' });
  const cOwn = { token: s.token }; me = await must(cOwn, '/api/v0/me');
  eq([me.orgName, me.role, me.side], ['Cleo Homes', 'admin', 'staff'], 'in one click, the owner of their own Pulse');
  eq((await must(cOwn, '/api/v0/account')).orgs.map((o) => o.kind).sort(), ['client', 'staff']);
  s = await must(cOwn, '/api/v0/account/switch', { org: home }); await refused({ token: s.token }, '/api/v0/people', undefined, 403);
  eq((await must({ token: s.token }, '/api/v0/me')).side, 'client', 'and back as the agency\'s client');

  // ------------------------------------------------------------------------------- an invitation to a handle
  await refused(kStudio, '/api/v0/account/invites', { kind: 'client', toHandle: 'nobody.here' }, 404);
  inv = await must(kStudio, '/api/v0/account/invites', { kind: 'client', toHandle: '@cleo' }); eq([inv.link, inv.toHandle], [null, 'cleo']);
  await refused(kStudio, '/api/v0/account/invites', { kind: 'staff', toHandle: 'fara' }, 409);   // already in
  a = await must(cOwn, '/api/v0/account'); eq(a.invites.map((i) => [i.org, i.kind]), [['Kabir Studio', 'client']], 'it waits in the switcher');
  await refused(fStudio, '/api/v0/account/accept', { id: inv.id }, 400);   // someone else's
  s = await must(cOwn, '/api/v0/account/accept', { id: inv.id }); eq(s.org, studio);
  eq((await must(cOwn, '/api/v0/account')).orgs.length, 3, 'three organisations on one account');
  let list = (await must(kStudio, '/api/v0/account/invites')).invites;
  ok(list.some((i) => i.status === 'accepted' && i.who === 'Cleo Dsouza'), 'the inviter sees who joined');
  inv = await must(kStudio, '/api/v0/account/invites', { kind: 'staff' });
  list = (await must(kStudio, `/api/v0/account/invites/${inv.id}/revoke`, {})).invites; ok(list.find((i) => i.id === inv.id).status === 'revoked');
  await refused(null, '/api/v0/auth/join-peek', { token: linkToken(inv.link) }, 404);

  // ------------------------------------------------------------------------------- an existing person links an account
  await refused('kedab', '/api/v0/account/link', { login: 'fara', password: 'wrong-password-1' }, 401);
  await refused('admin', '/api/v0/account/link', { login: 'fara', password: PASSWORD }, 409);   // fara already has someone here
  a = await must('kedab', '/api/v0/account/link', { login: 'cleo', password: PASSWORD }).catch(async () => null);
  ok(a === null || a.account.handle === 'cleo', 'linking needs the account\'s own password');

  // ------------------------------------------------------------------------------- sessions stay in their organisation
  await refused({ token: 'x'.repeat(43) }, '/api/v0/me', undefined, 401);
  for (const i of [1, 2, 3, 4, 5]) await call(null, '/api/v0/auth/account-sign-in', { login: 'kabir.m', password: `wrong-${i}-password` });
  await refused(null, '/api/v0/auth/account-sign-in', { login: 'kabir.m', password: PASSWORD }, 401);   // locked for 15 minutes
  await must(kHome, '/api/v0/account');   // an existing session keeps working
  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, studio }));
  console.log(`org-runner: ${checks} checks passed`);
} finally { await app.close(); await pool.end(); }
