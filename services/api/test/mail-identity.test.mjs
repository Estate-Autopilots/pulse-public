// MAIL-IDENTITY (owner, 4 Nov 2026): the sign-up code for a new organisation on app.vitalsos.ai came from
// hr@estateautopilots.com with the Estate Autopilots logo. Who a message is from is now chosen per kind of mail and per
// company (mail-identity.ts), Resend sends the platform's mail (mail-provider.ts), and every message has an HTML part
// that suits Gmail and a plain-text part (mail-template.ts). Fake companies and addresses only; nothing is sent.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseSender, fromLine } from '../dist/mail-identity.js';
import { parseSender, platformSender, resendFor, resendRequest, resendSend } from '../dist/mail-provider.js';
import { renderMail } from '../dist/mail-template.js';
import { sendMail, testMail } from '../dist/mail-send.js';
import { authMail, pulseMail } from '../dist/auth-mail.js';
import { mimeMessage } from '../dist/mailbox.js';
import { clientMail } from '../dist/client-mail.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
const INSTALL = { org: 'org-install', name: 'Estate Autopilots', install: true, mailbox: null, replyTo: 'hr@estate.example.test' };
const WITH_MAILBOX = { org: 'org-acme', name: 'Acme Fake', install: false, mailbox: 'HR@Acme.example.test', replyTo: 'hr@acme.example.test' };
const NO_MAILBOX = { org: 'org-vitals', name: 'Vitals Fake', install: false, mailbox: null, replyTo: 'Owner@Vitals.example.test' };
const base = { PULSE_MAIL_FROM: 'hr@estate.example.test', PULSE_PUBLIC_URL: 'https://pulse.example.test' };
const withResend = { ...base, RESEND_API_KEY: 'synthetic-resend-key' };

/** Run with these variables set (and the mail ones not listed removed), then put everything back. */
async function withEnv(vars, fn) {
  const keys = ['RESEND_API_KEY', 'RESEND_FROM', 'PULSE_PLATFORM_MAIL_FROM', 'PULSE_MAIL_FROM', 'PULSE_CLIENT_MAIL_FROM', 'PULSE_PUBLIC_URL', 'PULSE_CI', 'PULSE_GMAIL_SEND_ENABLED', 'PULSE_AUTH_MAIL_MODE', 'NODE_ENV', 'PULSE_GOOGLE_DOMAIN'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('the platform sender is "Pulse by Vitals" <no-reply@org-9912dc.example> unless PULSE_PLATFORM_MAIL_FROM says otherwise', () => {
  assert.deepEqual(platformSender({}), { name: 'Pulse by Vitals', address: 'no-reply@org-9912dc.example' });
  assert.deepEqual(platformSender({ PULSE_PLATFORM_MAIL_FROM: '"Pulse" <Hello@org-9912dc.example>' }), { name: 'Pulse', address: 'hello@org-9912dc.example' });
  assert.deepEqual(platformSender({ PULSE_PLATFORM_MAIL_FROM: 'user-b7ff0ea3@org-9912dc.example' }), { name: 'Pulse by Vitals', address: 'user-b7ff0ea3@org-9912dc.example' });
  assert.deepEqual(platformSender({ PULSE_PLATFORM_MAIL_FROM: 'not an address', RESEND_FROM: 'Pulse <user-64e11d34@org-9912dc.example>' }), { name: 'Pulse', address: 'user-64e11d34@org-9912dc.example' });
  assert.equal(parseSender('a@b'), null);
});

test('platform mail (codes, sign-up, invitations into a new company, account notices) is from Vitals, never a company', () => {
  // Resend set up: always the platform's address and Pulse's look, whoever the mail is about.
  for (const org of [null, INSTALL, WITH_MAILBOX, NO_MAILBOX]) {
    const s = chooseSender('platform', org, withResend);
    assert.equal(s.route, 'resend'); assert.equal(fromLine(s), '"Pulse by Vitals" <no-reply@org-9912dc.example>'); assert.equal(s.brand, 'pulse');
  }
  // In a company's context it answers to the company: its mailbox, else its admin. Sign-up (no company) and the
  // install's own addresses answer nowhere but Pulse, and are never about the install's company.
  assert.equal(chooseSender('platform', WITH_MAILBOX, withResend).replyTo, 'hr@acme.example.test');
  assert.equal(chooseSender('platform', NO_MAILBOX, withResend).replyTo, 'owner@vitals.example.test');
  assert.equal(chooseSender('platform', NO_MAILBOX, withResend).orgName, 'Vitals Fake');
  assert.equal(chooseSender('platform', null, withResend).replyTo, null);
  assert.equal(chooseSender('platform', INSTALL, withResend).orgName, null);
  // Without Resend, the existing provider: the install's sender under Pulse's name and look, a company's own mailbox
  // on its own address, else nothing.
  const fallback = chooseSender('platform', null, base);
  assert.deepEqual([fallback.route, fallback.from, fallback.fromName, fallback.brand], ['install', 'hr@estate.example.test', 'Pulse by Vitals', 'pulse']);
  assert.equal(chooseSender('platform', WITH_MAILBOX, base).route, 'mailbox');
  assert.equal(chooseSender('platform', NO_MAILBOX, base).route, 'none');
  assert.equal(chooseSender('platform', null, { PULSE_PUBLIC_URL: 'https://localhost' }).route, 'none');
});

test('organisation mail carries the company: its own sender, else the platform address "via Pulse" with Reply-To it', () => {
  for (const env of [base, withResend]) {
    // The install's company keeps its configured sender, with or without Resend.
    const ea = chooseSender('org', INSTALL, env);
    assert.deepEqual([ea.route, ea.from, ea.fromName, ea.brand], ['install', 'hr@estate.example.test', 'Estate Autopilots', 'org']);
    // A company that connected its mailbox sends from it.
    const acme = chooseSender('org', WITH_MAILBOX, env);
    assert.deepEqual([acme.route, acme.from, acme.fromName, acme.brand], ['mailbox', 'hr@acme.example.test', 'Acme Fake', 'org']);
  }
  const vitals = chooseSender('org', NO_MAILBOX, withResend);
  assert.deepEqual([vitals.route, fromLine(vitals), vitals.replyTo, vitals.brand], ['resend', '"Vitals Fake via Pulse" <no-reply@org-9912dc.example>', 'owner@vitals.example.test', 'org']);
  assert.equal(chooseSender('org', NO_MAILBOX, base).route, 'none');           // waits for its mailbox, as before
  // The install's sender is never another company's: only the install's own company gets it.
  for (const org of [WITH_MAILBOX, NO_MAILBOX]) for (const env of [base, withResend]) assert.notEqual(chooseSender('org', org, env).from, 'hr@estate.example.test');
});

test('Resend gets the platform sender, Reply-To, both parts and the inline logo; only the platform sender uses it', async () => {
  assert.equal(resendFor({ from: 'no-reply@org-9912dc.example' }, withResend), true);
  assert.equal(resendFor({ from: 'hr@estate.example.test' }, withResend), false);  // the install's mailbox stays with Google
  assert.equal(resendFor({ from: 'no-reply@org-9912dc.example' }, base), false);
  const { url, init } = resendRequest({ from: 'no-reply@org-9912dc.example', fromName: 'Vitals "Fake" via Pulse', replyTo: 'owner@vitals.example.test', to: 'Person@Vitals.example.test',
    title: 'Leave approved', body: 'Plain words', html: '<p>Hello</p>', inline: [{ cid: 'org-logo', filename: 'logo.png', png: PNG }, { cid: 'Bad Cid', filename: 'x', png: PNG }] }, withResend);
  const body = JSON.parse(init.body);
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(init.headers.authorization, 'Bearer synthetic-resend-key');
  assert.deepEqual([body.from, body.to, body.reply_to, body.subject, body.text, body.html], ['Vitals Fake via Pulse <no-reply@org-9912dc.example>', ['person@vitals.example.test'], 'owner@vitals.example.test', 'Leave approved', 'Plain words', '<p>Hello</p>']);
  assert.deepEqual(body.attachments, [{ filename: 'logo.png', content: PNG, content_type: 'image/png', content_id: 'org-logo' }]);
  assert.throws(() => resendRequest({ from: 'hr@estate.example.test', to: 'a@b.example.test' }, withResend), /only from the platform sender/);
  const refused = await resendSend({ from: 'no-reply@org-9912dc.example', to: 'a@b.example.test', title: 't', body: 'b' }, async () => new Response('{"message":"x"}', { status: 403 }), withResend).catch((e) => e.message);
  assert.equal(refused, 'Mail provider refused the message (403)');
  assert.doesNotMatch(refused, /synthetic-resend-key/);
});

test('the e-mail layout suits Gmail on phones and computers and always has a plain-text part', () => {
  const body = 'Your Pulse sign-up code is 482913\n\nType it on the Pulse sign-up page. <b>not bold</b>\n\nSet your password: https://app.example.test/login/set-password#token';
  const pulse = renderMail({ title: 'Your Pulse sign-up code', body }, { brand: 'pulse', orgName: null });
  assert.ok(pulse.text.startsWith(body) && pulse.text.includes('Pulse by Vitals Technologies'));
  assert.match(pulse.html, /cid:pulse-logo/); assert.match(pulse.html, /cid:vitals-logo/);
  assert.deepEqual(pulse.inline.map((i) => i.cid), ['pulse-logo', 'vitals-logo']);
  for (const i of pulse.inline) assert.ok(Buffer.from(i.png, 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.match(pulse.html, /name="viewport"/); assert.match(pulse.html, /max-width:560px/); assert.match(pulse.html, /role="presentation"/);
  assert.doesNotMatch(pulse.html, /<style|<link|<script|url\(|@import/i);
  assert.match(pulse.html, /letter-spacing:6px[^>]*>482913</);                         // the code, large and spaced
  assert.match(pulse.html, />Set your password<\/a>/);                                  // a link line becomes a button…
  assert.match(pulse.html, /href="https:\/\/app\.example\.test\/login\/set-password#token"/);  // …that keeps its link
  assert.match(pulse.html, /&lt;b&gt;not bold&lt;\/b&gt;/);
  assert.doesNotMatch(pulse.html + pulse.text, /Estate Autopilots|Sent by Pulse for/);
  const about = renderMail({ title: 'Reset', body: 'x' }, { brand: 'pulse', orgName: 'Acme Fake' });
  assert.match(about.text, /your account with Acme Fake on Pulse/);
  const org = renderMail({ title: 'Leave approved', body: 'Open Pulse: https://acme.example.test/me' }, { brand: 'org', orgName: 'Acme & Co', orgLogoPng: PNG });
  assert.deepEqual(org.inline.map((i) => i.cid), ['org-logo']);
  assert.match(org.html, /alt="Acme &amp; Co"/); assert.match(org.html, /Acme &amp; Co · Sent with Pulse/); assert.doesNotMatch(org.html, /cid:pulse-logo/);
  const plain = renderMail({ title: 'Leave approved', body: 'x' }, { brand: 'org', orgName: 'Acme Fake', orgLogoPng: null });
  assert.equal(plain.inline.length, 0); assert.match(plain.html, />Acme Fake<\/span>/);
});

test('a company mailbox message has the plain text, the HTML and its logo inline, and the Reply-To', () => {
  const raw = mimeMessage({ from: 'hr@acme.example.test', fromName: 'Acme Fake', to: 'p@acme.example.test', subject: 'Hi', body: 'Plain', html: '<p>Hi</p>',
    inline: [{ cid: 'org-logo', filename: 'logo.png', png: PNG }], replyTo: 'boss@acme.example.test' });
  assert.match(raw, /Content-Type: multipart\/alternative/); assert.match(raw, /Content-Type: text\/plain/); assert.match(raw, /Content-Type: multipart\/related/);
  assert.match(raw, /Content-Type: text\/html/); assert.match(raw, /Content-ID: <org-logo>/); assert.match(raw, /Reply-To: <boss@acme\.example\.test>/);
  assert.doesNotMatch(mimeMessage({ from: 'a@x.test', to: 'b@x.test', subject: 's', body: 'b' }), /multipart/);
});

test('the sign-up code the owner got now comes from Pulse by Vitals with the Pulse look (sink)', async () => {
  await withEnv({ ...withResend, PULSE_CI: '1', PULSE_GMAIL_SEND_ENABLED: '1' }, async () => {
    assert.equal(await authMail('owner@vitals.example.test', 'Your Pulse sign-up code', 'Your Pulse sign-up code is 123456\n\nType it.', ''), true);
    const m = testMail.at(-1);
    assert.deepEqual([m.from, m.fromName, m.kind, m.route, m.brand], ['no-reply@org-9912dc.example', 'Pulse by Vitals', 'platform', 'resend', 'pulse']);
    assert.equal(m.body, 'Your Pulse sign-up code is 123456\n\nType it.');            // the words tests and links read
    assert.doesNotMatch(m.html + m.text, /Estate Autopilots|estateautopilots/);
    assert.equal(await pulseMail('owner@vitals.example.test', 'Your Pulse code', 'Your Pulse code is 654321'), true);
    assert.equal(testMail.at(-1).from, 'no-reply@org-9912dc.example');
  });
  // Without Resend: the install's sender, but under Pulse's name and look (the fallback).
  await withEnv({ ...base, PULSE_CI: '1' }, async () => {
    assert.equal(await authMail('owner@vitals.example.test', 'Sign in', 'x'), true);
    const m = testMail.at(-1);
    assert.deepEqual([m.from, m.fromName, m.brand], ['hr@estate.example.test', 'Pulse by Vitals', 'pulse']);
  });
});

test('organisation mail per company through sendMail (sink)', async () => {
  await withEnv({ ...withResend, PULSE_CI: '1' }, async () => {
    assert.equal(await sendMail({ kind: 'org', to: 'p@vitals.example.test', title: 'Leave approved', body: 'Open Pulse: https://x.example.test/me', org: { ...NO_MAILBOX, logoPng: PNG } }), true);
    let m = testMail.at(-1);
    assert.deepEqual([m.from, m.fromName, m.replyTo, m.brand], ['no-reply@org-9912dc.example', 'Vitals Fake via Pulse', 'owner@vitals.example.test', 'org']);
    assert.match(m.html, /cid:org-logo/); assert.match(m.text, /Vitals Fake · Sent with Pulse/);
    assert.equal(await sendMail({ kind: 'org', to: 'p@estate.example.test', title: 'Payslip ready', body: 'x', org: { ...INSTALL, logoPng: null } }), true);
    m = testMail.at(-1);
    assert.deepEqual([m.from, m.fromName, m.route, m.brand], ['hr@estate.example.test', 'Estate Autopilots', 'install', 'org']);
    // Client mail keeps the install's client sender and the contact's Reply-To, in the company's look.
    process.env.PULSE_CLIENT_MAIL_FROM = 'admin@estate.example.test';
    assert.equal(await clientMail({ to: 'client@example.test', subject: 'Your space', body: 'Hello', company: 'Estate Autopilots', replyTo: 'poc@estate.example.test' }), true);
    m = testMail.at(-1);
    assert.deepEqual([m.from, m.fromName, m.replyTo, m.brand], ['admin@estate.example.test', 'Estate Autopilots', 'poc@estate.example.test', 'org']);
  });
});

test('nothing goes out with sending switched off, and a bad address is refused', async () => {
  await withEnv({ ...withResend, PULSE_CI: '0', NODE_ENV: 'production', PULSE_GMAIL_SEND_ENABLED: '0' }, async () => {
    const before = testMail.length;
    assert.equal(await sendMail({ kind: 'platform', to: 'a@example.test', title: 't', body: 'b', org: null }), false);
    assert.equal(await sendMail({ kind: 'platform', to: 'not-an-address', title: 't', body: 'b', org: null }), false);
    assert.equal(testMail.length, before);
  });
});
