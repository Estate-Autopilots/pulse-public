// PORTAL-2 acceptance (db/migrations/1066_client_portal_2.sql; client-signin.ts, client-space.ts, client-mail.ts), in this
// process against a database where 1020 and 1066 are applied, with fake clients only and every e-mail in the sink
// (PULSE_AUTH_MAIL_MODE=sink): nothing is sent anywhere.
//   1. A fake client record is invited and its contact joins (CLIENT-PORTAL's flow).
//   2. Sign-in without friction: forgot password and a one-time sign-in link for the account (neutral answers, client
//      sender with the company's name and Reply-To, one use, a newer link replaces the older, three an hour, staff
//      accounts refused), a new address confirmed by a link.
//   3. Creatives: the team uploads a picture in parts and shares it; the client sees it in their space and bell, streams
//      it (ranges), pins comments, asks for changes (the owner gets a task with the comments and a notice); a second
//      version (a link); the old version can no longer be answered; the client approves; another client sees nothing.
//   4. Paying: refused while off; Finance switches it on with UPI; an issued invoice reaches the client's bell; the
//      client says they paid with a proof (Finance's task and notice); a second claim for it is refused; Finance
//      records it (the invoice is paid, the client is told); a second invoice's claim is answered "not received".
//   5. The client's bell shows a team message from their group; preferences (tour, daily digest) and the digest mail.
//
// On pulse-dev's database:  set -a; source /etc/estate-autopilots/db/pulse_dev.env; set +a
//   PULSE_AUTH_MAIL_MODE=sink CP_OWNER=user-668d21b6@estateautopilots.com node services/api/test/portal-2-runner.mjs
// In the core suite (tests/core/test_client_portal_2.py): the synthetic world (TEST_* variables); its admin makes the fake
// client records, Kedab (leadership, given the Finance role there) does the rest.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { testMail } from '../dist/auth-mail.js';
import { drainClientDigest, clientMailFrom } from '../dist/client-mail.js';
import { apiPoolConfig } from '../dist/database.js';
import { installationFor } from '../dist/installation.js';

process.env.PULSE_AUTH_MAIL_MODE ??= 'sink';
assert.equal(process.env.PULSE_AUTH_MAIL_MODE, 'sink', 'this runner only ever uses the mail sink');
const CI = !!process.env.TEST_API_CONFIG;
const OWNER = CI ? `kedab@${process.env.TEST_DOMAIN}` : process.env.CP_OWNER ?? 'user-668d21b6@estateautopilots.com';
const ADMIN = CI ? `admin@${process.env.TEST_DOMAIN}` : OWNER;
const pool = new Pool(CI ? JSON.parse(process.env.TEST_API_CONFIG) : apiPoolConfig());
const app = CI ? createApp(pool, pool) : createApp(pool, pool, undefined, installationFor(pool));
await app.ready();
const run = Date.now().toString(36).slice(-5);
const PASSWORD = 'Portal-two-test-9', NEW_PASSWORD = 'Portal-two-new-77';
let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); }, eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const step = (s) => console.log(`· ${s}`);
let ip = 0;
const call = async (who, url, payload, extra = {}) => {
  const headers = { 'x-pulse-client-ip': `10.43.${run.length}.${(ip++ % 250) + 1}`, 'user-agent': 'portal-2-runner Chrome on Linux', ...(CI ? {} : { 'x-pulse-host': 'localhost:3200' }), ...extra };
  if (who === 'owner' || who === 'admin') headers['cf-access-authenticated-user-email'] = who === 'admin' ? ADMIN : OWNER;
  else if (who?.token) headers['x-pulse-session'] = who.token;
  const r = await app.inject({ url, method: payload === undefined ? 'GET' : 'POST', headers, ...(payload === undefined ? {} : { payload }) });
  const type = r.headers['content-type'] ?? '';
  return { status: r.statusCode, data: String(type).includes('json') ? r.json() : r.rawPayload, headers: r.headers };
};
const must = async (who, url, payload, extra) => { const r = await call(who, url, payload, extra); if (r.status >= 300) throw new Error(`${url}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const mailTo = (to, subject) => testMail.filter((m) => m.to === to && (!subject || m.title.includes(subject)));
const tokenOf = (m) => new URL(m.body.match(/https?:\/\/\S+/)[0]).hash.slice(1);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const notices = async (who) => (await must(who, '/api/v0/notifications')).rows;
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1048576 + 4096, 7)]); // two parts, PNG signature

try {
  // ------------------------------------------------------------------------------------------- 1. a client joins
  step('a fake client joins');
  const made = [];
  for (const n of ['Esha', 'Farah']) {
    const client = await must('admin', '/api/v0/clients', { displayName: `${n} Fake Estates (fake ${run})`, clientType: 'developer' });
    const contact = await must('admin', '/api/v0/contacts', { name: `${n} Fakewala ${run}`, contactType: 'developer', clientId: client.id });
    const inv = (await must('owner', '/api/v0/client-access/invite', { clientIds: [client.id], contactId: contact.id })).results[0];
    const handle = `${n.toLowerCase()}${run}`.slice(0, 20);
    const email = `${n.toLowerCase()}.${run}@example.test`;
    const joined = await must(null, '/api/v0/auth/connect-join', { token: inv.link.split('#')[1], name: `${n} Fakewala ${run}`, handle, email, password: PASSWORD,
      mode: 'new', orgName: `${n} Fake Estates ${run}`, orgHandle: `${n.toLowerCase()}est${run}`, history: 'no' });
    made.push({ client: client.id, handle, email, seat: { token: joined.token } });
  }
  const [E, F] = made;
  const home0 = await must(E.seat, '/api/v0/client-portal');
  ok(Array.isArray(home0.deliverables) && home0.pay === null && home0.prefs.tourDone === false, 'the space carries deliverables, no paying yet, the tour not seen');
  eq(home0.account.email, E.email, 'their account address');

  // ------------------------------------------------------------------------------------------- 2. sign-in
  step('forgot password and sign-in links');
  let before = testMail.length;
  const forgot = await must(null, '/api/v0/auth/account-forgot', { login: E.handle });
  const nobody = await must(null, '/api/v0/auth/account-forgot', { login: `nobody${run}` });
  eq(forgot, nobody, 'the same answer whether or not an account matches');
  await wait(200);
  const reset = mailTo(E.email, 'Choose a new Pulse password').at(-1);
  ok(reset, 'the reset link went to the account address');
  eq(testMail.length, before + 1, 'and nothing for the unknown login');
  ok(reset.from === clientMailFrom() && !/^hr@/i.test(reset.from), 'from the client sender, not the HR mailbox');
  ok(reset.fromName && reset.fromName.length > 1, 'named after the company');
  ok(/\/login\/account-reset#[A-Za-z0-9_-]{43}$/m.test(reset.body), 'the link opens the reset page with the token in the fragment');
  eq((await call(null, '/api/v0/auth/account-reset', { token: tokenOf(reset), password: 'short' })).status, 400, 'a weak password is refused');
  const r1 = await must(null, '/api/v0/auth/account-reset', { token: tokenOf(reset), password: NEW_PASSWORD });
  ok(r1.token && r1.home === '/client', 'a new password signs them in to their space');
  eq((await call(null, '/api/v0/auth/account-reset', { token: tokenOf(reset), password: NEW_PASSWORD })).status, 400, 'the link works once');
  eq((await call(null, '/api/v0/auth/account-sign-in', { login: E.handle, password: PASSWORD })).status, 401, 'the old password no longer works');
  eq((await call(E.seat, '/api/v0/client-portal')).status, 401, 'their other sessions ended');
  E.seat = { token: (await must(null, '/api/v0/auth/account-sign-in', { login: E.handle, password: NEW_PASSWORD })).token };
  ok(E.seat.token, 'the new password signs in');

  await must(null, '/api/v0/auth/account-link', { login: E.email });
  await wait(150);
  const link1 = mailTo(E.email, 'sign-in link').at(-1);
  ok(link1 && /\/login\/account-link#/.test(link1.body) && /15 minutes/.test(link1.body), 'a one-time sign-in link, 15 minutes');
  await must(null, '/api/v0/auth/account-link', { login: E.handle });
  await wait(150);
  const link2 = mailTo(E.email, 'sign-in link').at(-1);
  ok(link2 !== link1, 'a second link');
  eq((await call(null, '/api/v0/auth/account-link-sign-in', { token: tokenOf(link1) })).status, 400, 'the newer link replaced the older one');
  const s2 = await must(null, '/api/v0/auth/account-link-sign-in', { token: tokenOf(link2) });
  ok(s2.token && s2.kind === 'client', 'the link signs them in');
  eq((await call(null, '/api/v0/auth/account-link-sign-in', { token: tokenOf(link2) })).status, 400, 'once');
  before = testMail.length;
  await must(null, '/api/v0/auth/account-link', { login: E.handle });
  await wait(150);
  eq(testMail.length, before, 'no more than three links an hour per account (the answer stays the same)');
  ok((await call(null, '/api/v0/auth/account-link', { login: 'x' })).status === 200, 'still a neutral answer');

  step('a new address, confirmed by a link');
  const newMail = `esha.new.${run}@example.test`;
  const change = await must(E.seat, '/api/v0/client-portal/email', { email: newMail });
  eq(change.pending, newMail, 'a confirmation is on its way');
  const confirm = mailTo(newMail, 'Confirm your e-mail').at(-1);
  ok(confirm, 'to the new address');
  eq((await must(E.seat, '/api/v0/client-portal')).account.email, E.email, 'nothing changes until it is used');
  eq((await must(null, '/api/v0/auth/account-confirm', { token: tokenOf(confirm) })).email, newMail, 'confirmed');
  const acc = (await must(E.seat, '/api/v0/client-portal')).account;
  ok(acc.email === newMail && acc.confirmed, 'their address is the new one, confirmed');
  E.email = newMail;

  // ------------------------------------------------------------------------------------------- 3. creatives
  step('creatives for approval');
  eq((await call(E.seat, `/api/v0/clients/${E.client}/deliverables`)).status, 403, 'the team side is closed to a client');
  const up = await must('owner', '/api/v0/client-files', { clientId: E.client, name: `poster-fake-${run}.png`, mime: 'image/png', size: PNG.length });
  eq(up.parts, 2, 'a file in 1 MiB parts');
  eq((await call('owner', `/api/v0/client-files/${up.id}/parts/0`, { data: PNG.subarray(0, 1000).toString('base64') })).status, 400, 'a part of the wrong size is refused');
  await must('owner', `/api/v0/client-files/${up.id}/parts/0`, { data: PNG.subarray(0, 1048576).toString('base64') });
  eq((await call('owner', `/api/v0/clients/${E.client}/deliverables`, { title: 'Poster (fake)', fileId: up.id })).status, 400, 'not shared before the file is complete');
  ok((await must('owner', `/api/v0/client-files/${up.id}/parts/1`, { data: PNG.subarray(1048576).toString('base64') })).complete, 'complete with the last part');
  eq((await call('owner', '/api/v0/client-files', { clientId: E.client, name: 'x.exe', mime: 'application/x-msdownload', size: 10 })).status, 400, 'only creative file types');
  const shared = await must('owner', `/api/v0/clients/${E.client}/deliverables`, { title: `Launch poster (fake ${run})`, fileId: up.id, note: 'First look (fake).' });
  const list = await must('owner', `/api/v0/clients/${E.client}/deliverables`);
  ok(list.onPulse && list.items.some((d) => d.id === shared.id && d.state === 'waiting'), 'the team sees it waiting');
  let space = await must(E.seat, '/api/v0/client-portal');
  const dE = space.deliverables.find((d) => d.id === shared.id);
  ok(dE && dE.state === 'waiting' && dE.versions[0].fileId === up.id, 'the client sees it in their space');
  ok((await notices(E.seat)).some((n) => n.eventType === 'client.delivery' && n.href === `/client/review/${shared.id}`), 'and in their bell');
  const whole = await call(E.seat, `/api/v0/client-portal/files/${up.id}`);
  ok(whole.status === 200 && Buffer.compare(Buffer.from(whole.data), PNG) === 0, 'the file streams back exactly');
  const part = await call(E.seat, `/api/v0/client-portal/files/${up.id}`, undefined, { range: 'bytes=1048570-1048580' });
  ok(part.status === 206 && Buffer.compare(Buffer.from(part.data), PNG.subarray(1048570, 1048581)) === 0 && /^bytes 1048570-1048580\//.test(part.headers['content-range']), 'a range across two parts');
  eq((await call(F.seat, `/api/v0/client-portal/files/${up.id}`)).status, 404, 'another client cannot open it');
  eq((await call(F.seat, `/api/v0/client-portal/deliverables/${shared.id}`)).status, 404, 'nor see it');
  ok(!(await must(F.seat, '/api/v0/client-portal')).deliverables.length, 'their space has none');

  const opened = await must(E.seat, `/api/v0/client-portal/deliverables/${shared.id}`);
  ok(opened.provider && opened.me && opened.versions.length === 1 && opened.taskId == null && opened.seenAt == null && opened.client == null, 'the review page names the company and them, without team-only fields');
  const c1 = await must(E.seat, `/api/v0/client-portal/deliverables/${shared.id}/comments`, { body: 'Logo bigger here (fake).', x: 0.2, y: 0.3 });
  await must(E.seat, `/api/v0/client-portal/deliverables/${shared.id}/comments`, { body: 'Warmer colours overall (fake).' });
  eq((await call(E.seat, `/api/v0/client-portal/deliverables/${shared.id}/comments`, { body: 'x', x: 0.2 })).status, 400, 'a pin needs both coordinates');
  const seen = await must('owner', `/api/v0/client-deliverables/${shared.id}`);
  ok(seen.seenAt && seen.comments.length === 2 && seen.comments[0].x === 0.2, 'the team sees it opened and the pinned comment');
  await must('owner', `/api/v0/client-deliverables/${shared.id}/comments`, { body: 'On it (fake).' });
  const asked = await must(E.seat, `/api/v0/client-portal/deliverables/${shared.id}/answer`, { version: 1, decision: 'changes', note: '' });
  ok(asked.taskId, 'asking for changes (the pinned comments say what) makes a task');
  const team = await must('owner', `/api/v0/client-deliverables/${shared.id}`);
  eq(team.state, 'changes', 'the team sees changes asked');
  eq(team.taskId, asked.taskId, 'with the task');
  const task = await must('owner', `/api/v0/tasks/${asked.taskId}`);
  const notes = JSON.stringify(task);
  ok(notes.includes('Logo bigger here') && notes.includes('pinned on the picture') && notes.includes('asked for changes'), 'the task carries the pinned comments');
  ok((await notices('owner')).some((n) => n.eventType === 'client.changes' && n.subjectId === shared.id), "the owner's notice");
  eq((await call(E.seat, `/api/v0/client-portal/deliverables/${shared.id}/answer`, { version: 1, decision: 'approved' })).status, 400, 'answered once');

  const v2 = await must('owner', `/api/v0/client-deliverables/${shared.id}/versions`, { url: 'https://drive.google.com/file/d/1FakeFakeFakeFake/view', versionNote: 'Bigger logo (fake).' });
  eq(v2.version, 2, 'a second version');
  eq((await call(E.seat, `/api/v0/client-portal/deliverables/${shared.id}/answer`, { version: 1, decision: 'approved' })).status, 400, 'version 1 can no longer be answered');
  const appr = await must(E.seat, `/api/v0/client-portal/deliverables/${shared.id}/answer`, { version: 2, decision: 'approved', name: `Esha Fakewala ${run}` });
  eq(appr.decision, 'approved', 'version 2 approved');
  const done = await must('owner', `/api/v0/client-deliverables/${shared.id}`);
  ok(done.state === 'approved' && done.versions.length === 2 && done.versions[1].decision === 'changes', 'the history keeps both versions and their answers');
  ok((await notices('owner')).some((n) => n.eventType === 'client.approved' && n.subjectId === shared.id), 'the owner is told it is approved');
  space = await must(E.seat, '/api/v0/client-portal');
  ok(space.timeline.some((e) => e.kind === 'decision' && e.text.includes('approved')), 'the timeline says so');
  const extra = await must('owner', `/api/v0/clients/${E.client}/deliverables`, { title: `Withdrawn reel (fake ${run})`, url: 'https://youtu.be/FakeFake123' });
  await must('owner', `/api/v0/client-deliverables/${extra.id}/withdraw`, {});
  ok(!(await must(E.seat, '/api/v0/client-portal')).deliverables.some((d) => d.id === extra.id), 'a withdrawn one leaves their space');

  // ------------------------------------------------------------------------------------------- 4. paying
  step('paying');
  if (CI) await must('owner', '/api/v0/erp/settings', { company: { legalName: 'Fake Agency Pvt Ltd (fake)', gstin: '27AABCS5678K1ZS', stateCode: '27' } });
  const settings0 = await must('owner', '/api/v0/erp/client-payments');
  const items = (await must('owner', '/api/v0/erp/items')).items ?? [];
  const makeInvoice = async (client, rupees) => {
    const d = await must('owner', '/api/v0/erp/documents', { docType: 'invoice', clientId: client });
    const today = new Date().toISOString().slice(0, 10);
    await must('owner', `/api/v0/erp/documents/${d.id}`, { issueDate: today, buyer: { name: `Esha Fake Estates ${run}`, stateCode: '27' }, placeOfSupply: '27',
      lines: [{ description: 'Creative retainer (fake)', qty: 1, rate: rupees * 100, gstRate: 18 }] });
    await must('owner', `/api/v0/erp/documents/${d.id}/issue`, {});
    return d.id;
  };
  void items;
  const inv1 = await makeInvoice(E.client, 10000);
  space = await must(E.seat, '/api/v0/client-portal');
  const i1 = space.invoices.find((i) => i.id === inv1);
  ok(i1 && i1.balance > 0, 'the issued invoice is in their space');
  ok((await notices(E.seat)).some((n) => n.eventType === 'client.invoice' && n.subjectId === inv1), 'and their bell');
  eq((await call(E.seat, '/api/v0/client-portal/pay', { documentId: inv1, amount: i1.balance, paidOn: new Date().toISOString().slice(0, 10), method: 'upi' })).status, 400, 'refused while paying is off');
  eq((await call('owner', '/api/v0/erp/client-payments', { enabled: true })).status, 400, 'switching on needs UPI or the bank account');
  eq((await call('owner', '/api/v0/erp/client-payments', { enabled: true, upi: 'not-a-upi' })).status, 400, 'a UPI ID looks like name@bank');
  const settings = await must('owner', '/api/v0/erp/client-payments', { enabled: true, upi: `fakeagency${run}@okfake`, payee: 'Fake Agency', bank: { accountNumber: '000111222333', ifsc: 'EXMP0001234', accountName: 'Fake Agency' } });
  ok(settings.enabled && settings.upi === `fakeagency${run}@okfake`, 'Finance switches it on');
  eq((await call(E.seat, '/api/v0/erp/client-payments')).status, 403, 'the settings are closed to a client');
  space = await must(E.seat, '/api/v0/client-portal');
  ok(space.pay?.upi === `fakeagency${run}@okfake` && space.pay.bank.ifsc === 'EXMP0001234', 'the client sees how to pay');

  const pf = await must(E.seat, '/api/v0/client-portal/files', { name: 'payment-screenshot.png', mime: 'image/png', size: 64 });
  await must(E.seat, `/api/v0/client-portal/files/${pf.id}/parts/0`, { data: PNG.subarray(0, 64).toString('base64') });
  eq((await call(E.seat, '/api/v0/client-portal/files', { name: 'big.png', mime: 'image/png', size: 20 * 1048576 })).status, 400, 'a proof is at most 10 MB');
  const paidOn = new Date().toISOString().slice(0, 10);
  eq((await call(E.seat, '/api/v0/client-portal/pay', { documentId: inv1, amount: i1.balance + 100, paidOn, method: 'upi' })).status, 400, 'not more than the balance');
  const claim = await must(E.seat, '/api/v0/client-portal/pay', { documentId: inv1, amount: i1.balance, paidOn, method: 'upi', reference: `UTRFAKE${run}`, proofFileId: pf.id });
  ok(claim.id, '"I\'ve paid" is recorded');
  eq((await call(E.seat, '/api/v0/client-portal/pay', { documentId: inv1, amount: 100, paidOn, method: 'upi' })).status, 409, 'a second claim waits for the first');
  const claims = (await must('owner', `/api/v0/erp/documents/${inv1}/payment-claims`)).claims;
  ok(claims.length === 1 && claims[0].state === 'waiting' && claims[0].taskId && claims[0].proofFileId === pf.id, 'Finance sees it with its task and the proof');
  const checkTask = await must('owner', `/api/v0/tasks/${claims[0].taskId}`);
  ok(JSON.stringify(checkTask).includes(`UTRFAKE${run}`), 'the check task carries the reference');
  ok((await call('owner', `/api/v0/client-files/${pf.id}`)).status === 200, 'Finance opens the proof');
  eq((await call(F.seat, `/api/v0/client-portal/files/${pf.id}`)).status, 404, 'another client cannot');
  const conf = await must('owner', `/api/v0/erp/payment-claims/${claim.id}`, { decision: 'confirmed' });
  eq(conf.state, 'confirmed', 'Finance records it');
  eq((await call('owner', `/api/v0/erp/payment-claims/${claim.id}`, { decision: 'not_received', note: 'x' })).status, 400, 'answered once');
  space = await must(E.seat, '/api/v0/client-portal');
  ok(space.invoices.find((i) => i.id === inv1)?.balance === 0, 'the invoice is paid in their space');
  ok((await notices(E.seat)).some((n) => n.eventType === 'client.payment' && n.title.startsWith('Payment received')), 'they are told it arrived');

  const inv2 = await makeInvoice(E.client, 2500);
  const claim2 = await must(E.seat, '/api/v0/client-portal/pay', { documentId: inv2, amount: 100000, paidOn, method: 'bank', reference: `NEFTFAKE${run}` });
  eq((await call('owner', `/api/v0/erp/payment-claims/${claim2.id}`, { decision: 'not_received' })).status, 400, '"not received" needs a word for the client');
  await must('owner', `/api/v0/erp/payment-claims/${claim2.id}`, { decision: 'not_received', note: 'Not in the bank yet (fake).' });
  space = await must(E.seat, '/api/v0/client-portal');
  ok(space.claims.some((c) => c.id === claim2.id && c.state === 'not_received' && c.decidedNote.includes('Not in the bank')), 'the client sees what Finance found');
  if (!settings0.enabled) await must('owner', '/api/v0/erp/client-payments', { ...settings0, enabled: false });

  // ------------------------------------------------------------------------------------------- 5. bell, prefs, digest
  step('bell, preferences, digest');
  const group = await must(E.seat, '/api/v0/client-portal/chat', {});
  await must('owner', `/api/v0/chats/${group.id}/messages`, { body: `Hello from the team (fake ${run})`, clientId: crypto.randomUUID() });
  ok((await notices(E.seat)).some((n) => n.eventType === 'chat.message' && n.href.includes(group.id)), "a team message reaches the client's bell");
  ok(!(await notices(F.seat)).some((n) => n.href.includes(group.id)), 'not another client');
  eq((await must(E.seat, '/api/v0/client-portal/prefs', { tourDone: true })).prefs.tourDone, true, 'the tour is seen once');
  eq((await must(E.seat, '/api/v0/client-portal/prefs', { digest: true })).prefs.digest, true, 'the daily summary is on');
  const hour = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }));
  if (CI) console.log('  (digest check skipped: it serves the installation\'s own company only)');
  else if (hour >= 9) {
    before = testMail.length;
    const sent = await drainClientDigest(pool, 'http://localhost:3200');
    ok(sent.sent >= 1, 'the digest goes out');
    const digest = testMail.slice(before).find((m) => m.to === E.email);
    ok(digest && /new things in your space|Payment received|Hello|shared/.test(digest.subject + digest.body) && digest.body.includes('/client?digest=off'), 'with what is new and how to turn it off');
    const again = await drainClientDigest(pool, 'http://localhost:3200');
    ok(!testMail.slice(before + sent.sent).some((m) => m.to === E.email) || again.sent === 0, 'once a day');
  } else console.log('  (digest check skipped: it runs after 09:00 company time)');
  eq((await must(E.seat, '/api/v0/client-portal/prefs', { digest: false })).prefs.digest, false, 'and off again');

  step('staff accounts keep their organisation recovery');
  before = testMail.length;
  await must(null, '/api/v0/auth/account-link', { login: OWNER });
  await wait(150);
  eq(testMail.slice(before).filter((m) => m.title.includes('sign-in link')).length, 0, 'no account sign-in link for a staff account');

  const report = { ok: true, checks, run, clients: made.map((m) => m.client), realEmailsSent: 0 };
  if (process.env.TEST_REPORT) await writeFile(process.env.TEST_REPORT, JSON.stringify(report));
  console.log(JSON.stringify(report));
} finally { await app.close(); await pool.end(); }
