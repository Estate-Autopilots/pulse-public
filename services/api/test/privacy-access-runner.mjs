// PRIVACY (owner, 2 Nov 2026: "who sees what"): the visibility matrix through the API, one real password session per
// seat (tests/core/test_privacy_access.py builds the world). Every expectation is written out, the refusals as firmly as
// what is shown; all failures are listed together before the run fails.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const seat = JSON.parse(process.env.TEST_SEATS), P = JSON.parse(process.env.TEST_PROJECTS), T = JSON.parse(process.env.TEST_TASKS);
const SEATS = ['leadership', 'admin', 'hr', 'manager', 'staff', 'freelancer', 'client'];
const tokens = {}, problems = [];
let checks = 0;
const call = async (url, token, payload, method = payload ? 'POST' : 'GET') => {
  const r = await app.inject({ url, method, headers: { 'x-pulse-client-ip': crypto.randomUUID(), ...(token ? { 'x-pulse-session': token } : {}) }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const expect = (label, actual, wanted) => { checks++; try { assert.deepEqual(actual, wanted); } catch { problems.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`); } };
const status = async (s, url, wanted, payload) => { const r = await call(url, tokens[s], payload); expect(`${s} ${payload ? 'POST' : 'GET'} ${url}${r.status !== wanted ? ' (' + JSON.stringify(r.data).slice(0, 160) + ')' : ''}`, r.status, wanted); return r; };

await app.ready();
// Phase "sign-in": every seat signs in (as staff) and keeps its session; the test then makes two of them a freelancer
// and a client, and phase "check" runs the matrix with those sessions.
if (process.env.TEST_PHASE === 'sign-in') {
  for (const s of SEATS) {
    const r = await call('/api/v0/auth/sign-in', null, { username: 'synthetic.' + s, password: 'Synthetic-issued-2026!' });
    assert.equal(r.status, 200, s + ' sign-in: ' + JSON.stringify(r.data)); tokens[s] = r.data.token;
    assert.equal((await call('/api/v0/auth/change-password', tokens[s], { current: 'Synthetic-issued-2026!', next: 'Synthetic-final-2026!' })).status, 200, s + ' password');
  }
  writeFileSync(process.env.TEST_TOKENS, JSON.stringify(tokens));
  await app.close(); await pool.end(); process.exit(0);
}
Object.assign(tokens, JSON.parse(readFileSync(process.env.TEST_TOKENS, 'utf8')));
for (const s of SEATS) assert.equal((await call('/api/v0/me', tokens[s])).status, 200, s + ' session');

// 1. Projects by visibility: who finds and opens each one.
const sees = {
  org: ['leadership', 'admin', 'hr', 'manager', 'staff', 'freelancer'],
  members: ['admin', 'staff'],
  leadership: ['leadership', 'admin', 'manager'],
};
for (const s of SEATS) {
  const list = await call('/api/v0/projects?scope=all', tokens[s]);
  const work = await call('/api/v0/work/projects?show=all', tokens[s]);
  if (s === 'client') { expect('client projects list', list.status, 403); expect('client work projects', work.status, 403); }
  for (const [vis, id] of Object.entries(P)) {
    const ok = sees[vis].includes(s);
    if (s !== 'client' && list.status === 200) expect(`${s} finds the ${vis} project in Projects`, list.data.projects?.some((x) => x.projectId === id), ok);
    if (s !== 'client') expect(`${s} finds the ${vis} project in Work`, work.data.rows?.some((x) => x.id === id), ok);
    if (s !== 'client' && list.status === 200) await status(s, `/api/v0/projects/${id}`, ok ? 200 : 404);
    await status(s, `/api/v0/tasks/projects/${id}`, s === 'client' ? 404 : ok ? 200 : 404);
  }
}
// The freelancer's Work list is exactly their project; a staff seat still sees every org project (today's behaviour).
{
  const fw = await call('/api/v0/work/projects?show=all', tokens.freelancer);
  expect('freelancer Work lists only their project', fw.data.rows?.map((x) => x.id), [P.org]);
}

// 2. Tasks inside them, and a leadership-only task.
const taskSees = {
  org_free: ['leadership', 'admin', 'hr', 'freelancer'],   // the freelancer's own task (staff and manager follow the usual team rule: not asserted)
  mem: ['admin', 'staff'],                                // members-only project: its members and admins; not the staff seat's manager
  mem_outsider: ['admin', 'staff'],                       // done by someone outside it (not a seat): a member still sees it
  lead_proj: ['leadership', 'admin', 'manager'],
  lead_only: ['leadership', 'admin'],
  free_own: ['leadership', 'admin', 'hr', 'freelancer'],
};
for (const s of SEATS) for (const [key, who] of Object.entries(taskSees)) {
  const r = await call(`/api/v0/tasks/${T[key]}`, tokens[s]);
  // Only the seats that see a task may open it; whether a staff seat outside sees an org task follows the usual team rule.
  if (who.includes(s)) expect(`${s} opens task ${key}`, r.status, 200);
  else if (!(key === 'org_free' && ['manager', 'staff'].includes(s))) expect(`${s} cannot open task ${key}`, r.status, 404);
}
{
  const r = await call(`/api/v0/tasks/${T.lead_only}`, tokens.leadership);
  expect('leadership-only task says who sees it', r.data.task?.visibleTo, 'Leadership, admins and the people on this task');
  expect('leadership may restrict a task', r.data.can?.restrict, true);
  const m = await call(`/api/v0/tasks/${T.mem}`, tokens.staff);
  expect('members-only project task says who sees it', m.data.task?.visibleTo, 'The project’s members, admins and the people on this task');
  expect('staff may not restrict a task', m.data.can?.restrict, false);
  const w = await call(`/api/v0/tasks/projects/${P.members}`, tokens.staff);
  expect('members project page says who sees it', w.data.work?.visibleTo, 'Its members and admins');
  expect('a project member of a members-only project sees its time on the task', (await call(`/api/v0/tasks/${T.mem}`, tokens.admin)).data.time?.length, 1);
}

// 3. The freelancer's seat: their work only; no directory, company figures, Finance, HR or leadership.
for (const url of ['/api/v0/people', '/api/v0/money', '/api/v0/hr/payroll', '/api/v0/insights', '/api/v0/clients', '/api/v0/projects/health', '/api/v0/search?q=synthetic',
  `/api/v0/people/${seat.staff}`, `/api/v0/projects/${P.org}/research`, '/api/v0/sales-xray/synced-leads', '/api/v0/work/dashboard', '/api/v0/my-week', '/api/v0/intelligence'])
  await status('freelancer', url, 403);
// (Chats and the person page answer a staff account only, in the database, before and after this change.)
for (const url of ['/api/v0/me', '/api/v0/tasks?mine=1', '/api/v0/time', '/api/v0/work/asks', '/api/v0/work/list?scope=mine', `/api/v0/tasks/projects/${P.org}`])
  await status('freelancer', url, 200);
expect('freelancer gets no staff directory in task options', (await call('/api/v0/tasks/options', tokens.freelancer)).data.reviewers, []);
expect('freelancer task options list only their project', (await call('/api/v0/tasks/options', tokens.freelancer)).data.projects?.map((x) => x.id), [P.org]);
// … while staff keep theirs.
await status('staff', '/api/v0/people', 200);
await status('client', '/api/v0/people', 403);

// 4. Sales reps: their own calls and leads; their manager and leadership see them; the team's totals for everyone.
const titles = async (s, person) => ((await call(`/api/v0/sales-xray/linked?person=${person}`, tokens[s])).data.calls ?? []).map((c) => c.title).sort();
expect('rep sees own calls', await titles('staff', seat.staff), ['Synthetic call staff']);
expect('rep does not see another rep\'s calls', await titles('staff', process.env.TEST_REP_B), []);
expect('manager sees their rep\'s calls', await titles('manager', seat.staff), ['Synthetic call staff']);
expect('manager does not see another team\'s rep', await titles('manager', process.env.TEST_REP_B), []);
expect('leadership sees every rep', await titles('leadership', process.env.TEST_REP_B), ['Synthetic call rep_b']);
expect('HR does not read sales calls', await titles('hr', seat.staff), []);
const leads = async (s) => ((await call('/api/v0/sales-xray/synced-leads', tokens[s])).data.leads ?? []).map((l) => l.name).sort();
expect('rep sees own leads', await leads('staff'), ['Synthetic lead staff']);
expect('manager sees the team\'s leads', await leads('manager'), ['Synthetic lead staff']);
expect('leadership sees all leads', await leads('leadership'), ['Synthetic lead rep_b', 'Synthetic lead staff']);
const board = await call('/api/v0/sales-xray/sync', tokens.staff);
expect('team board shows the company total to a rep', board.data.stages?.reduce((n, x) => n + x.n, 0), 2);

// 5. Changing who sees what.
await status('staff', `/api/v0/tasks/${T.mem}`, 403, { leadershipOnly: true });
await status('leadership', `/api/v0/tasks/${T.org_other}`, 200, { leadershipOnly: true });
await status('hr', `/api/v0/tasks/${T.org_other}`, 404);
await status('admin', `/api/v0/tasks/${T.org_other}`, 200);
await status('leadership', `/api/v0/tasks/${T.org_other}`, 200, { leadershipOnly: false });
await status('hr', `/api/v0/tasks/${T.org_other}`, 200);
await status('staff', `/api/v0/work/projects/${P.members}`, 403, { visibility: 'leadership' });
await status('manager', `/api/v0/work/projects/${P.leadership}`, 403, { visibility: 'org' });
await status('leadership', `/api/v0/work/projects/${P.org}`, 400, { visibility: 'nobody' });
const made = await call('/api/v0/work/projects', tokens.leadership, { type: 'internal', name: 'Synthetic private launch', visibility: 'members' });
expect('leadership creates a members-only project', made.status, 200);
if (made.data?.id) {
  await status('leadership', `/api/v0/tasks/projects/${made.data.id}`, 200);
  await status('hr', `/api/v0/tasks/projects/${made.data.id}`, 404);
  await status('staff', `/api/v0/tasks/projects/${made.data.id}`, 404);
  await status('admin', `/api/v0/tasks/projects/${made.data.id}`, 200);
  expect('its page says who sees it', (await call(`/api/v0/tasks/projects/${made.data.id}`, tokens.leadership)).data.work?.visibility, 'members');
  await status('leadership', `/api/v0/work/projects/${made.data.id}`, 200, { visibility: 'org' });
  await status('staff', `/api/v0/tasks/projects/${made.data.id}`, 200);
}

await app.close(); await pool.end();
if (problems.length) { console.error(`${problems.length} of ${checks} privacy checks failed:\n` + problems.join('\n')); process.exit(1); }
console.log(`privacy matrix: ${checks} checks passed for ${SEATS.length} seats`);
