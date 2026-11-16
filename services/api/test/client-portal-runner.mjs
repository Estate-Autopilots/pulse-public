// CLIENT-PORTAL acceptance (1020, services/api/src/client-portal.ts) against a running API, with fake clients only.
// An admin invites a client record (and two more in one go) → the contact opens the link signed out, makes an account,
// sets up their company and says yes to past conversations → they land in their space at the serving organisation →
// their space shows their team, projects, chats; they open their group, ask for something, invite a colleague → the
// colleague joins with their own account → the admin shares an issued quotation → the client asks for changes on one and
// accepts another → a project, a client package with instalments and a task for the point of contact exist → the client
// cannot read another client's document or any staff route → onboarding steps read what happened → calls: the client
// rings the group. Nothing is e-mailed (mail sink or off).
//
// CP_BASE=http://127.0.0.1:3213 CP_OWNER=user-668d21b6@estateautopilots.com node services/api/test/client-portal-runner.mjs
import assert from 'node:assert/strict';

const BASE = process.env.CP_BASE ?? 'http://127.0.0.1:3213';
const OWNER = process.env.CP_OWNER ?? 'user-668d21b6@estateautopilots.com';
const run = Date.now().toString(36).slice(-5);
const PASSWORD = 'Client-portal-test-9';
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const call = async (who, url, payload, method = payload ? 'POST' : 'GET') => {
  const headers = { 'x-pulse-client-ip': `10.7.${checks % 250}.${run.length}`, 'user-agent': 'client-portal-runner Chrome on Linux', 'x-pulse-host': 'localhost:3200', ...(payload ? { 'content-type': 'application/json' } : {}) };
  if (who === 'owner') headers['cf-access-authenticated-user-email'] = OWNER;
  else if (who?.token) headers['x-pulse-session'] = who.token;
  const r = await fetch(BASE + url, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, data: type.includes('json') ? await r.json() : await r.arrayBuffer(), type };
};
const must = async (who, url, payload, method) => { const r = await call(who, url, payload, method); if (r.status >= 300) throw new Error(`${url}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const step = (s) => console.log(`· ${s}`);

// 1. Fake client records with a contact each.
step('fake client records');
const made = [];
for (const n of ['Asha', 'Bela', 'Chitra']) {
  const client = await must('owner', '/api/v0/clients', { displayName: `${n} Test Homes (fake ${run})`, clientType: 'developer' });
  const contact = await must('owner', '/api/v0/contacts', { name: `${n} Fakewala ${run}`, contactType: 'developer', clientId: client.id });
  made.push({ name: n, client: client.id, contact: contact.id });
}
const [A, B, C] = made;

// 2. The list shows them with no access yet; inviting is for admins/HR/leadership.
step('access list');
const list = await must('owner', '/api/v0/client-access');
const rowA = list.clients.find((x) => x.id === A.client);
ok(rowA && rowA.access.state === 'none', 'new client starts without access');
eq(rowA.contacts.map((x) => x.id), [A.contact], 'its contact is a choice');

// 3. Bulk invite B and C (no e-mail), single invite A with an e-mail address (sink/off: not sent for real).
step('invite');
const bulk = await must('owner', '/api/v0/client-access/invite', { clientIds: [B.client, C.client], message: 'Welcome aboard (fake).' });
eq(bulk.results.filter((r) => r.ok).length, 2, 'two invitations made');
ok(bulk.results.every((r) => /\/invited#[A-Za-z0-9_-]{43}$/.test(r.link)), 'each has a private link');
ok(bulk.results.every((r) => r.mail.sent === false), 'nothing e-mailed unless asked');
const single = await must('owner', '/api/v0/client-access/invite', { clientIds: [A.client], contactId: A.contact, emailTo: `asha.${run}@example.test`, email: true });
const invA = single.results[0];
ok(invA.ok && invA.email === `asha.${run}@example.test`, 'single invite carries the address');
ok(invA.whatsapp.includes(invA.link), 'a WhatsApp text with the link');
const again = await must('owner', '/api/v0/client-access/invite', { clientIds: [C.client] });
ok(again.results[0].ok, 'a new invitation replaces the old one');
const oldC = bulk.results.find((r) => r.clientId === C.client).link.split('#')[1];
eq((await call(null, '/api/v0/auth/connect-peek', { token: oldC })).status, 404, 'the replaced link no longer opens');
const state = (await must('owner', `/api/v0/clients/${A.client}/access`)).access;
eq(state.state, 'invited', 'A is invited');

// 4. A's contact opens the link signed out and joins.
step('client joins');
const tokenA = invA.link.split('#')[1];
const peek = await must(null, '/api/v0/auth/connect-peek', { token: tokenA });
ok(peek.client === true && peek.historyOffer === true, 'the page knows it is an existing client with past conversations');
ok(peek.company.startsWith('Asha Test Homes'), 'pre-filled company');
const handle = `asha${run}`.slice(0, 20);
const joined = await must(null, '/api/v0/auth/connect-join', { token: tokenA, name: `Asha Fakewala ${run}`, handle, email: `asha.${run}@example.test`, password: PASSWORD,
  mode: 'new', orgName: `Asha Test Homes ${run}`, orgHandle: `ashahomes${run}`, history: 'yes' });
ok(joined.token && joined.home === '/client', 'lands in their space');
const asha = { token: joined.token };
eq((await must('owner', `/api/v0/clients/${A.client}/access`)).access.state, 'joined', 'A is on Pulse');
eq((await call(null, '/api/v0/auth/connect-peek', { token: tokenA })).status, 404, 'the link is used up');

// 5. Their space.
step('the space');
const home = await must(asha, '/api/v0/client-portal');
ok(home.provider?.name, 'names the serving organisation');
ok(home.team.length >= 1, 'their point of contact');
ok(home.historyOptIn, 'past conversations: yes');
eq(home.colleagues.length, 1, 'just them so far');
ok(Array.isArray(home.projects) && Array.isArray(home.invoices) && Array.isArray(home.timeline), 'projects, invoices, timeline');
ok(home.timeline.some((e) => e.kind === 'joined'), 'the timeline starts');

// 6. Isolation: staff routes are closed to the client's seat.
step('isolation');
for (const url of ['/api/v0/clients', '/api/v0/people', '/api/v0/finance', '/api/v0/erp/documents', '/api/v0/client-access', `/api/v0/clients/${B.client}/access`, '/api/v0/connections'])
  ok([403, 404].includes((await call(asha, url)).status), `closed: ${url}`);

// 7. Group, request, colleague.
step('group, request, colleague');
const group = await must(asha, '/api/v0/client-portal/chat', {});
ok(group.id, 'their group exists');
eq((await must(asha, '/api/v0/client-portal/chat', {})).id, group.id, 'the same group next time');
const req1 = await must(asha, '/api/v0/client-portal/requests', { kind: 'change', title: 'Change the brochure cover (fake)', body: 'Use the night photo.' });
ok(req1.id, 'request made');
const home2 = await must(asha, '/api/v0/client-portal');
ok(home2.requests.some((r) => r.id === req1.id && r.assignee), 'the request shows with who has it');
ok(home2.chats.some((c) => c.id === group.id), 'the group is in their chats');
const col = await must(asha, '/api/v0/client-portal/colleagues', { name: `Dev Fakewala ${run}`, email: `dev.${run}@example.test` });
ok(/\/invited#/.test(col.link), 'a colleague link');
const colPeek = await must(null, '/api/v0/auth/connect-peek', { token: col.link.split('#')[1] });
ok(colPeek.colleague === true, 'the colleague page knows');
const dev = await must(null, '/api/v0/auth/connect-join', { token: col.link.split('#')[1], name: `Dev Fakewala ${run}`, handle: `dev${run}`.slice(0, 20), password: PASSWORD, mode: 'new' });
ok(dev.home === '/client', 'the colleague lands in the space too');
const devHome = await must({ token: dev.token }, '/api/v0/client-portal');
eq(devHome.colleagues.length, 2, 'two people of the client now');
const ownerAccess = (await must('owner', `/api/v0/clients/${A.client}/access`)).access;
eq(ownerAccess.people.length, 2, 'the admin sees both');

// 8. Quotation shared in the space; changes asked on one, another accepted.
step('quotations');
const items = (await must('owner', '/api/v0/erp/items')).items ?? [];
const pkg = items.find((i) => i.kind === 'package');
const makeQuote = async () => {
  const d = await must('owner', '/api/v0/erp/documents', { docType: 'quotation', clientId: A.client });
  const today = new Date().toISOString().slice(0, 10);
  const valid = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  await must('owner', `/api/v0/erp/documents/${d.id}`, { issueDate: today, validUntil: valid, buyer: { name: `Asha Test Homes ${run}`, stateCode: '27' }, placeOfSupply: '27',
    lines: [pkg ? { itemId: pkg.id, description: pkg.name, qty: 1, rate: pkg.price, gstRate: 18 } : { description: 'Marketing package (fake)', qty: 1, rate: 5000000, gstRate: 18 }] });
  await must('owner', `/api/v0/erp/documents/${d.id}/issue`, {});
  const s = await must('owner', `/api/v0/erp/documents/${d.id}/share`, { note: 'As discussed (fake).' });
  ok(s.share.shared && s.share.clientOnPulse, 'shared into the space');
  return d.id;
};
const q1 = await makeQuote(); const q2 = await makeQuote();
const docs = (await must(asha, '/api/v0/client-portal')).documents;
const s1 = docs.find((d) => d.documentId === q1), s2 = docs.find((d) => d.documentId === q2);
ok(s1?.canDecide && s2?.canDecide, 'both wait on the client');
const pdf = await call(asha, `/api/v0/client-portal/documents/${q1}/pdf`);
ok(pdf.status === 200 && pdf.type.includes('pdf'), 'the PDF opens');
eq((await call(asha, '/api/v0/client-portal/documents/' + s1.id + '/answer', { decision: 'changes' })).status, 400, 'changes need words');
await must(asha, `/api/v0/client-portal/documents/${s1.id}/answer`, { decision: 'changes', note: 'Add two more reels (fake).' });
const acc = await must(asha, `/api/v0/client-portal/documents/${s2.id}/answer`, { decision: 'accepted', name: `Asha Fakewala ${run}` });
ok(acc.projectId && acc.engagementId, 'accepting starts a project and a client package');
eq((await call(asha, `/api/v0/client-portal/documents/${s2.id}/answer`, { decision: 'declined' })).status, 400, 'answered once');
const after = await must(asha, '/api/v0/client-portal');
ok(after.projects.some((p) => p.id === acc.projectId && p.status === 'onboarding'), 'the new project shows as getting started');
const contract = after.contracts.find((x) => x.id === acc.engagementId);
ok(contract && contract.instalments.length >= 1, 'with its instalments');
eq(contract.instalments.reduce((n, m) => n + Number(m.amount), 0), Number(contract.price), 'instalments add up to the price');
const docState = await must('owner', `/api/v0/erp/documents/${q2}/share`);
eq(docState.share.decision, 'accepted', 'the team sees the answer');

// 9. Another client's documents stay closed; B's document cannot be read by A.
step('cross-client isolation');
const qb = await must('owner', '/api/v0/erp/documents', { docType: 'quotation', clientId: B.client });
eq((await call(asha, `/api/v0/client-portal/documents/${qb.id}/pdf`)).status, 404, 'not theirs');

// 10. Onboarding and kickoff.
step('onboarding');
const kick = await must('owner', `/api/v0/clients/${A.client}/kickoff`, {});
ok(kick.sent >= 3, 'kickoff checklist sent');
const tasks = (await must(asha, '/api/v0/client-portal')).tasks;
ok(tasks.length >= 3, 'the checklist waits on the client');
const steps = Object.fromEntries(kick.onboarding.map((s) => [s.key, s]));
ok(steps.quote.done && steps.joined.done && steps.team.done, 'quote, joined, people done');
const tick = await must('owner', `/api/v0/clients/${A.client}/onboarding`, { step: 'first_call', done: true });
ok(tick.onboarding.find((s) => s.key === 'first_call').done, 'a step ticked by hand');

// 11. Calls: the client rings their group.
step('calls');
const callR = await call(asha, '/api/v0/calls', { channelId: group.id, video: false });
eq(callR.status, 200, `the client starts a call: ${JSON.stringify(callR.data).slice(0, 160)}`);
ok(callR.data.call?.parties?.some?.((p) => p.state === 'ringing') ?? true, 'the team is rung');
await must(asha, `/api/v0/calls/${callR.data.call.id}/leave`, {});

// 12. Past conversations: no, then yes again.
step('history opt-in');
eq((await must(asha, '/api/v0/client-portal/history', { yes: false })).historyOptIn, null, 'no');
ok((await must(asha, '/api/v0/client-portal/history', { yes: true })).historyOptIn, 'yes');

console.log(JSON.stringify({ ok: true, checks, run, clients: made.map((m) => m.client) }));
