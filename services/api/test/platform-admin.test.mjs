// PULSE-ADMIN (1140): the console's input checks and its configuration (brand, support address and domain come from
// the environment only, so moving Pulse to its own company and domain is a configuration change).
import assert from 'node:assert/strict';
import test from 'node:test';
import { announcement, orgChange, releaseOf } from '../dist/platform-admin.js';
import { platformConfig } from '../dist/platform-config.js';

const refused = (fn, pattern) => assert.throws(fn, (e) => e.statusCode === 400 && pattern.test(e.message));

test('organisation changes are checked before they reach the database', () => {
  assert.deepEqual(orgChange({ plan: 'growth', seatLimit: '25', aiTokensMonth: '2,000,000', trialEnds: '2026-12-31', note: '  Pilot  ' }),
    { plan: 'growth', seatLimit: '25', aiTokensMonth: '2000000', trialEnds: '2026-12-31', note: 'Pilot' });
  assert.deepEqual(orgChange({ seatLimit: '', aiTokensMonth: null }), { seatLimit: null, aiTokensMonth: null }, 'empty clears a limit');
  assert.deepEqual(orgChange({ status: 'suspended' }), { status: 'suspended' });
  refused(() => orgChange({}), /Nothing to change/);
  refused(() => orgChange({ status: 'deleted' }), /active or suspended/);
  refused(() => orgChange({ plan: 'galactic' }), /plan/);
  refused(() => orgChange({ seatLimit: 0 }), /Seats/);
  refused(() => orgChange({ seatLimit: 2.5 }), /Seats/);
  refused(() => orgChange({ aiTokensMonth: 10 }), /AI tokens/);
  refused(() => orgChange({ trialEnds: 'soon' }), /Trial ends/);
});

test('announcements are checked: title, tone, audience, link and end', () => {
  const a = announcement({ title: '  Update tonight ', body: '', link: '/whats-new' });
  assert.deepEqual(a, { title: 'Update tonight', body: null, tone: 'info', audience: 'everyone', link: '/whats-new', endsAt: null });
  refused(() => announcement({ title: 'x' }), /title/);
  refused(() => announcement({ title: 'Fine', tone: 'loud' }), /info, warning or success/);
  refused(() => announcement({ title: 'Fine', audience: 'world' }), /everyone or admins/);
  refused(() => announcement({ title: 'Fine', link: 'javascript:alert(1)' }), /link/i);
  refused(() => announcement({ title: 'Fine', endsAt: '2001-01-01T00:00:00Z' }), /future/);
});

test('who runs Pulse comes from the environment, never from code', () => {
  assert.deepEqual(platformConfig({}), { product: 'Pulse', company: null, supportEmail: null, domain: null, publicUrl: null, bugTriagePath: '/bug-reports' });
  const c = platformConfig({ PULSE_PLATFORM_NAME: 'Pulse', PULSE_PLATFORM_COMPANY: 'Synthetic Pulse LLP', PULSE_SUPPORT_EMAIL: 'help@pulse.example.test',
    PULSE_PUBLIC_URL: 'https://app.pulse.example.test', PULSE_BUG_TRIAGE_PATH: '/bug-reports?status=new' });
  assert.deepEqual([c.company, c.supportEmail, c.domain, c.bugTriagePath], ['Synthetic Pulse LLP', 'help@pulse.example.test', 'app.pulse.example.test', '/bug-reports?status=new']);
  assert.equal(platformConfig({ PULSE_PLATFORM_DOMAIN: 'Pulse.Example.Test', PULSE_PUBLIC_URL: 'https://other.example.test' }).domain, 'pulse.example.test', 'the domain variable wins');
  assert.equal(platformConfig({ PULSE_SUPPORT_EMAIL: 'not an address' }).supportEmail, null);
  assert.equal(platformConfig({ PULSE_BUG_TRIAGE_PATH: 'https://evil.example.test' }).bugTriagePath, '/bug-reports', 'the triage page is inside Pulse');
});

test('the release an API runs is read from its environment, or not at all', () => {
  assert.deepEqual(releaseOf({ PULSE_ENV: 'prod', PULSE_RELEASE: 'DB5F266AE037728DE8DDA93235036846A0723497' }), { env: 'production', sha: 'db5f266ae037728de8dda93235036846a0723497' });
  assert.deepEqual(releaseOf({ PULSE_ENV: 'dev', PULSE_RELEASE: 'd8b82dc9' }), { env: 'dev', sha: 'd8b82dc9' });
  assert.equal(releaseOf({ PULSE_ENV: 'dev', PULSE_RELEASE: 'dev' }), null);
  assert.equal(releaseOf({ PULSE_RELEASE: 'd8b82dc9' }), null);
});
