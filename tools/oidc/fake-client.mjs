#!/usr/bin/env node
// PULSE-ID: a fake "Sales X-Ray" that signs in with Pulse and links an organisation, end to end against a running Pulse
// (docs/architecture/PULSE_IDENTITY_AND_DATA_API.md). Until the real app can reach Pulse (pulse-dev and staging are behind
// Cloudflare Access), it runs on the server: the browser's part (the consent screen's Allow) is played with the Access
// identity header the web accepts from this machine, as a fictional person. Nothing here prints a secret or a token.
//
//   node tools/oidc/fake-client.mjs --base http://127.0.0.1:3200 --client-file ~/.local/state/pulse-dev/oidc-apps/fake-client.env \
//        --as tara.kapoor@synthetic.invalid [--member kedab.mifos@synthetic.invalid] [--redirect https://…/callback] [--keep]
//
// --client-file: an env file (mode 600) with PULSE_CLIENT_ID and PULSE_CLIENT_SECRET of an app registered on that Pulse.
// --as: an admin of the organisation (links it); --member: signs in personally. --keep leaves the org link in place.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const flag = (name) => process.argv.includes(`--${name}`);
const BASE = arg('base', 'http://127.0.0.1:3200'), FILE = arg('client-file'), ADMIN = arg('as'), MEMBER = arg('member', ADMIN);
if (!FILE || !ADMIN) { console.error('usage: fake-client.mjs --client-file FILE --as admin@example [--member person@example] [--base URL] [--redirect URI] [--keep]'); process.exit(2); }
if ((statSync(FILE).mode & 0o077) !== 0) { console.error(`${FILE} must be readable by its owner only (chmod 600)`); process.exit(2); }
const env = Object.fromEntries(readFileSync(FILE, 'utf8').split('\n').map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const CLIENT = env.PULSE_CLIENT_ID, SECRET = env.PULSE_CLIENT_SECRET;
if (!CLIENT || !SECRET) { console.error('the client file needs PULSE_CLIENT_ID and PULSE_CLIENT_SECRET'); process.exit(2); }

const report = { base: BASE, steps: [] };
const step = (name, ok, detail = '') => { report.steps.push({ name, ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); if (!ok) process.exitCode = 1; return ok; };
const b64 = (s) => Buffer.from(s, 'base64url');
let issuer = BASE;
/** The issuer's public addresses, reached through this machine's own web server. */
const local = (url) => url.startsWith(issuer) ? BASE + url.slice(issuer.length) : url;
const http = async (url, init = {}) => {
  const r = await fetch(local(url), { redirect: 'manual', ...init });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, headers: r.headers };
};
const basic = 'Basic ' + Buffer.from(`${encodeURIComponent(CLIENT)}:${encodeURIComponent(SECRET)}`).toString('base64');
const form = (url, body) => http(url, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const as = (email) => ({ 'cf-access-authenticated-user-email': email, 'content-type': 'application/json' });

/** RS256 ID token: signature by the JWKS key named in its header, then iss, aud, exp, nonce. */
function checkIdToken(jwt, jwks, nonce) {
  const [h, p, s] = jwt.split('.'), head = JSON.parse(b64(h)), claims = JSON.parse(b64(p));
  const jwk = jwks.keys.find((k) => k.kid === head.kid);
  const signed = !!jwk && head.alg === 'RS256' && verify('sha256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), b64(s));
  const now = Date.now() / 1000;
  return { ok: signed && claims.iss === issuer && claims.aud === CLIENT && claims.exp > now && claims.exp - claims.iat <= 600 && (!nonce || claims.nonce === nonce), claims };
}

async function authorize(email, scope, redirect, extra = {}) {
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(12).toString('hex'), nonce = randomBytes(12).toString('hex');
  const query = { response_type: 'code', client_id: CLIENT, redirect_uri: redirect, scope, state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...extra.query };
  const page = await http(`${disc.authorization_endpoint}?${new URLSearchParams(query)}`, { headers: { 'cf-access-authenticated-user-email': email } });
  step(`consent screen for ${email.split('@')[0]}`, page.status === 200 && /Sign in with Pulse/.test(page.text), `HTTP ${page.status}`);
  const allow = await http(`${BASE}/api/v0/oidc/authorize/allow`, { method: 'POST', headers: as(email), body: JSON.stringify({ query, off: extra.off ?? [] }) });
  if (!step('Allow', allow.status === 200 && typeof allow.json?.redirect === 'string', allow.json?.error ?? '')) return null;
  const back = new URL(allow.json.redirect);
  step('back with code, state and iss', back.searchParams.get('state') === state && back.searchParams.get('iss') === issuer && !!back.searchParams.get('code'));
  const t = await form(disc.token_endpoint, { grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: verifier, redirect_uri: redirect });
  step('code swapped for tokens', t.status === 200 && !!t.json?.access_token, t.json?.error ?? `scope ${t.json?.scope ?? ''}`);
  return t.status === 200 ? { ...t.json, nonce } : null;
}

const disc = (await http(`${BASE}/.well-known/openid-configuration`)).json;
if (!step('discovery', !!disc?.issuer, disc ? disc.issuer : 'no discovery document (PULSE_OIDC on? signing key?)')) process.exit(1);
issuer = disc.issuer;
const jwks = (await http(disc.jwks_uri)).json;
step('JWKS', jwks?.keys?.length > 0, `${jwks?.keys?.length ?? 0} key(s)`);
const redirect = arg('redirect', `${issuer.replace(/\/$/, '')}/fake-client/callback`);

// ----- Sign in with Pulse (personal)
const me = await authorize(MEMBER, 'openid profile email pulse.orgs', redirect);
if (me) {
  const id = checkIdToken(me.id_token, jwks, me.nonce);
  step('ID token verifies (RS256, iss, aud, exp ≤ 10 min, nonce)', id.ok);
  const c = id.claims;
  report.signedIn = { sub: c.sub, name: c.name, title: c.title ?? null, team: c.team ?? null, email: c.email, email_verified: c.email_verified, orgs: c.pulse_orgs, picture: !!c.picture };
  step('claims', !!c.sub && !!c.name && Array.isArray(c.pulse_orgs), `${c.name} · ${c.title ?? 'no title'} · ${c.team ?? 'no team'} · ${c.pulse_orgs?.length ?? 0} org(s) · e-mail checked: ${c.email_verified}`);
  const ui = await http(disc.userinfo_endpoint, { headers: { authorization: `Bearer ${me.access_token}` } });
  step('userinfo agrees', ui.status === 200 && ui.json?.sub === c.sub);
  if (c.picture) { const ph = await http(c.picture); step('photo without a token', ph.status === 200 && /^image\//.test(ph.headers.get('content-type') ?? ''), ph.headers.get('content-type') ?? `HTTP ${ph.status}`); }
}

// ----- the organisation link
const link = await authorize(ADMIN, 'openid profile pulse.org.read pulse.org.webhooks pulse.signals.write pulse.clients.read pulse.leads.write pulse.calls.write pulse.money.read', redirect, { off: ['pulse.money.read'] });
if (link) {
  const org = link.pulse_org_id, api = `${disc.pulse_org_api_base}/orgs/${org}`, auth = { authorization: `Bearer ${link.access_token}` };
  step('org link', !!org && !!link.refresh_token, `organisation ${org}`);
  let page = await http(`${api}/members?limit=50`, { headers: auth }), members = [...(page.json?.members ?? [])];
  while (page.json?.next_cursor) { page = await http(`${api}/members?limit=50&cursor=${page.json.next_cursor}`, { headers: auth }); members.push(...(page.json?.members ?? [])); }
  step('members', page.status === 200 && members.length > 0, `${members.length} members, ${members.filter((m) => m.picture).length} with photos, ${members.filter((m) => m.title).length} with titles`);
  report.members = members.length;
  const sub = report.signedIn?.sub;
  if (sub) step('the signed-in person is a member with the same sub', members.some((m) => m.sub === sub));
  const clients = await http(`${api}/clients?limit=5`, { headers: auth });
  step('clients', clients.status === 200, `${clients.json?.clients?.length ?? 0} on the first page`);
  const money = await http(`${api}/money/clients`, { headers: auth });
  step('money is off until an admin switches it on', money.status === 403);
  if (sub) {
    const sg = await http(`${api}/signals`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ sub, kind: 'calls_analysed', day: new Date().toISOString().slice(0, 10), value: 1 }] }) });
    step('a work signal', sg.status === 200 && sg.json?.accepted === 1);
  }
  const hook = await http(`${api}/webhooks`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://fake-client.example.invalid/pulse/webhook', events: ['person.updated'] }) });
  step('webhook endpoint registered', hook.status === 201 && /^pwhs_/.test(hook.json?.secret ?? ''));
  if (hook.json?.id) step('and removed', (await http(`${api}/webhooks/${hook.json.id}`, { method: 'DELETE', headers: auth })).status === 204);
  const r = await form(disc.token_endpoint, { grant_type: 'refresh_token', refresh_token: link.refresh_token });
  step('refresh rotates', r.status === 200 && r.json?.refresh_token && r.json.refresh_token !== link.refresh_token);
  step('a swapped refresh token is refused', (await form(disc.token_endpoint, { grant_type: 'refresh_token', refresh_token: link.refresh_token })).json?.error === 'invalid_grant');
  if (!flag('keep')) {
    // The reuse above ended the link's tokens; sign in once more to end the link itself, as Disconnect does.
    const again = await authorize(ADMIN, 'openid pulse.org.read', redirect);
    if (again) step('the app ends its link', (await http(`${api}/link`, { method: 'DELETE', headers: { authorization: `Bearer ${again.access_token}` } })).status === 204);
  }
}
if (me?.refresh_token) await form(disc.revocation_endpoint, { token: me.refresh_token });
console.log(JSON.stringify({ ok: !process.exitCode, ...report }, null, 1));
