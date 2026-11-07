// ONBOARD-SELF acceptance against the built API on the synthetic agency (tests/core/test_self_serve.py), mail in the
// sink (nothing leaves the machine): a founder with no account starts "NeetiCRM" from the public page (an e-mailed code,
// then the company), which opens ready to use with its starter projects and module switches; it cannot see the agency
// and the agency cannot see it; an unproven e-mail cannot start a company and a proven one can; three a day per
// account; invitations by e-mail per seat: an address that already has a Pulse account gets a second seat on the same
// account, a new address makes an account; the first-run guide (checklist for leadership, tips per seat).
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';

const { createApp } = await import('../dist/app.js');
const { testMail } = await import('../dist/auth-mail.js');
const domain = process.env.TEST_DOMAIN; const home = process.env.PULSE_ORG_ID;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const PASSWORD = 'Correct-horse-battery-9';
const call = async (who, url, payload, method = payload ? 'POST' : 'GET') => {
  const headers = { 'x-pulse-client-ip': crypto.randomUUID(), 'user-agent': 'self-serve-runner Chrome on Linux' };
  if (typeof who === 'string') headers['cf-access-authenticated-user-email'] = `${who}@${domain}`;
  else if (who?.token) headers['x-pulse-session'] = who.token;
  const r = await app.inject({ url, method, headers, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const must = async (who, url, payload) => { const r = await call(who, url, payload); assert.equal(r.status, 200, `${JSON.stringify(who)} ${url}: ${JSON.stringify(r.data).slice(0, 600)}`); checks++; return r.data; };
const refused = async (who, url, payload, status) => { const r = await call(who, url, payload); eq(r.status, status, `${url} should answer ${status}: ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
const mailTo = (to) => testMail.filter((m) => m.to === to).at(-1);
const codeIn = (to) => mailTo(to)?.body.match(/Your Pulse code is (\d{6})/)?.[1];
const linkIn = (to) => mailTo(to)?.body.match(/https?:\/\/\S+\/join#([A-Za-z0-9_-]{43})/)?.[1];
const projects = async (who) => JSON.stringify(await must(who, '/api/v0/work/projects?show=all'));

try {
  // ------------------------------------------------------------------------------- the agency's own work, for later
  await must('kedab', '/api/v0/work/projects', { type: 'internal', name: 'Agency private roadmap' });

  // ------------------------------------------------------------------------------- signed out: NeetiCRM starts itself
  const FOUNDER = 'founder@neeticrm.example';
  const company = { name: 'NeetiCRM', handle: 'neeticrm', templates: ['sales', 'software'], timeZone: 'Asia/Kolkata', workDays: [1, 2, 3, 4, 5, 6], dayStart: '10:00', dayEnd: '19:00',
    host: 'neeticrm.example', domain: 'neeticrm.example' };   // an address is never claimed here
  await refused(null, '/api/v0/auth/signup', { step: 'code', email: 'not-an-email' }, 400);
  eq((await must(null, '/api/v0/auth/signup', { step: 'code', email: FOUNDER })).ok, true);
  const code = codeIn(FOUNDER); ok(code, 'a 6-digit code was mailed');
  ok(/works for 15 minutes/.test(mailTo(FOUNDER).body), 'the mail says how long it works');
  await must(null, '/api/v0/auth/signup', { step: 'code', email: FOUNDER });
  eq(testMail.filter((m) => m.to === FOUNDER).length, 1, 'one code a minute');
  await refused(null, '/api/v0/auth/signup', { step: 'check', email: FOUNDER, code: code === '000000' ? '111111' : '000000' }, 400);
  await must(null, '/api/v0/auth/signup', { step: 'check', email: FOUNDER, code });
  await refused(null, '/api/v0/auth/signup', { email: FOUNDER, code, name: 'Neeti Founder', password: 'short', company }, 400);
  await refused(null, '/api/v0/auth/signup', { email: FOUNDER, code, name: 'Neeti Founder', password: PASSWORD, company: { ...company, templates: ['casino'] } }, 400);
  let s = await must(null, '/api/v0/auth/signup', { email: FOUNDER, code, name: 'Neeti Founder', password: PASSWORD, company });
  ok(s.token && s.org !== home, 'a session in the new company'); eq([s.name, s.handle, s.home], ['NeetiCRM', 'neeticrm', '/start/team']);
  const neeti = s.org; const founder = { token: s.token };
  await refused(null, '/api/v0/auth/signup', { email: FOUNDER, code, name: 'Neeti Again', password: PASSWORD, company: { ...company, name: 'NeetiCRM Two', handle: 'neeti2' } }, 409);
  let me = await must(founder, '/api/v0/me');
  eq([me.org, me.role, me.orgName], [neeti, 'admin', 'NeetiCRM'], 'the founder runs it (admin and leadership)');
  ok(me.modules.off.includes('designers') && me.modules.off.includes('hr') && !me.modules.off.includes('acquisition') && !me.modules.off.includes('money'),
    `the sales and software templates' modules: ${JSON.stringify(me.modules.off)}`);
  // Ready to use: not held in set-up; its starter projects with their first steps.
  const list = await projects(founder);
  ok(list.includes('Sales pipeline') && list.includes('Product roadmap'), 'one starter project per template');
  ok(!list.includes('Agency private roadmap'), 'nothing of the agency inside NeetiCRM');
  const tasks = JSON.stringify(await must(founder, '/api/v0/tasks?size=100'));
  ok(tasks.includes('Add your first 10 leads') && tasks.includes('Set up a weekly demo'), 'the starter steps are tasks');
  const people = await must(founder, '/api/v0/people'); eq((people.people ?? people).map((x) => x.name), ['Neeti Founder'], 'only its own people');
  ok(!(await projects('kedab')).includes('Sales pipeline'), 'and the agency sees nothing of NeetiCRM');
  await refused(founder, '/api/v0/account/switch', { org: home }, 403);
  let acct = await must(founder, '/api/v0/account');
  eq([acct.account.email, acct.orgs.map((o) => o.id)], [FOUNDER, [neeti]]);
  eq((await must(founder, '/api/v0/account/verify-email')).verified, true, 'the code proved the e-mail');

  // ------------------------------------------------------------------------------- first-run guide for leadership
  let g = (await must(founder, '/api/v0/account/onboarding')).guide;
  eq([g.lead, g.seat.key, g.dismissed, g.items.map((i) => [i.key, i.done])],
    [true, 'leadership', false, [['invite', false], ['project', false], ['targets', false], ['app', false]]]);
  eq((await must('kedab', '/api/v0/account/onboarding')).guide, null, 'no guide in a company set up another way');

  // ------------------------------------------------------------------------------- invitations by e-mail, per seat
  await must('kabir', '/api/v0/account/verify-email');   // the Access identity proves kabir@… on his account
  const KABIR = `kabir@${domain}`, REP = 'ravi.rep@neeticrm.example', LEAD = 'meena.partner@neeticrm.example';
  await refused('kabir', '/api/v0/account/invites', { rows: [{ email: REP, seat: 'sales' }] }, 403);   // not in NeetiCRM
  let inv = await must(founder, '/api/v0/account/invites', { rows: [{ email: KABIR, seat: 'manager' }, { email: REP, seat: 'sales' }, { email: 'nope', seat: 'staff' },
    { email: FOUNDER, seat: 'staff' }, { email: LEAD.toUpperCase(), seat: 'leadership' }] });
  eq(inv.rows.map((r) => [r.email, r.status, r.mailed]), [[KABIR, 'created', true], [REP, 'created', true], ['nope', 'invalid', false], [FOUNDER, 'member', false], [LEAD, 'created', true]]);
  eq(inv.rows.every((r) => r.link === null), true, 'mailed links are not shown');
  await refused(founder, '/api/v0/account/invites', { rows: [{ email: REP, seat: 'owner' }] }, 400);
  ok(/as manager/.test(mailTo(KABIR).body) && /already has a Pulse account: sign in/.test(mailTo(KABIR).body), 'an existing account is told to sign in');
  ok(/You won't see: Salaries/.test(mailTo(REP).body) && mailTo(REP).title === 'Neeti Founder invited you to NeetiCRM on Pulse', 'the seat and what it sees');
  const invites = (await must(founder, '/api/v0/account/invites')).invites;
  ok(invites.some((i) => i.email === REP && i.seat === 'sales' && i.mailed), 'listed with the address and seat');

  // An address that already has a Pulse account: the same account gets a seat in NeetiCRM, never a second account.
  const kabirLink = linkIn(KABIR); ok(kabirLink, 'the invitation link');
  let peek = await must(null, '/api/v0/auth/join-peek', { token: kabirLink });
  eq([peek.org, peek.seat, peek.email, peek.hasAccount], ['NeetiCRM', 'manager', KABIR, true]);
  await refused(null, '/api/v0/auth/join', { token: kabirLink, name: 'Kabir Again', handle: 'kabir.two', password: PASSWORD }, 409);
  s = await must('kabir', '/api/v0/account/accept', { token: kabirLink }); eq(s.org, neeti);
  const kNeeti = { token: s.token }; me = await must(kNeeti, '/api/v0/me');
  eq([me.org, me.role], [neeti, 'manager'], 'a manager seat');
  acct = await must(kNeeti, '/api/v0/account'); eq(acct.orgs.map((o) => o.id).sort(), [neeti, home].sort(), 'one account, two companies');
  eq((await must(kNeeti, '/api/v0/account/onboarding')).guide.seat.key, 'manager');
  ok(!(await projects(kNeeti)).includes('Agency private roadmap'), 'inside NeetiCRM, the agency stays out of sight');

  // A new address: the link makes the account with that address (proven by the link) and the seat.
  const repLink = linkIn(REP);
  peek = await must(null, '/api/v0/auth/join-peek', { token: repLink }); eq([peek.seat, peek.email, peek.hasAccount], ['sales', REP, false]);
  s = await must(null, '/api/v0/auth/join', { token: repLink, name: 'Ravi Rep', email: 'someone.else@example.test', password: PASSWORD });
  const rep = { token: s.token }; me = await must(rep, '/api/v0/me'); eq([me.org, me.side], [neeti, 'staff']); ok(!['admin', 'leadership', 'manager'].includes(me.role), 'a sales rep is no manager');
  acct = await must(rep, '/api/v0/account'); eq(acct.account.email, REP, 'the invited address, not another one');
  eq((await must(rep, '/api/v0/account/verify-email')).verified, true, 'the mailed link proved it');
  g = (await must(rep, '/api/v0/account/onboarding')).guide; eq([g.lead, g.seat.key, g.items], [false, 'sales', []]); ok(g.seat.tips.length >= 3, 'tips for the seat');
  await refused(null, '/api/v0/auth/join', { token: repLink, name: 'Ravi Rep', password: PASSWORD }, 400);   // used once
  // Signing in later with the account (password) lands in NeetiCRM.
  s = await must(null, '/api/v0/auth/account-sign-in', { login: REP, password: PASSWORD }); eq(s.org, neeti);
  s = await must(null, '/api/v0/auth/join', { token: linkIn(LEAD), name: 'Meena Partner', password: PASSWORD });
  eq((await must({ token: s.token }, '/api/v0/me')).role, 'leadership', 'a leadership seat');

  // ACCOUNT-SEATS (1463): the agency's earlier, inactive record of an address (tests/core sets it up) is linked, never
  // duplicated; it stays inactive until the agency's HR decides, so no session opens there yet.
  const OLD = 'sana.old@gmail.example';
  inv = await must('admin', '/api/v0/account/invites', { rows: [{ email: OLD, seat: 'staff' }] }); eq(inv.rows[0].status, 'created', 'an inactive record is no member');
  s = await must(null, '/api/v0/auth/join', { token: linkIn(OLD), name: 'Sana Qipedot', password: PASSWORD });
  eq([s.waiting, s.token, s.org], [true, undefined, home], 'linked, waiting for HR'); ok(/HR decides/.test(s.message), s.message);

  // Leaving a company: the seat ends, the account and its other companies stay; leaving the one I am in opens another.
  await refused(kNeeti, '/api/v0/account/leave', { org: '00000000-0000-4000-8000-000000000000' }, 404);
  await refused(founder, '/api/v0/account/leave', { org: neeti }, 400);   // the last admin stays
  s = await must(kNeeti, '/api/v0/account/leave', { org: neeti });
  eq([s.left, s.leftName, s.org], [neeti, 'NeetiCRM', home], 'moved to the agency');
  await refused(kNeeti, '/api/v0/me', undefined, 401);   // the NeetiCRM session ended
  eq((await must({ token: s.token }, '/api/v0/account')).orgs.map((o) => o.id), [home], 'the account keeps the agency');
  await refused('kabir', '/api/v0/account/switch', { org: neeti }, 403);   // no seat there any more
  s = await must(rep, '/api/v0/account/leave', { org: neeti }); eq(s.signedOut, true, 'no other company: signed out of it');
  eq((await call(null, '/api/v0/auth/account-sign-in', { login: REP, password: PASSWORD })).status, 401, 'the account stays, with no company to land in');

  // The checklist follows the company: invitations sent; tick the phone app by hand; put the guide away.
  g = (await must(founder, '/api/v0/account/onboarding')).guide; eq(g.items.find((i) => i.key === 'invite').done, true);
  g = (await must(founder, '/api/v0/account/onboarding', { item: 'app' })).guide; eq(g.items.find((i) => i.key === 'app').done, true);
  await must(founder, '/api/v0/work/projects', { type: 'internal', name: 'Q4 launch' });
  g = (await must(founder, '/api/v0/account/onboarding')).guide; eq(g.items.find((i) => i.key === 'project').done, true, 'a project of their own');
  await refused(founder, '/api/v0/account/onboarding', { item: 'everything' }, 400);
  g = (await must(founder, '/api/v0/account/onboarding', { item: 'dismissed' })).guide; eq(g.dismissed, true);

  // ------------------------------------------------------------------------------- signed in: a proven e-mail first
  inv = await must('admin', '/api/v0/account/invites', { kind: 'client', title: 'Client · Ruvin Traders' });
  s = await must(null, '/api/v0/auth/join', { token: new URL(inv.link).hash.slice(1), name: 'Ruvin Shah', handle: 'ruvin.shah', password: PASSWORD });
  const ruvin = { token: s.token };
  const ruvinCompany = { name: 'Ruvin Traders', templates: ['agency', 'general'], modules: ['chats', 'money', 'hr'], timeZone: 'Asia/Dubai', workDays: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '18:00' };
  await refused(ruvin, '/api/v0/account/start', ruvinCompany, 403);
  await refused(ruvin, '/api/v0/account/start', { name: 'Ruvin Legacy' }, 403);   // Start your own Pulse needs it too
  eq((await must(ruvin, '/api/v0/account/verify-email')).verified, false);
  await must(ruvin, '/api/v0/account/verify-email', { email: 'ruvin@traders.example' });
  await refused(ruvin, '/api/v0/account/verify-email/confirm', { code: '12' }, 400);
  await must(ruvin, '/api/v0/account/verify-email/confirm', { code: codeIn('ruvin@traders.example') });
  await refused(ruvin, '/api/v0/account/verify-email', { email: FOUNDER }, 409);   // someone else's address
  s = await must(ruvin, '/api/v0/account/start', ruvinCompany); eq([s.name, s.home], ['Ruvin Traders', '/start/team']);
  const rOwn = { token: s.token }; me = await must(rOwn, '/api/v0/me');
  eq([me.orgName, me.role, me.side], ['Ruvin Traders', 'admin', 'staff']);
  ok(me.modules.off.includes('acquisition') && !me.modules.off.includes('hr') && !me.modules.off.includes('chats'), 'the modules picked by hand');
  const rl = await projects(rOwn); ok(rl.includes('First client project') && rl.includes('Getting started') && !rl.includes('Sales pipeline'), 'its own starters only');
  eq((await must(rOwn, '/api/v0/account')).orgs.map((o) => o.kind).sort(), ['client', 'staff'], 'client of the agency, owner of his own');

  // ------------------------------------------------------------------------------- three companies a day per account
  await must(founder, '/api/v0/account/start', { name: 'Neeti Labs', templates: ['general'] });
  await must(founder, '/api/v0/account/start', { name: 'Neeti Studio', templates: ['creator'] });
  await refused(founder, '/api/v0/account/start', { name: 'Neeti Four', templates: ['general'] }, 429);
  await refused(founder, '/api/v0/account/start', { name: 'x', templates: ['general'] }, 400);

  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, neeti, repEmail: REP }));
} finally { await app.close().catch(() => {}); await pool.end().catch(() => {}); }
