// WL-BHARATA-E2E: an acceptance link names the company's own address. Called on the shared address (a connected app's key,
// e.g. Willow Lane's WAS), companyOrigin() is the platform's, where the token is never found ("This link is not valid").
import assert from 'node:assert/strict';
import test from 'node:test';
import { companyLinkOrigin, companyOrigin, runWithCompany } from '../dist/tenant-context.js';

const on = (raw, company, primary) => { let out; runWithCompany({ host: raw ? raw.replace(/:\d+$/, '') : null, raw, company }, () => { out = [companyLinkOrigin(primary), companyOrigin()]; }); return out; };

test('the link uses the company primary address, also when the call came in on the shared address', () => {
  const prev = process.env.PULSE_PUBLIC_URL; process.env.PULSE_PUBLIC_URL = 'https://shared.example.test';
  try {
    assert.deepEqual(on('shared.example.test', null, 'pulse.acme.example.test'), ['https://pulse.acme.example.test', 'https://shared.example.test']);
    assert.equal(on('shared.example.test', null, 'acme.localhost')[0], 'http://acme.localhost', 'a .localhost address keeps http');
    assert.equal(on('shared.example.test', null, null)[0], 'https://shared.example.test', 'no own address: as before');
    assert.equal(on('shared.example.test', null, undefined)[0], on('shared.example.test', null, undefined)[1]);
  } finally { if (prev === undefined) delete process.env.PULSE_PUBLIC_URL; else process.env.PULSE_PUBLIC_URL = prev; }
});
