// FIX-SHELL (owner walkthrough, 10 Nov 2026: "links inside the app and the AI's answers say the install's old address;
// they must use the app's address, with company paths such as app.<domain>/@company/…"). linkOrigin(): the shared
// family's app address plus the company's @handle wherever the request has no address of a company's own; a company's
// own address keeps its own host; sign-in links (companyOrigin) do not move. Synthetic hosts only.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PULSE_HOST_FAMILIES = JSON.stringify([{ name: 'synthetic', app: 'app.synthetic.test', api: 'api.synthetic.test' }]);
process.env.PULSE_PUBLIC_URL = 'https://install.synthetic.test';
const { companyOrigin, linkOrigin, noteLinkHandle, runWithCompany } = await import('../dist/tenant-context.js');
const company = { org: '00000000-0000-4000-8000-0000000000c1', signIn: 'password', status: 'active', rehearsal: false };
const at = (ctx, handle) => new Promise((resolve) => runWithCompany(ctx, () => { if (handle !== undefined) noteLinkHandle(handle); resolve([linkOrigin(), companyOrigin()]); }));

test('links point at the shared app address and the company path, not the install\'s old address', async () => {
  // The AI runtime on this machine, for the install's own company: the shared app address with the company path.
  assert.deepEqual(await at({ host: '127.0.0.1', raw: '127.0.0.1:4002', company: null }, 'synthco'), ['https://app.synthetic.test/@synthco', 'https://install.synthetic.test']);
  // A person on the install's old address: links move to the app address; sign-in stays where they are.
  assert.deepEqual(await at({ host: 'install.synthetic.test', raw: 'install.synthetic.test', company: null }, 'synthco'), ['https://app.synthetic.test/@synthco', 'https://install.synthetic.test']);
  // On the app address itself: the company path once the handle is known, the bare address before.
  assert.deepEqual(await at({ host: 'app.synthetic.test', raw: 'app.synthetic.test', company }, 'synthco'), ['https://app.synthetic.test/@synthco', 'https://app.synthetic.test']);
  assert.deepEqual(await at({ host: 'app.synthetic.test', raw: 'app.synthetic.test', company }), ['https://app.synthetic.test', 'https://app.synthetic.test']);
  // A family's api host: links go to its app host.
  assert.equal((await at({ host: 'api.synthetic.test', raw: 'api.synthetic.test', company: null }))[0], 'https://app.synthetic.test');
  // A company's own address keeps its own host, with no company path (the address is the company).
  assert.deepEqual(await at({ host: 'acme.synthetic.test', raw: 'acme.synthetic.test', company }, 'acme'), ['https://acme.synthetic.test', 'https://acme.synthetic.test']);
  // A handle that is not a plain handle is never put in a link.
  assert.equal((await at({ host: '127.0.0.1', raw: '127.0.0.1:4002', company: null }, '../evil'))[0], 'https://app.synthetic.test');
});

test('without a listed family (a self-hosted install) links stay as companyOrigin()', async () => {
  const saved = process.env.PULSE_HOST_FAMILIES;
  process.env.PULSE_HOST_FAMILIES = '[]';
  try {
    const [link, origin] = await at({ host: '127.0.0.1', raw: '127.0.0.1:4002', company: null }, 'synthco');
    assert.equal(link, origin);
    assert.equal(link, 'https://install.synthetic.test');
  } finally { process.env.PULSE_HOST_FAMILIES = saved; }
});
