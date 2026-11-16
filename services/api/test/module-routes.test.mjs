// EST-648: a switched-off module's API answers 404 exactly like a route that does not exist; switched on, or with no
// modules document (EA), nothing changes. Synthetic database: the modules document is what each test sets and every
// other query finds nothing, so a signed-out request is answered the same way each time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { MODULE_API, MODULE_KEYS, ORG_CHOSEN, ORG_ONLY, moduleForRoute } from '../dist/modules.js';

// RELEASE-5: lane C's modules ship off until the server switches them on; these tests switch every one on, so a module
// is on exactly when no document switches it off (the last test turns them off again).
const SWITCHES = { PULSE_RELATIONSHIPS: '1', PULSE_SKILLS: '1', PULSE_JOBS: '1', PULSE_CHAT_IMPORT: 'preview', PULSE_CONNECTORS: 'setup', PULSE_CREATIVE: '1', PULSE_SALES_XRAY: '1' };
Object.assign(process.env, SWITCHES);

const ORG = '00000000-0000-4000-8000-000000000648';
const ID = '00000000-0000-4000-8000-000000000001';

function synthetic(body) {
  const calls = [], routes = [];
  const client = { query: async sql => { calls.push(sql); return { rows: sql.includes("doc_key='modules'") && body ? [{ body }] : [] }; }, release() {} };
  const app = createApp({ query: async () => ({ rows: [{ org_id: ORG }] }) }, { connect: async () => client },
    route => { for (const method of [route.method].flat()) if (method !== 'HEAD') routes.push({ method, url: route.url }); });
  return { app, calls, routes };
}
const send = async (app, { method, url }) => {
  const r = await app.inject({ method, url: url.replace(/:[^/]+/g, ID) });
  return { status: r.statusCode, body: r.body };
};
const notFound = (method, url) => ({ status: 404, body: JSON.stringify({ message: `Route ${method}:${url.replace(/:[^/]+/g, ID)} not found`, error: 'Not Found', statusCode: 404 }) });

// PULSE-HQ (23 Oct 2026): an organisation-only module (Pulse HQ) is on only where the organisation's own document names
// it in `on` (the Pulse organisation); every other module behaves as with no document. The baseline is that document.
// DE-EA: the modules a company chooses are on only where its document (or pack) names them, so the baseline names them.
const PULSE_ORG = [...ORG_ONLY, ...ORG_CHOSEN];
const { app: plain, routes } = synthetic({ on: PULSE_ORG });
await plain.ready();
const { app: noDocument } = synthetic(null);
const owned = key => routes.filter(route => moduleForRoute(route.url) === key);

test('an unknown route answers with the body the switched-off routes copy', async () => {
  for (const method of ['GET', 'POST']) assert.deepEqual(await send(plain, { method, url: '/api/v0/no-such-route' }), notFound(method, '/api/v0/no-such-route'));
});

test('every prefix owns registered routes; core routes belong to no module', () => {
  for (const key of MODULE_KEYS) for (const prefix of MODULE_API[key]) {
    const parts = prefix.split('/');
    assert.ok(routes.some(r => r.url.split('/').length >= parts.length && parts.every((p, i) => p === r.url.split('/')[i] || (p.startsWith(':') && r.url.split('/')[i].startsWith(':')))), `${key}: ${prefix}`);
  }
  for (const url of ['/api/v0/me', '/api/v0/home', '/api/v0/insights', '/api/v0/people/:id', '/api/v0/people/:id/self',
    '/api/v0/people/:id/work-terms', '/api/v0/delivery', '/api/v0/delivery/tasks', '/api/v0/companion/inbox', '/api/v0/research',
    '/api/v0/tasks', '/api/v0/projects', '/api/v0/clients', '/api/v0/review-data/groups', '/v1/deliveries/claimable',
    '/v1/accounts/claimable', '/api/v0/hrx', '/api/v0/mapping', undefined]) assert.equal(moduleForRoute(url), null, String(url));
  assert.equal(moduleForRoute('/api/v0/people/:person/hr'), 'hr');
  assert.equal(moduleForRoute('/api/v0/acquisition/webhook/:source'), 'acquisition');
  // The longest prefix decides: the import is chat_import's, the rest of Chats (with imported history) is chats'.
  assert.equal(moduleForRoute('/api/v0/chats/imports/:id/withdraw'), 'chat_import');
  assert.equal(moduleForRoute('/api/v0/chats/:id/history'), 'chats');
  assert.equal(moduleForRoute('/api/v0/people/:id/skills'), 'skills');
  assert.equal(moduleForRoute('/api/v0/people/:id/cv/export'), 'skills');
});

for (const key of MODULE_KEYS) test(`${key}: off answers 404 on every route under it, on leaves them unchanged`, async () => {
  const off = synthetic({ off: [key], on: PULSE_ORG }), on = synthetic({ off: MODULE_KEYS.filter(other => other !== key), on: PULSE_ORG });
  const mine = owned(key);
  assert.ok(mine.length >= MODULE_API[key].length, `${key} owns ${mine.length} routes`);
  for (const route of mine) {
    const before = await send(plain, route);
    assert.notDeepEqual(before, notFound(route.method, route.url), `${route.method} ${route.url} is a real route`);
    assert.deepEqual(await send(off.app, route), notFound(route.method, route.url), `${key} off: ${route.method} ${route.url}`);
    assert.deepEqual(await send(on.app, route), before, `${key} on: ${route.method} ${route.url}`);
  }
});

test('an organisation-only module stays off with no document (no other company sees Pulse HQ)', async () => {
  for (const key of ORG_ONLY) for (const route of owned(key))
    assert.deepEqual(await send(noDocument, route), notFound(route.method, route.url), `${key}, no document: ${route.method} ${route.url}`);
});

test('core routes never read the switches and stay as they are with every module off', async () => {
  const all = synthetic({ off: [...MODULE_KEYS] });
  for (const url of ['/api/v0/home', '/api/v0/delivery/tasks', '/api/v0/people/:id/self']) {
    const route = routes.find(r => r.url === url);
    assert.deepEqual(await send(all.app, route), await send(plain, route), url);
  }
  assert.equal(all.calls.some(sql => sql.includes("doc_key='modules'")), false);
});

test('RELEASE-5/6: relationships, skills, jobs, the chat import and connectors stay off until the server switches each on', async () => {
  const lane = ['relationships', 'skills', 'jobs', 'chat_import', 'connectors', 'creative', 'sales_xray'];
  for (const name of Object.keys(SWITCHES)) delete process.env[name];
  try {
    for (const key of lane) for (const route of owned(key))
      assert.deepEqual(await send(plain, route), notFound(route.method, route.url), `no server switch: ${route.method} ${route.url}`);
    for (const key of MODULE_KEYS.filter(k => !lane.includes(k))) for (const route of owned(key).slice(0, 3))
      assert.notDeepEqual(await send(plain, route), notFound(route.method, route.url), `${key} is not server-switched: ${route.url}`);
    process.env.PULSE_CHAT_IMPORT = '1';  // real imports: the preview and the import are both on
    for (const route of owned('chat_import')) assert.notDeepEqual(await send(plain, route), notFound(route.method, route.url), route.url);
    process.env.PULSE_SKILLS = 'yes';     // only "1" switches a module on
    assert.deepEqual(await send(plain, owned('skills')[0]), notFound(owned('skills')[0].method, owned('skills')[0].url));
    process.env.PULSE_CONNECTORS = '1';   // reading connectors shows their routes too
    for (const route of owned('connectors')) assert.notDeepEqual(await send(plain, route), notFound(route.method, route.url), route.url);
  } finally { Object.assign(process.env, SWITCHES); }
});
