// PORTAL-2: the client e-mails (client-mail.ts): their own sender, never HR; links carry the token only in the fragment;
// the daily summary lists what is new with its links and how to turn it off. Fake names and addresses only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { accountMail, clientMail, clientMailFrom, digestMail } from '../dist/client-mail.js';
import { testMail } from '../dist/auth-mail.js';

test('the client sender is its own setting, else admin@ of the Google domain; never the HR mailbox', () => {
  const keep = { from: process.env.PULSE_CLIENT_MAIL_FROM, domain: process.env.PULSE_GOOGLE_DOMAIN };
  try {
    delete process.env.PULSE_CLIENT_MAIL_FROM; process.env.PULSE_GOOGLE_DOMAIN = 'fake-agency.example';
    assert.equal(clientMailFrom(), 'admin@fake-agency.example');
    process.env.PULSE_CLIENT_MAIL_FROM = 'Hello@Fake-Agency.example';
    assert.equal(clientMailFrom(), 'hello@fake-agency.example');
    process.env.PULSE_CLIENT_MAIL_FROM = 'not an address';
    assert.equal(clientMailFrom(), 'admin@fake-agency.example');
  } finally {
    if (keep.from === undefined) delete process.env.PULSE_CLIENT_MAIL_FROM; else process.env.PULSE_CLIENT_MAIL_FROM = keep.from;
    if (keep.domain === undefined) delete process.env.PULSE_GOOGLE_DOMAIN; else process.env.PULSE_GOOGLE_DOMAIN = keep.domain;
  }
});

test('account e-mails say what the link does, how long it lasts, and keep the token in the fragment', () => {
  const r = { name: 'Rila Fakewala', org: 'Fake Agency', handle: 'riyafake', minutes: 15 };
  const link = 'https://pulse.example.test/login/account-link#' + 'a'.repeat(43);
  const signin = accountMail('signin', r, link);
  assert.match(signin.subject, /sign-in link for Fake Agency/);
  assert.ok(signin.body.startsWith('Hi Rila,') && signin.body.includes(link) && signin.body.includes('15 minutes') && signin.body.includes('@riyafake'));
  const reset = accountMail('reset', { ...r, minutes: 60 }, link.replace('account-link', 'account-reset'));
  assert.ok(reset.body.includes('60 minutes') && /signed out/.test(reset.body));
  const confirm = accountMail('confirm', r, link.replace('account-link', 'account-confirm'));
  assert.ok(confirm.body.includes('24 hours'));
  for (const m of [signin, reset, confirm]) assert.doesNotMatch(m.body, /\?token=/);
});

test('the daily summary lists what is new with links, and how to turn it off', () => {
  const items = Array.from({ length: 23 }, (_, i) => ({ title: `Thing ${i + 1} (fake)`, href: `/client/review/${i}`, at: '2026-10-25T08:00:00Z' }));
  const one = digestMail({ name: 'Rila Fakewala', org: 'Fake Agency', items: items.slice(0, 1) }, 'https://pulse.example.test');
  assert.equal(one.subject, 'Fake Agency: Thing 1 (fake)');
  const many = digestMail({ name: 'Rila Fakewala', org: 'Fake Agency', items }, 'https://pulse.example.test');
  assert.equal(many.subject, 'Fake Agency: 23 new things in your space');
  assert.ok(many.body.includes('https://pulse.example.test/client/review/0') && many.body.includes('…and 3 more'));
  assert.ok(many.body.includes('https://pulse.example.test/client?digest=off'));
});

test('client mail goes to the sink with its sender, company name and Reply-To; nothing for a bad address', async () => {
  const keep = process.env.PULSE_AUTH_MAIL_MODE; process.env.PULSE_AUTH_MAIL_MODE = 'sink';
  try {
    const before = testMail.length;
    assert.equal(await clientMail({ to: 'rila@fake-client.example', subject: 'Hello', body: 'Body', company: 'Fake "Agency"\r\nBcc: x', replyTo: 'kedab@fake-agency.example' }), true);
    const m = testMail.at(-1);
    assert.equal(m.to, 'rila@fake-client.example');
    assert.equal(m.replyTo, 'kedab@fake-agency.example');
    assert.equal(m.fromName, 'Fake AgencyBcc: x');
    assert.doesNotMatch(m.from, /^hr@/);
    assert.equal(await clientMail({ to: 'nobody', subject: 'x', body: 'y' }), false);
    assert.equal(testMail.length, before + 1);
  } finally { if (keep === undefined) delete process.env.PULSE_AUTH_MAIL_MODE; else process.env.PULSE_AUTH_MAIL_MODE = keep; }
});
