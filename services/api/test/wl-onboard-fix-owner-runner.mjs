// WL-ONBOARD-FIX (17 Nov 2026), problem 10: a company's owner who is already on its people list (admin and leadership,
// added for their e-mail, never signed in) is invited by e-mail and joins. The invitation must land on that record (its
// roles kept, no second person), open Finance and payroll figures, and greet them with the leadership first-run guide.
// tests/core/test_wl_onboard_fix_owner.py seeds the record; mail goes to the in-memory sink. Invented people only.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';

const { createApp } = await import('../dist/app.js');
const { testMail } = await import('../dist/auth-mail.js');
const domain = process.env.TEST_DOMAIN, home = process.env.PULSE_ORG_ID, owner = process.env.TEST_OWNER_PERSON, OWNER = process.env.TEST_OWNER_EMAIL;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const PASSWORD = 'Correct-horse-battery-9';
const call = async (who, url, payload, method = payload ? 'POST' : 'GET') => {
  const headers = { 'x-pulse-client-ip': crypto.randomUUID(), 'user-agent': 'wl-onboard-fix-owner Chrome on Linux' };
  if (typeof who === 'string') headers['cf-access-authenticated-user-email'] = `${who}@${domain}`;
  else if (who?.token) headers['x-pulse-session'] = who.token;
  const r = await app.inject({ url, method, headers, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const must = async (who, url, payload) => { const r = await call(who, url, payload); assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.data).slice(0, 600)}`); checks++; return r.data; };
const linkIn = (to) => testMail.filter((m) => m.to === to).at(-1)?.body.match(/https?:\/\/\S+\/join#([A-Za-z0-9_-]{43})/)?.[1];
const report = { checks: 0, steps: [] };
try {
  // The admin invites the owner by e-mail, as Team → Add people does, with the leadership seat.
  const inv = await must('admin', '/api/v0/account/invites', { rows: [{ email: OWNER, seat: 'leadership' }] });
  report.steps.push({ invite: inv.rows.map((r) => ({ status: r.status, seat: r.seat, mailed: r.mailed })) });
  eq(inv.rows[0].status, 'created', JSON.stringify(inv.rows[0]));
  const link = linkIn(OWNER) ?? inv.rows[0].link?.split('#')[1];
  ok(link, 'the invitation link reached the owner (mail sink)');
  const peek = await must(null, '/api/v0/auth/join-peek', { token: link });
  report.steps.push({ peek: { seat: peek.seat, hasAccount: peek.hasAccount } });
  const s = await must(null, '/api/v0/auth/join', { token: link, name: 'Synthetic Owner', password: PASSWORD });
  report.steps.push({ join: { waiting: !!s.waiting, org: s.org === home, home: s.home ?? null } });
  ok(!s.waiting && s.token, `the owner is in at once (not waiting for HR): ${JSON.stringify({ waiting: s.waiting, message: s.message })}`);
  const me = await must({ token: s.token }, '/api/v0/me');
  report.steps.push({ me: { samePerson: me.person === owner, role: me.role } });
  eq(me.person, owner, 'joined onto the existing record (its roles, history and pay data), not a new person');
  ok(['admin', 'leadership'].includes(me.role), `admin or leadership: ${me.role}`);
  // Finance and payroll open for them, with no extra grant and no sheet.
  const book = await call({ token: s.token }, '/api/v0/finance/entries');
  report.steps.push({ financeEntries: book.status });
  eq(book.status, 200, `the cash book opens: ${JSON.stringify(book.data).slice(0, 200)}`);
  const pay = await call({ token: s.token }, '/api/v0/comp/payroll');
  report.steps.push({ payrollRuns: pay.status });
  eq(pay.status, 200, `payroll runs open: ${JSON.stringify(pay.data).slice(0, 200)}`);
  const guide = (await must({ token: s.token }, '/api/v0/account/onboarding')).guide;
  report.steps.push({ guide: guide ? { lead: guide.lead, seat: guide.seat?.key, items: guide.items?.map((i) => i.key) } : null });
} finally {
  report.checks = checks;
  if (process.env.TEST_REPORT) await writeFile(process.env.TEST_REPORT, JSON.stringify(report));
  console.log(JSON.stringify(report));
  await Promise.race([Promise.all([app.close(), pool.end()]).catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
}
process.exit(0);
