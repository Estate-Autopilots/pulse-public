// PULSE-ID acceptance against the built API on the synthetic agency (tests/core/test_oidc.py::test_sign_in_with_pulse):
// Sign in with Pulse and the data API, as AC's pulse-identity-contract describes them. An install admin registers a
// fictional Sales X-Ray; a member signs in (code + PKCE, an ID token checked against the JWKS, the contract's claims, a
// signed photo address, userinfo); codes and refresh tokens cannot be replayed; an admin links the organisation and the
// app reads members, clients and (once switched on) money, writes leads, calls and work signals and keeps webhooks; the
// admin changes and ends connections in Pulse, the app ends its link, and sign-up starts a new account. Fictional data.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { Pool } from 'pg';

const dir = mkdtempSync(join(tmpdir(), 'pulse-oidc-'));
writeFileSync(join(dir, 'signing.pem'), generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(join(dir, 'ring'), `k1 ${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
const ISSUER = 'https://pulse.example.test';
Object.assign(process.env, { PULSE_OIDC: '1', PULSE_OIDC_ISSUER: ISSUER, PULSE_OIDC_SIGNING_KEY_FILE: join(dir, 'signing.pem'),
  PULSE_DOCUMENT_KEY_FILE: join(dir, 'ring'), PULSE_CONNECT_WEBHOOKS: '0' });
const { createApp } = await import('../dist/app.js');
const P = JSON.parse(process.env.TEST_PEOPLE), domain = process.env.TEST_DOMAIN, home = process.env.PULSE_ORG_ID;
const CLIENT = process.env.TEST_CLIENT, CONTACT = process.env.TEST_CONTACT;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const s256 = (v) => createHash('sha256').update(v).digest('base64url');
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();

/** who: a staff key (Access identity), { token } a Pulse session, { bearer } an access token, or null (signed out). */
const call = async (who, url, payload, method = payload ? 'POST' : 'GET', extra = {}) => {
  const headers = { 'x-pulse-client-ip': crypto.randomUUID(), 'user-agent': 'oidc-runner Chrome on Linux', ...extra };
  if (typeof who === 'string') headers['cf-access-authenticated-user-email'] = `${who}@${domain}`;
  else if (who?.token) headers['x-pulse-session'] = who.token;
  else if (who?.bearer) headers.authorization = `Bearer ${who.bearer}`;
  const r = await app.inject({ url, method, headers, ...(payload !== undefined ? { payload } : {}) });
  return { status: r.statusCode, headers: r.headers, data: r.headers['content-type']?.includes('json') ? r.json() : r.rawPayload };
};
const must = async (who, url, payload, method) => { const r = await call(who, url, payload, method); assert.ok(r.status >= 200 && r.status < 300, `${url}: ${r.status} ${JSON.stringify(r.data).slice(0, 500)}`); checks++; return r.data; };
const refused = async (who, url, payload, status, method) => { const r = await call(who, url, payload, method); eq(r.status, status, `${url} should answer ${status}: ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
/** The token and revocation endpoints: form-encoded, client_secret_basic unless the body carries the client. */
const form = async (url, body, client) => {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-pulse-client-ip': crypto.randomUUID() };
  if (client) headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(client[0])}:${encodeURIComponent(client[1])}`).toString('base64');
  const r = await app.inject({ method: 'POST', url, headers, payload: qs(body) });
  return { status: r.statusCode, data: r.json(), headers: r.headers };
};
/** Through the consent screen as `who`; answers the code, the verifier and what was asked. */
const authorize = async (who, scope, more = {}) => {
  const verifier = randomBytes(32).toString('base64url'), state = `st-${randomBytes(8).toString('hex')}`, nonce = `n-${randomBytes(8).toString('hex')}`;
  const query = { client_id: SX.clientId, redirect_uri: SIGNIN, response_type: 'code', scope, state, nonce, code_challenge: s256(verifier), code_challenge_method: 'S256', ...more.query };
  const back = new URL((await must(who, '/api/v0/oidc/authorize/allow', { query, off: more.off ?? [] })).redirect);
  eq([back.origin + back.pathname, back.searchParams.get('state'), back.searchParams.get('iss')], [query.redirect_uri, state, ISSUER], 'back to the app with the state and iss');
  ok(/^pxc_[A-Za-z0-9_-]{43}$/.test(back.searchParams.get('code')), 'a one-time code');
  return { code: back.searchParams.get('code'), verifier, nonce, query };
};
const exchange = (a, client = [SX.clientId, SX.secret]) => form('/oauth/token', { grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier, redirect_uri: a.query.redirect_uri }, client);
const db = async (sql, args = [], viewer = '') => {
  const c = await pool.connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [home]); await c.query("select set_config('pulse.viewer_id',$1,true)", [viewer]);
    const r = await c.query(sql, args); await c.query('commit'); return r.rows; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
};

let SX = null; const SIGNIN = 'https://sx.example.test/v1/auth/pulse/callback', LINK = 'https://sx.example.test/v1/integrations/pulse/callback';
try {
  // ------------------------------------------------------------------------------- discovery and keys
  const d = await must(null, '/.well-known/openid-configuration');
  eq([d.issuer, d.authorization_endpoint, d.token_endpoint, d.jwks_uri, d.pulse_org_api_base], [ISSUER, `${ISSUER}/oauth/authorize`, `${ISSUER}/oauth/token`, `${ISSUER}/oauth/jwks`, `${ISSUER}/api/v1/connect`]);
  eq(d.code_challenge_methods_supported, ['S256']); ok(d.scopes_supported.includes('pulse.org.webhooks'), 'contract scopes are listed');
  const jwks = await must(null, '/oauth/jwks'); eq(jwks.keys.length, 1); ok(!('d' in jwks.keys[0]) && jwks.keys[0].kid, 'public key only, with kid');
  const keys = createLocalJWKSet(jwks);

  // ------------------------------------------------------------------------------- registering the app (install admin)
  const appBody = { name: 'Sales X-Ray (test)', maker: 'Fictional Closers', homeUrl: 'https://sx.example.test', redirectUris: [SIGNIN, LINK],
    scopes: ['openid', 'profile', 'email', 'offline_access', 'pulse.orgs', 'pulse.org.read', 'pulse.org.webhooks', 'pulse.signals.write', 'pulse.clients.read', 'pulse.leads.write', 'pulse.calls.write', 'pulse.money.read'] };
  await refused('kabir', '/api/v0/oidc/apps', appBody, 403);
  await refused('admin', '/api/v0/oidc/apps', { ...appBody, redirectUris: ['http://sx.example.test/cb'] }, 400);
  const made = await must('admin', '/api/v0/oidc/apps', appBody);
  ok(/^papp_[a-z0-9]{20}$/.test(made.clientId) && /^psec_[A-Za-z0-9_-]{43}$/.test(made.clientSecret) && made.warning, 'client id and a secret shown once');
  SX = { id: made.id, clientId: made.clientId, secret: made.clientSecret };
  let apps = (await must('admin', '/api/v0/oidc/apps')).apps;
  eq([apps.length, apps[0].name, apps[0].verified, 'clientSecret' in apps[0], 'secretHash' in apps[0]], [1, 'Sales X-Ray (test)', false, false, false], 'the list never shows a secret');
  await must('admin', `/api/v0/oidc/apps/${SX.id}/verify`, { verified: true });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await must('admin', `/api/v0/oidc/apps/${SX.id}/logo`, { image: png });
  const logo = await call(null, `/oauth/app-logo/${SX.clientId}`); eq([logo.status, logo.headers['content-type']], [200, 'image/png'], 'the logo, re-encoded as PNG');

  // ------------------------------------------------------------------------------- the authorize page's checks
  const base = { client_id: SX.clientId, redirect_uri: SIGNIN, response_type: 'code', scope: 'openid profile email pulse.orgs', state: 'state-12345678', nonce: 'n1', code_challenge: s256('v'.repeat(43)), code_challenge_method: 'S256' };
  let ck = await must(null, `/api/v0/oidc/authorize/check?${qs(base)}`);
  eq([ck.app.name, ck.app.verified, ck.kind, ck.scopes, !!ck.app.logo], ['Sales X-Ray (test)', true, 'personal', ['openid', 'profile', 'email', 'pulse.orgs'], true]);
  eq((await must(null, `/api/v0/oidc/authorize/check?${qs({ ...base, client_id: 'papp_00000000000000000000' })}`)).fatal, 'unknown_app');
  eq((await must(null, `/api/v0/oidc/authorize/check?${qs({ ...base, redirect_uri: 'https://evil.example.test/cb' })}`)).fatal, 'bad_redirect', 'never redirects to an unregistered address');
  ck = await must(null, `/api/v0/oidc/authorize/check?${qs({ ...base, code_challenge_method: undefined })}`);
  const err = new URL(ck.redirect); eq([err.searchParams.get('error'), err.searchParams.get('state'), err.searchParams.get('iss')], ['invalid_request', 'state-12345678', ISSUER], 'PKCE is required');
  const no = new URL((await must(null, '/api/v0/oidc/authorize/refuse', { query: base, error: 'access_denied' })).redirect);
  eq([no.searchParams.get('error'), no.searchParams.get('state')], ['access_denied', 'state-12345678'], 'Cancel goes back with access_denied');
  let st = await must('kabir', '/api/v0/oidc/authorize/state', { query: base });
  eq([st.kind, st.person.name, st.org.id, st.admin, st.grant, st.emailChecked], ['personal', 'Kabir Mifos', home, false, null, true], 'the consent screen: who, where, nothing granted yet');

  // ------------------------------------------------------------------------------- Sign in with Pulse (personal)
  let a = await authorize('kabir', 'openid profile email pulse.orgs');
  let t = await exchange(a);
  eq(t.status, 200, JSON.stringify(t.data)); eq([t.data.token_type, t.data.expires_in, 'refresh_token' in t.data, 'pulse_org_id' in t.data], ['Bearer', 3600, false, false], 'no refresh token without offline_access');
  ok(/^pxa_[A-Za-z0-9_-]{43}$/.test(t.data.access_token), 'an opaque access token'); eq(t.headers['cache-control'], 'no-store');
  const { payload: id } = await jwtVerify(t.data.id_token, keys, { issuer: ISSUER, audience: SX.clientId });
  eq([id.nonce, id.exp - id.iat, id.amr], [a.nonce, 600, ['sso']], 'nonce echoed, 10 minutes, signed in through Access');
  ok(/^[0-9a-f]{32}$/.test(id.sub), 'a pairwise sub');
  eq([id.name, id.given_name, id.family_name, id.title, id.team, id.email, id.email_verified], ['Kabir Mifos', 'Kabir', 'Mifos', 'Graphic Designer', 'Pod 1', `kabir@${domain}`, true]);
  ok(id.preferred_username, 'the @handle (the account made at consent)');
  eq(id.pulse_orgs.map((o) => [o.id, o.role]), [[home, 'member']], 'their organisations and role');
  const kabirSub = id.sub, picture = new URL(id.picture);
  ok(picture.origin === ISSUER && picture.pathname === `/api/v1/connect/photos/${P.kabir}`, 'the picture lives on the issuer');
  let ph = await call(null, picture.pathname + picture.search);
  eq([ph.status, ph.headers['content-type']], [200, 'image/png'], 'the photo without a token');
  const tampered = new URLSearchParams(picture.search); tampered.set('v', '1');
  eq((await call(null, `${picture.pathname}?${tampered}`)).status, 404, 'another version is another (unsigned) address');
  let ui = await must({ bearer: t.data.access_token }, '/oauth/userinfo');
  eq([ui.sub, ui.name, ui.email_verified, ui.title], [kabirSub, 'Kabir Mifos', true, 'Graphic Designer'], 'userinfo agrees with the ID token');
  // Replays and wrong proofs.
  let again = await exchange(a); eq([again.status, again.data.error], [400, 'invalid_grant'], 'a code works once');
  await refused({ bearer: t.data.access_token }, '/oauth/userinfo', undefined, 401);   // ... and a replay ends what it issued
  a = await authorize('kabir', 'openid profile');
  eq((await form('/oauth/token', { grant_type: 'authorization_code', code: a.code, code_verifier: 'x'.repeat(43), redirect_uri: SIGNIN }, [SX.clientId, SX.secret])).data.error, 'invalid_grant', 'the PKCE verifier must match');
  eq((await exchange(a)).data.error, 'invalid_grant', 'and the code was spent by the failed try');
  a = await authorize('kabir', 'openid profile');
  eq((await exchange(a, [SX.clientId, 'psec_' + 'x'.repeat(43)])).status, 401, 'a wrong secret is invalid_client');
  eq((await form('/oauth/token', { grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier, redirect_uri: LINK }, [SX.clientId, SX.secret])).data.error, 'invalid_grant', 'the redirect URI must match');
  eq((await form('/oauth/token', { grant_type: 'client_credentials', client_id: SX.clientId, client_secret: SX.secret })).data.error, 'unsupported_grant_type');
  a = await authorize('kabir', 'openid profile');
  eq((await form('/oauth/token', { grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier, redirect_uri: SIGNIN, client_id: SX.clientId, client_secret: SX.secret })).status, 200, 'client_secret_post works too');
  st = await must('kabir', '/api/v0/oidc/authorize/state', { query: base });
  ok(st.grant && ['openid', 'profile', 'email', 'pulse.orgs'].every((s) => st.grant.scopes.includes(s)), 'the connection now covers the sign-in (the page skips the screen)');

  // Refresh rotation and reuse.
  a = await authorize('kabir', 'openid profile offline_access');
  t = await exchange(a); ok(/^pxr_[A-Za-z0-9_-]{43}$/.test(t.data.refresh_token), 'offline_access gives a refresh token');
  const r1 = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: t.data.refresh_token }, [SX.clientId, SX.secret]);
  ok(r1.status === 200 && r1.data.refresh_token !== t.data.refresh_token && r1.data.id_token, 'a refresh rotates the refresh token');
  await must({ bearer: r1.data.access_token }, '/oauth/userinfo');
  const reuse = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: t.data.refresh_token }, [SX.clientId, SX.secret]);
  eq(reuse.data.error, 'invalid_grant', 'a swapped refresh token is refused');
  await refused({ bearer: r1.data.access_token }, '/oauth/userinfo', undefined, 401);   // and ends every token of the connection
  eq((await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: r1.data.refresh_token }, [SX.clientId, SX.secret])).data.error, 'invalid_grant');
  // Revocation (RFC 7009) ends the connection.
  a = await authorize('kabir', 'openid profile offline_access'); t = await exchange(a);
  eq((await form('/oauth/revoke', { token: t.data.refresh_token }, [SX.clientId, SX.secret])).status, 200);
  await refused({ bearer: t.data.access_token }, '/oauth/userinfo', undefined, 401);
  eq((await form('/oauth/revoke', { token: 'pxr_' + 'z'.repeat(43) }, [SX.clientId, SX.secret])).status, 200, 'an unknown token is not an error');
  eq((await form('/oauth/revoke', { token: t.data.refresh_token }, [SX.clientId, 'psec_' + 'y'.repeat(43)])).status, 401);
  let mine = await must('kabir', '/api/v0/oidc/connections');
  eq(mine.connections.filter((x) => x.kind === 'personal').length, 0, 'ended connections leave Account → Connected apps');

  // ------------------------------------------------------------------------------- the organisation link
  const ORG = 'openid profile pulse.org.read pulse.org.webhooks pulse.signals.write pulse.clients.read pulse.leads.write pulse.calls.write pulse.money.read';
  eq((await must(null, `/api/v0/oidc/authorize/check?${qs({ ...base, redirect_uri: LINK, scope: ORG })}`)).kind, 'org');
  const orgQuery = (state) => ({ ...base, redirect_uri: LINK, scope: ORG, state, code_challenge: s256('w'.repeat(43)) });
  await refused('kabir', '/api/v0/oidc/authorize/allow', { query: orgQuery('state-member-1') }, 403);   // only an admin links the organisation
  a = await authorize('admin', ORG, { query: { redirect_uri: LINK, pulse_org_hint: home }, off: ['pulse.money.read'] });
  t = await exchange(a);
  eq([t.status, t.data.pulse_org_id, t.data.scope.includes('pulse.money.read')], [200, home, false], 'linked; money stays off');
  ok(/^pxr_/.test(t.data.refresh_token), 'an org link always gets a refresh token');
  const { payload: aid } = await jwtVerify(t.data.id_token, keys, { issuer: ISSUER, audience: SX.clientId });
  eq([aid.name, aid.pulse_org_id], ['Dev Admin', home], 'the ID token is about the admin who linked it');
  let link = { bearer: t.data.access_token }; const linkRefresh = t.data.refresh_token;
  const api = `/api/v1/connect/orgs/${home}`;
  // Members, paged.
  let page = await must(link, `${api}/members?limit=5`), all = [...page.members];
  ok(page.next_cursor, 'a cursor while more remain');
  while (page.next_cursor) { page = await must(link, `${api}/members?limit=5&cursor=${page.next_cursor}`); all.push(...page.members); }
  eq(all.length, 18, 'every staff member, once (clients and contacts are not members)');
  eq(new Set(all.map((m) => m.sub)).size, 18);
  const kabir = all.find((m) => m.name === 'Kabir Mifos');
  eq([kabir.sub, kabir.title, kabir.team, kabir.role, kabir.status, kabir.email, kabir.email_verified], [kabirSub, 'Graphic Designer', 'Pod 1', 'member', 'active', `kabir@${domain}`, true],
    'the same sub as at sign-in, with title, team and role');
  ok(kabir.picture && !('member' in kabir) && !('photo' in kabir), 'a picture address, no internal ids');
  eq(all.find((m) => m.name === 'Dev Admin').role, 'admin');
  ph = await call(null, new URL(kabir.picture).pathname + new URL(kabir.picture).search); eq(ph.status, 200);
  eq((await must(link, `${api}/members/${kabirSub}`)).name, 'Kabir Mifos');
  await refused(link, `${api}/members/${'0'.repeat(32)}`, undefined, 404);
  eq((await must(link, `${api}/members?updated_since=2999-01-01T00:00:00Z`)).members, [], 'nothing changed since a future time');
  await refused(link, `/api/v1/connect/orgs/${crypto.randomUUID()}/members`, undefined, 404);   // another organisation
  await refused(null, `${api}/members`, undefined, 401);
  eq((await call(link, `${api}/members`, undefined, 'GET', { cookie: 'pulse_session=x' })).status, 401, 'a sign-in beside the token is refused');
  // A personal token cannot read the organisation.
  a = await authorize('kabir', 'openid profile'); const personal = { bearer: (await exchange(a)).data.access_token };
  const insufficient = await call(personal, `${api}/members`);
  eq([insufficient.status, insufficient.data.error], [403, 'insufficient_scope']); ok(/insufficient_scope/.test(insufficient.headers['www-authenticate']));

  // Clients (Pulse extension).
  const clients = await must(link, `${api}/clients`);
  const lake = clients.clients.find((x) => x.id === CLIENT);
  eq([lake.name, lake.company, lake.email, lake.city, lake.status], ['Lakeview Interiors (test)', 'Lakeview Interiors', 'hello@lakeview.example', 'Pune', 'active']);
  const one = await must(link, `${api}/clients/${CLIENT}`);
  eq(one.contacts.map((x) => [x.id, x.name, x.designation, x.email, x.primary]), [[CONTACT, 'Asha Kireteso (test)', 'Owner', 'asha@lakeview.example', true]], 'with its contacts');
  eq((await must(link, `${api}/clients?q=lakeview`)).clients.length, 1);
  // Money: off until an admin switches it on in Settings → Connected apps; then it works at once.
  await refused(link, `${api}/money/clients`, undefined, 403);
  let org = (await must('admin', '/api/v0/oidc/connections')).connections.find((x) => x.kind === 'org');
  eq([org.app.name, org.grantedBy.name, org.scopes.includes('pulse.money.read'), org.asked.includes('pulse.money.read')], ['Sales X-Ray (test)', 'Dev Admin', false, true]);
  await refused('kabir', `/api/v0/oidc/connections/${org.id}/scopes`, { scopes: [...org.scopes, 'pulse.money.read'] }, 403);
  await must('admin', `/api/v0/oidc/connections/${org.id}/scopes`, { scopes: [...org.scopes, 'pulse.money.read'] });
  const money = (await must(link, `${api}/money/clients`)).clients.find((x) => x.client_id === CLIENT);
  eq([money.invoiced, money.received, money.outstanding, money.currency], ['118000.00', '50000.00', '68000.00', 'INR'], 'per-client totals');

  // Leads written in (XRAY-LINK's rules).
  const lead = (id, body) => call(link, `${api}/leads/${id}`, body, 'PUT');
  const L1 = crypto.randomUUID(), L2 = crypto.randomUUID(), L3 = crypto.randomUUID();
  let lr = await lead(L1, { name: 'Asha Kireteso', company: 'Lakeview Interiors', email: 'hello@lakeview.example', stage: 'won', revision: 1, owner: { sub: kabirSub } });
  eq([lr.status, lr.data.client?.id, lr.data.client?.action], [200, CLIENT, 'linked'], 'a won lead finds its client by e-mail');
  lr = await lead(L2, { name: 'Rifob Mifos', company: 'Greenleaf Cafe (test)', phone: '+91 90000 00103', stage: 'won', revision: 3 });
  eq([lr.data.client?.name, lr.data.client?.action], ['Greenleaf Cafe (test)', 'created'], 'or makes one');
  lr = await lead(L2, { name: 'Rifob Mifos', company: 'Greenleaf Cafe (test)', stage: 'won', revision: 3 });
  eq([lr.data.changed, lr.data.client?.action], [false, 'none'], 'the same revision changes nothing');
  lr = await lead(L3, { name: 'Neha Iyer', stage: 'new', revision: 1 }); eq([lr.status, lr.data.client], [200, null], 'an open lead makes no client (rule: when won)');
  eq((await lead(L3, { name: 'Neha Iyer', stage: 'new' })).status, 400, 'revision is required');
  eq((await call(personal, `${api}/leads/${L3}`, { name: 'x', stage: 'new', revision: 9 }, 'PUT')).status, 403);
  const leads = await db('select sx_lead_id::text id, owner_name, stage, client_id::text client from pulse.sales_xray_lead where sx_lead_id = any($1::uuid[]) order by name', [[L1, L2, L3]]);
  eq(leads.map((x) => [x.owner_name, x.stage]), [['Kabir Mifos', 'won'], [null, 'new'], [null, 'won']], 'kept with the owner named by sub');
  // A call and its analysis.
  const C1 = crypto.randomUUID();
  const cr = await call(link, `${api}/calls/${C1}`, { title: 'Discovery call (test)', at: '2026-10-24T10:00:00Z', duration_seconds: 900, status: 'ready', lead_id: L1,
    member: { sub: kabirSub }, summary: { text: 'Wants a 2BHK show flat walkthrough.', wants: ['Walkthrough video'], objections: ['Budget'], promises: ['Send samples'], score: 72 },
    report_url: 'https://sx.example.test/calls/1' }, 'PUT');
  eq([cr.status, cr.data.client_id, cr.data.member_sub, cr.data.status], [200, CLIENT, kabirSub, 'ready'], 'linked to the lead’s client and the member');
  const kept = (await db('select summary, person_id::text person, open_url from pulse.sales_xray_call where sx_call_id=$1', [C1]))[0];
  eq([kept.person, kept.summary.items, kept.summary.objections, kept.summary.score, kept.open_url], [P.kabir, ['Walkthrough video'], ['Budget'], 72, 'https://sx.example.test/calls/1']);
  // Work signals.
  const today = new Date().toISOString().slice(0, 10);
  let sg = await must(link, `${api}/signals`, { items: [{ sub: kabirSub, kind: 'calls_analysed', day: today, value: 4 }, { sub: kabirSub, kind: 'talk_minutes', day: today, value: 37 },
    { sub: '0'.repeat(32), kind: 'calls_analysed', day: today, value: 1 }, { sub: kabirSub, kind: 'transcripts', day: today, value: 1 }] });
  eq([sg.accepted, sg.ignored], [2, 2]);
  await must(link, `${api}/signals`, { items: [{ sub: kabirSub, kind: 'calls_analysed', day: today, value: 5 }] });
  eq((await db('select value from pulse.connect_signal where person_id=$1 and kind=$2', [P.kabir, 'calls_analysed']))[0].value, 5, 'the latest value wins');

  // Webhooks.
  await refused(link, `${api}/webhooks`, { url: 'http://hooks.example.test/pulse' }, 400);
  await refused(link, `${api}/webhooks`, { url: 'https://hooks.example.test/pulse', events: ['payroll.changed'] }, 400);
  const hook = await call(link, `${api}/webhooks`, { url: 'https://hooks.example.test/pulse', events: ['person.updated', 'person.photo_updated', 'membership.removed'] });
  eq(hook.status, 201); ok(/^pwhs_[0-9a-f]{43}$/.test(hook.data.secret), 'the signing secret, once');
  eq((await must(link, `${api}/webhooks`)).webhooks.map((h) => [h.url, h.status]), [['https://hooks.example.test/pulse', 'active']]);
  await db("update pulse.people_profile set role='Senior Graphic Designer' where person_id=$1", [P.kabir], P.admin);
  const due = await db('select pulse.connect_due(50) r');
  const ev = due[0].r.find((e) => e.type === 'person.updated');
  ok(ev, JSON.stringify(due[0].r).slice(0, 400));
  eq([ev.body.sub, ev.body.changed, ev.body.org_id, ev.body.event_id, ev.url], [kabirSub, ['title'], home, ev.id, 'https://hooks.example.test/pulse'], 'no values, only what changed');
  ok(ev.secret.k && ev.secret.d && !JSON.stringify(ev.secret).includes(hook.data.secret.slice(5)), 'the secret is kept sealed');
  await db('select pulse.connect_delivered($1)', [JSON.stringify([{ id: ev.id, status: 200 }])]);
  eq((await db('select pulse.connect_due(50) r'))[0].r.filter((e) => e.id === ev.id).length, 0, 'delivered once');
  eq((await must(link, `${api}/members/${kabirSub}`)).title, 'Senior Graphic Designer', 'the app pulls the change');
  eq((await call(link, `${api}/webhooks/${hook.data.id}`, undefined, 'DELETE')).status, 204);
  await refused(link, `${api}/webhooks/${hook.data.id}`, undefined, 404, 'DELETE');

  // Narrowing in Pulse takes effect at once; refresh keeps the link's current scopes.
  org = (await must('admin', '/api/v0/oidc/connections')).connections.find((x) => x.kind === 'org');
  await must('admin', `/api/v0/oidc/connections/${org.id}/scopes`, { scopes: org.scopes.filter((s) => s !== 'pulse.clients.read') });
  await refused(link, `${api}/clients`, undefined, 403);
  const rr = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: linkRefresh }, [SX.clientId, SX.secret]);
  eq([rr.status, rr.data.scope.includes('pulse.clients.read'), rr.data.scope.includes('pulse.money.read'), rr.data.pulse_org_id], [200, false, true, home]);
  link = { bearer: rr.data.access_token };
  // A switched-off app stops at once; switched on again, it works.
  await must('admin', `/api/v0/oidc/apps/${SX.id}/status`, { on: false });
  await refused(link, `${api}/members`, undefined, 401);
  eq((await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: rr.data.refresh_token }, [SX.clientId, SX.secret])).status, 401);
  await must('admin', `/api/v0/oidc/apps/${SX.id}/status`, { on: true });
  await must(link, `${api}/members?limit=1`);
  // A new secret: the old one keeps working for a day.
  const fresh = await must('admin', `/api/v0/oidc/apps/${SX.id}/secret`, {});
  ok(fresh.clientSecret !== SX.secret, 'a new secret');
  a = await authorize('kabir', 'openid'); eq((await exchange(a, [SX.clientId, fresh.clientSecret])).status, 200);
  a = await authorize('kabir', 'openid'); eq((await exchange(a)).status, 200, 'the previous secret still works during the change-over');
  ok((await must('admin', '/api/v0/oidc/connections')).connections.find((x) => x.kind === 'org').calls > 10, 'data calls are logged (Connected apps counts them)');
  // Revoking the link's refresh token ends that chain only: the organisation stays linked (an app ends a link with DELETE).
  eq((await form('/oauth/revoke', { token: rr.data.refresh_token }, [SX.clientId, SX.secret])).status, 200);
  await refused(link, `${api}/members?limit=1`, undefined, 401);
  eq((await must('admin', '/api/v0/oidc/connections')).connections.filter((x) => x.kind === 'org').length, 1, 'still linked after one session signs out');
  a = await authorize('admin', ORG, { query: { redirect_uri: LINK } }); link = { bearer: (await exchange(a)).data.access_token };
  await must(link, `${api}/members?limit=1`);
  // An endpoint that listed only person.updated still hears that the link ended.
  const hook2 = await call(link, `${api}/webhooks`, { url: 'https://hooks.example.test/pulse-2', events: ['person.updated'] }); eq(hook2.status, 201);
  // The app ends its link.
  eq((await call(link, `${api}/link`, undefined, 'DELETE')).status, 204);
  const ended = (await db('select pulse.connect_due(50) r'))[0].r.filter((e) => e.type === 'link.revoked');
  eq(ended.map((e) => [e.url, e.body.org_id]), [['https://hooks.example.test/pulse-2', home]], 'link.revoked reaches the endpoint');
  await refused(link, `${api}/members`, undefined, 401);
  eq((await must('admin', '/api/v0/oidc/connections')).connections.filter((x) => x.kind === 'org').length, 0, 'gone from Settings → Connected apps');
  const audit = await db("select action from pulse.audit_event where resource in ('oidc_grant','oidc_app') order by at", [], P.admin);
  for (const action of ['oidc_app_registered', 'oidc_consent', 'oidc_grant_changed', 'oidc_grant_revoked', 'oidc_token_reuse', 'oidc_secret_rotated', 'connect_webhook_added', 'connect_webhook_removed'])
    ok(audit.some((x) => x.action === action), `audited: ${action}`);

  // ------------------------------------------------------------------------------- personal clients, HR refused
  a = await authorize('kabir', 'openid pulse.clients.read'); let pc = { bearer: (await exchange(a)).data.access_token };
  ok((await must(pc, '/api/v1/connect/me/clients')).clients.some((x) => x.id === CLIENT), 'a member reads the clients they see in Pulse');
  await refused(pc, `${api}/clients`, undefined, 403);
  a = await authorize('hr', 'openid pulse.clients.read'); pc = { bearer: (await exchange(a)).data.access_token };
  await refused(pc, '/api/v1/connect/me/clients', undefined, 403);   // HR does not work on clients

  // ------------------------------------------------------------------------------- sign-up from an app
  const PASSWORD = 'Correct-horse-battery-9';
  const su = { name: 'Nisha Rao (test)', handle: 'nisha.test', email: 'nisha@signup.example', password: PASSWORD, orgName: 'Nisha Studio (test)' };
  await refused(null, '/api/v0/auth/signup', { ...su, password: 'weak' }, 400);
  const made2 = await must(null, '/api/v0/auth/signup', su);
  ok(made2.token && made2.org !== home && made2.maxAge === 2592000, 'a new account, its organisation and a session');
  await refused(null, '/api/v0/auth/signup', { ...su, email: 'other@signup.example' }, 409);   // the handle is taken
  const nisha = { token: made2.token }, me = await must(nisha, '/api/v0/me');
  eq([me.role, me.orgName], ['admin', 'Nisha Studio (test)']);
  st = await must(nisha, '/api/v0/oidc/authorize/state', { query: base }); eq(st.emailChecked, false, 'the screen says the e-mail is not checked yet');
  a = await authorize(nisha, 'openid profile email pulse.orgs');
  const { payload: nid } = await jwtVerify((await exchange(a)).data.id_token, keys, { issuer: ISSUER, audience: SX.clientId });
  eq([nid.name, nid.preferred_username, nid.email, nid.email_verified, nid.pulse_orgs.map((o) => [o.name, o.role]), nid.amr], ['Nisha Rao (test)', 'nisha.test', 'nisha@signup.example', false, [['Nisha Studio (test)', 'admin']], ['pwd']]);
  ok(nid.sub !== kabirSub, 'another person, another sub');

  // ------------------------------------------------------------------------------- registering from the server
  // oidc-app-admin, for an install whose admins are not at a browser: the same audited function, as a named admin.
  const cfg = JSON.parse(process.env.TEST_API_CONFIG), saved = join(dir, 'server-app.env');
  const dbUrl = `postgresql://${encodeURIComponent(cfg.user)}${cfg.password ? `:${encodeURIComponent(cfg.password)}` : ''}@/${encodeURIComponent(cfg.database)}?${qs({ host: cfg.host, port: cfg.port })}`;
  const cli = (args) => promisify(execFile)(process.execPath, [new URL('../dist/oidc-app-admin.js', import.meta.url).pathname, ...args],
    { env: { ...process.env, PULSE_DATABASE_URL_API: dbUrl } }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  const reg = (as) => ['register', saved, '--as', as, '--name', 'Sales X-Ray (server test)', '--maker', 'Fictional Closers', '--home', 'https://sx2.example.test',
    '--redirect', 'https://sx2.example.test/v1/auth/pulse/callback', '--redirect', 'https://sx2.example.test/v1/integrations/pulse/callback', '--scopes', appBody.scopes.join(','), '--verified'];
  const before = (await must('admin', '/api/v0/oidc/apps')).apps.length;
  let out = await cli(reg(P.kabir));
  eq([out.code, out.stdout, existsSync(saved)], [1, '', false], 'only an admin of the install’s own organisation registers an app; nothing is written');
  out = await cli(reg(P.admin));
  eq(out.code, 0, `oidc-app-admin register: ${out.stderr}`);
  const [cliId, cliClient] = out.stdout.trim().split(' ');
  ok(/^papp_[a-z0-9]{20}$/.test(cliClient) && !out.stdout.includes('psec_') && !out.stderr.includes('psec_'), 'the app id and client id, never the secret');
  eq(statSync(saved).mode & 0o777, 0o600, 'the secret is in a file only its owner reads');
  const issued = Object.fromEntries(readFileSync(saved, 'utf8').split('\n').filter((l) => /^PULSE_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  eq([issued.PULSE_ISSUER, issued.PULSE_CLIENT_ID], [ISSUER, cliClient]);
  eq((await form('/oauth/revoke', { token: 'pxr_' + 'x'.repeat(43) }, [cliClient, issued.PULSE_CLIENT_SECRET])).status, 200, 'its secret signs the app in');
  apps = (await must('admin', '/api/v0/oidc/apps')).apps;
  const listed = apps.find((x) => x.id === cliId);
  eq([apps.length, listed?.name, listed?.verified, listed?.status, listed?.redirectUris.length, listed?.scopes.length],
    [before + 1, 'Sales X-Ray (server test)', true, 'active', 2, appBody.scopes.length]);
  eq((await db("select count(*)::int n from pulse.audit_event where action = 'oidc_app_registered' and resource_id = $1 and actor_id = $2", [cliId, P.admin], P.admin))[0].n, 1, 'the audit names the admin');
  out = await cli(reg(P.admin));
  eq([out.code, (await must('admin', '/api/v0/oidc/apps')).apps.length], [1, before + 1], 'an existing file is never overwritten, and then nothing is registered');
  out = await cli(['list', '--as', P.admin]);
  ok(out.code === 0 && out.stdout.includes(`${cliId} ${cliClient} verified active Sales X-Ray (server test)`), 'list');

  // ------------------------------------------------------------------------------- off without its key
  process.env.PULSE_OIDC_SIGNING_KEY_FILE = join(dir, 'missing.pem');
  eq((await call(null, '/.well-known/openid-configuration')).status, 503, 'no signing key: nothing is issued');
  process.env.PULSE_OIDC_SIGNING_KEY_FILE = join(dir, 'signing.pem');
  process.env.PULSE_OIDC = '0';
  eq((await call(null, '/.well-known/openid-configuration')).status, 404, 'switched off: not there');
  process.env.PULSE_OIDC = '1';
} finally { await app.close(); await pool.end(); }
await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks }));
console.log(`oidc-runner: ${checks} checks`);
