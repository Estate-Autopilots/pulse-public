// VITALS-HOSTS (owner, 4 Nov 2026: "move Pulse to vitalsos.ai"): the API's view of the platform host families (links,
// sign-in origin, OAuth `iss`, reserved company addresses), and that it agrees with the web's copy. Synthetic hosts only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { hostFamilies, hostFamily, familySignInHost, reservedHost } from '../dist/host-families.js';
import { companyOrigin, oauthIssuer, runWithCompany } from '../dist/tenant-context.js';
import { withReserved } from '../dist/tenants.js';
import * as web from '../../../apps/web/app/lib/host-families.mjs';

const FAMILY = { name: 'vitals', app: 'app.vitals.test', api: 'api.vitals.test', mcp: 'mcp.vitals.test', id: 'id.vitals.test' };
const env = { PULSE_HOST_FAMILIES: JSON.stringify([FAMILY]), PULSE_PUBLIC_URL: 'https://pulse.legacy.test' };

test("the API and the web read the same families and give every host the same answer", () => {
  const envs = [env, {}, { PULSE_PUBLIC_URL: 'https://pulse.legacy.test' }, { PULSE_HOST_FAMILIES: '{oops' },
    { PULSE_HOST_FAMILIES: JSON.stringify([{ name: 'a', app: 'app.a.test' }, { name: 'b', app: 'app.b.test', mcp: 'app.a.test' }, { app: 'x.localhost', id: 'id.x.localhost' }]) }];
  const hosts = ['app.vitals.test', 'API.vitals.test', 'mcp.vitals.test:443', 'id.vitals.test.', 'pulse.legacy.test', 'acme.vitals.test', 'app.a.test',
    'app.b.test', 'id.x.localhost:4410', 'x.localhost:4410', '', null, 'not a host'];
  for (const e of envs) {
    assert.deepEqual(hostFamilies(e), web.hostFamilies(e));
    for (const h of hosts) assert.deepEqual(hostFamily(h, e), web.hostFamily(h, e), `${h} under ${e.PULSE_HOST_FAMILIES}`);
  }
});

test("links and sign-in stay on the family host the person uses", () => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const on = (raw, company = null) => { let out; runWithCompany({ host: raw ? raw.replace(/:\d+$/, '') : null, raw, company }, () => { out = [companyOrigin(), oauthIssuer()]; }); return out; };
    assert.deepEqual(on('app.vitals.test'), ['https://app.vitals.test', 'https://id.vitals.test']);
    assert.deepEqual(on('id.vitals.test'), ['https://id.vitals.test', 'https://id.vitals.test']);
    // api and mcp are not where people sign in: their links go to the family's app host.
    assert.deepEqual(on('mcp.vitals.test'), ['https://app.vitals.test', 'https://id.vitals.test']);
    assert.deepEqual(on('api.vitals.test'), ['https://app.vitals.test', 'https://id.vitals.test']);
    // The install's address and a company's own address behave as before.
    assert.deepEqual(on('pulse.legacy.test'), ['https://pulse.legacy.test', 'https://pulse.legacy.test']);
    assert.deepEqual(on(null), ['https://pulse.legacy.test', 'https://pulse.legacy.test']);
    const acme = { org: '00000000-0000-4000-8000-000000000001', signIn: 'password', status: 'active', rehearsal: false };
    assert.deepEqual(on('acme.example.test', acme), ['https://acme.example.test', 'https://acme.example.test']);
    // An unclaimed host outside every family is the install's (PULSE_PUBLIC_URL), as before.
    assert.deepEqual(on('other.example.test'), ['https://pulse.legacy.test', 'https://pulse.legacy.test']);
    // A *.localhost rehearsal of the family keeps the port in use.
    process.env.PULSE_HOST_FAMILIES = JSON.stringify([{ name: 'vitals', app: 'app.vitals.localhost', mcp: 'mcp.vitals.localhost', id: 'id.vitals.localhost' }]);
    assert.deepEqual(on('mcp.vitals.localhost:4410'), ['http://app.vitals.localhost:4410', 'http://id.vitals.localhost:4410']);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("the install's Google sign-in may start on a family's app and id hosts only", () => {
  assert.equal(familySignInHost('app.vitals.test', env), true);
  assert.equal(familySignInHost('id.vitals.test', env), true);
  assert.equal(familySignInHost('api.vitals.test', env), false);
  assert.equal(familySignInHost('mcp.vitals.test', env), false);
  // The install's own address keeps its existing check (PULSE_PUBLIC_URL), not this one.
  assert.equal(familySignInHost('pulse.legacy.test', env), false);
  assert.equal(familySignInHost('acme.vitals.test', env), false);
});

test("no company may claim Pulse's own addresses or reserved names under its domain", () => {
  assert.match(reservedHost('app.vitals.test', env), /one of Pulse's own addresses/);
  assert.match(reservedHost('MCP.vitals.test', env), /one of Pulse's own addresses/);
  assert.match(reservedHost('vitals.test', env), /Pulse's own domain/);
  for (const label of ['www', 'docs', 'status', 'admin', 'app-staging', 'fallback', 'customers']) assert.match(reservedHost(`${label}.vitals.test`, env), /kept for Pulse itself/);
  assert.equal(reservedHost('acme.vitals.test', env), null);
  assert.equal(reservedHost('pulse.acme.test', env), null);
  // The install's own address is left to the existing rules (its company may hold it), and nothing is reserved unconfigured.
  assert.equal(reservedHost('pulse.legacy.test', env), null);
  assert.equal(reservedHost('app.vitals.test', {}), null);
  assert.equal(reservedHost('', env), null);
  // A reserved address turns the plan into a preview that says why, first.
  const plan = { ok: true, applied: true, problems: ['Other'], warnings: [], creates: [] };
  assert.deepEqual(withReserved(plan, 'kept'), { ok: false, applied: false, problems: ['kept', 'Other'], warnings: [], creates: [] });
  assert.equal(withReserved(plan, null), plan);
});
