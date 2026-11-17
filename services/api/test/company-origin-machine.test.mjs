// AGENT-LINK (7 Nov 2026): a request on this machine's own address (the AI runtime calls 127.0.0.1) links to an address
// people can open: the shared family's app for another company, the install's address for its own. Synthetic hosts only.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PULSE_HOST_FAMILIES = JSON.stringify([{ name: 'synthetic', app: 'app.synthetic.test', api: 'api.synthetic.test' }]);
process.env.PULSE_PUBLIC_URL = 'https://install.synthetic.test';
const { companyOrigin, runWithCompany } = await import('../dist/tenant-context.js');
const company = { org: '00000000-0000-4000-8000-0000000000c1', signIn: 'password', status: 'active', rehearsal: false };
const at = (ctx) => new Promise((resolve) => runWithCompany(ctx, () => resolve(companyOrigin())));

test('links from the AI runtime on 127.0.0.1 point at an address people can open', async () => {
  assert.equal(await at({ host: '127.0.0.1', raw: '127.0.0.1:4002', company }), 'https://app.synthetic.test');
  assert.equal(await at({ host: '127.0.0.1', raw: '127.0.0.1:4002', company: null }), 'https://install.synthetic.test');
  assert.equal(await at({ host: 'localhost', raw: 'localhost:4002', company }), 'https://app.synthetic.test');
  assert.equal(await at({ host: 'acme.synthetic.test', raw: 'acme.synthetic.test', company }), 'https://acme.synthetic.test');
  assert.equal(await at({ host: 'app.synthetic.test', raw: 'app.synthetic.test', company }), 'https://app.synthetic.test');
});
