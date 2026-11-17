// MAIL-GUARD (5 Nov 2026): staging holds a copy of real company data, and sendMail chose a company's connected mailbox
// before any allow-list check. Now one guard at the top of sendMail (platform-config.ts mailRecipientAllowed) keeps
// every route, the company mailbox included, to PULSE_MAIL_STAGING_ALLOW off production; production is unchanged.
// Fake companies and addresses only; nothing is sent (fetch and the database are stubbed).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mailProductionLive, mailRecipientAllowed } from '../dist/platform-config.js';
import { recipientAllowed, refusedMail, sendMail, testMail } from '../dist/mail-send.js';
import { allowedRecipient, companyMail, testCompanyMail } from '../dist/mailbox.js';

const KEYS = ['RESEND_API_KEY', 'RESEND_FROM', 'PULSE_PLATFORM_MAIL_FROM', 'PULSE_MAIL_FROM', 'PULSE_CLIENT_MAIL_FROM', 'PULSE_PUBLIC_URL', 'PULSE_CI',
  'PULSE_GMAIL_SEND_ENABLED', 'PULSE_AUTH_MAIL_MODE', 'NODE_ENV', 'PULSE_GOOGLE_DOMAIN', 'PULSE_ENV', 'PULSE_MAIL_PRODUCTION_HOST',
  'PULSE_MAIL_STAGING_ALLOW', 'PULSE_PLATFORM_DOMAIN'];
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
/** Every outbound request is recorded and answered; nothing leaves the test. */
async function withFetch(fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ id: 'synthetic-id' }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
/** A company with a connected mailbox, as the tenant connection would show it (queries recorded). */
function companyDb(address = 'hr@acme.example.test') {
  const queries = [];
  const client = { query: async (sql) => {
    queries.push(sql);
    if (/org_mailbox_sealed/.test(sql)) return { rows: [{ address, sealed: 'synthetic-sealed', client: null }] };
    if (/from pulse\.org where/.test(sql)) return { rows: [{ name: 'Acme Fake' }] };
    return { rows: [] };
  } };
  return { queries, within: async (fn) => fn(client) };
}

const ACME = { org: 'org-acme', name: 'Acme Fake', install: false, mailbox: 'hr@acme.example.test', replyTo: 'hr@acme.example.test', logoPng: null };
const ALLOW = 'qa@estate.example.test';
const common = { PULSE_MAIL_FROM: 'hr@estate.example.test', PULSE_MAIL_STAGING_ALLOW: ALLOW, PULSE_GMAIL_SEND_ENABLED: '1', NODE_ENV: 'production', RESEND_API_KEY: 'synthetic-resend-key' };
const STAGING = { ...common, PULSE_ENV: 'staging', PULSE_PUBLIC_URL: 'https://pulse-staging.example.test' };
const DEV = { ...common, PULSE_ENV: 'dev', PULSE_PUBLIC_URL: 'https://pulse-dev.example.test' };
const PRODUCTION = { ...common, PULSE_ENV: 'production', PULSE_PUBLIC_URL: 'https://pulse.example.test' };

test('production twice over: PULSE_ENV says production and the public host is the mail production host', () => {
  assert.equal(mailProductionLive(PRODUCTION), true);
  assert.equal(mailProductionLive({ ...PRODUCTION, PULSE_ENV: 'prod', PULSE_MAIL_PRODUCTION_HOST: 'pulse.example.test' }), true);
  assert.equal(mailProductionLive(STAGING), false);
  assert.equal(mailProductionLive(DEV), false);
  // A staging server pointed at itself as the production host is still staging.
  assert.equal(mailProductionLive({ ...STAGING, PULSE_MAIL_PRODUCTION_HOST: 'pulse-staging.example.test' }), false);
  // Production's environment on another host than the named production host (a copy, a lab) is not production.
  assert.equal(mailProductionLive({ ...PRODUCTION, PULSE_MAIL_PRODUCTION_HOST: 'pulse.example.test', PULSE_PUBLIC_URL: 'https://pulse-lab.example.test' }), false);
  assert.equal(mailProductionLive({ ...PRODUCTION, PULSE_PUBLIC_URL: 'not a url' }), false);
  assert.equal(mailProductionLive({}), false);
  assert.equal(mailRecipientAllowed('client@customer.example.test', PRODUCTION), true);
  assert.equal(mailRecipientAllowed('client@customer.example.test', STAGING), false);
  assert.equal(mailRecipientAllowed(' QA@Estate.Example.Test ', STAGING), true);
  assert.equal(mailRecipientAllowed('', STAGING), false);
  assert.equal(recipientAllowed('client@customer.example.test', DEV), false);
});

test('staging and dev: "Send by email" through a company mailbox to a client sends nothing and is logged', async () => {
  for (const env of [STAGING, DEV, { ...STAGING, PULSE_MAIL_PRODUCTION_HOST: 'pulse-staging.example.test' }]) {
    await withEnv(env, () => withFetch(async (calls) => {
      const db = companyDb();
      const sinkBefore = testMail.length, companyBefore = testCompanyMail.length, refusedBefore = refusedMail.length;
      const ok = await sendMail({ kind: 'org', to: 'buyer@customer.example.test', title: 'Quotation QT/1 from Acme Fake', body: 'Hello',
        org: ACME, within: db.within, attachments: [{ filename: 'QT-1.pdf', contentType: 'application/pdf', base64: Buffer.from('%PDF-1.4 synthetic').toString('base64') }] });
      assert.equal(ok, false);
      assert.equal(calls.length, 0, 'no request left the server');
      assert.equal(db.queries.length, 0, 'the company mailbox was never opened');
      assert.equal(testMail.length, sinkBefore); assert.equal(testCompanyMail.length, companyBefore);
      assert.deepEqual(refusedMail.slice(refusedBefore), [{ kind: 'org', domain: 'customer.example.test' }]);
    }));
  }
});

test('staging: every other route (sign-up codes, notices, invitations) is refused for a non-allow-listed address too', async () => {
  await withEnv(STAGING, () => withFetch(async (calls) => {
    assert.equal(await sendMail({ kind: 'platform', to: 'someone@customer.example.test', title: 'Your code', body: '123456', org: null }), false);
    assert.equal(await sendMail({ kind: 'org', to: 'someone@customer.example.test', title: 'Leave approved', body: 'x',
      org: { org: 'org-install', name: 'Estate Fake', install: true, mailbox: null, replyTo: null, logoPng: null } }), false);
    assert.equal(await sendMail({ kind: 'org', to: 'someone@customer.example.test', title: 'Invite', body: 'x', org: null,
      installSender: { from: 'hr@estate.example.test', fromName: 'Estate Fake' } }), false);
    assert.equal(calls.length, 0);
  }));
});

test('staging: the company mailbox itself refuses its own (copied, real) address and any non-allow-listed one', async () => {
  await withEnv(STAGING, () => withFetch(async (calls) => {
    assert.equal(allowedRecipient('hr@acme.example.test', 'hr@acme.example.test'), false);
    assert.equal(await companyMail('org-acme', 'hr@acme.example.test', 'Pulse can send from this mailbox', 'x', companyDb().within), 'refused');
    assert.equal(await companyMail('org-acme', 'buyer@customer.example.test', 'Invoice', 'x', companyDb().within), 'refused');
    assert.equal(calls.length, 0);
  }));
});

test('staging: an allow-listed address still goes through the guard to the company mailbox', async () => {
  await withEnv(STAGING, () => withFetch(async () => {
    const db = companyDb();
    const refusedBefore = refusedMail.length;
    await sendMail({ kind: 'org', to: ALLOW, title: 'Quotation', body: 'x', org: ACME, within: db.within });
    assert.equal(refusedMail.length, refusedBefore);
    assert.ok(db.queries.some((q) => /org_mailbox_sealed/.test(q)), 'the mailbox route was reached');
  }));
});

test('the sink (CI and tests) still records, whatever the recipient', async () => {
  await withEnv({ ...STAGING, PULSE_CI: '1' }, async () => {
    const before = testCompanyMail.length;
    assert.equal(await sendMail({ kind: 'org', to: 'buyer@customer.example.test', title: 'Quotation', body: 'x', org: ACME, within: companyDb().within }), true);
    assert.equal(testCompanyMail.at(-1).to, 'buyer@customer.example.test');
    assert.equal(testCompanyMail.length, before + 1);
  });
});

test('production is unchanged: a client address goes out (Resend) and reaches the company mailbox route', async () => {
  await withEnv(PRODUCTION, () => withFetch(async (calls) => {
    const refusedBefore = refusedMail.length;
    assert.equal(await sendMail({ kind: 'platform', to: 'someone@customer.example.test', title: 'Your code', body: '123456', org: null }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.deepEqual(JSON.parse(calls[0].init.body).to, ['someone@customer.example.test']);
    const db = companyDb();
    await sendMail({ kind: 'org', to: 'buyer@customer.example.test', title: 'Quotation', body: 'x', org: ACME, within: db.within });
    assert.ok(db.queries.some((q) => /org_mailbox_sealed/.test(q)), 'the company mailbox route was reached');
    assert.equal(allowedRecipient('buyer@customer.example.test', 'hr@acme.example.test'), true);
    assert.equal(refusedMail.length, refusedBefore);
  }));
});
