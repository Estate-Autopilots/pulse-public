// PHONE-QA tools: the QA shell patches still match the shell, and the staging proxy presents only the public origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeQaShell, qaOrigin, QA_PACKAGE } from './make-qa-shell.mjs';
import { backHeaders, forwardHeaders } from './origin-proxy.mjs';

const app = resolve(fileURLToPath(new URL('../../../apps/mobile', import.meta.url)));

test('only a loopback origin with a port is accepted for the QA shell', () => {
  assert.equal(qaOrigin('http://localhost:4610'), 'http://localhost:4610');
  for (const bad of ['https://pulse.estateautopilots.com', 'http://localhost', 'http://10.0.0.2:4610', 'http://localhost:80', 'http://localhost:4610/'])
    assert.throws(() => qaOrigin(bad));
});

test('the QA shell is a separate package pointed at the loopback origin; apps/mobile is untouched', () => {
  const before = readFileSync(join(app, 'capacitor.config.json'), 'utf8');
  const out = mkdtempSync(join(tmpdir(), 'qa-shell-'));
  try {
    makeQaShell(app, join(out, 'shell'), 'http://localhost:4610');
    const config = JSON.parse(readFileSync(join(out, 'shell/capacitor.config.json'), 'utf8'));
    assert.equal(config.appId, QA_PACKAGE);
    assert.equal(config.server.url, 'http://localhost:4610');
    assert.match(readFileSync(join(out, 'shell/android/app/build.gradle'), 'utf8'), /applicationId "com\.pulse\.work\.mobile\.qa"/);
    assert.match(readFileSync(join(out, 'shell/android/app/src/main/java/com/pulse/work/mobile/MainActivity.java'), 'utf8'), /ORIGIN = "http:\/\/localhost:4610"/);
    assert.doesNotMatch(readFileSync(join(out, 'shell/www/index.html'), 'utf8'), /pulse\.estateautopilots\.com/);
  } finally { rmSync(out, { recursive: true, force: true }); }
  assert.equal(readFileSync(join(app, 'capacitor.config.json'), 'utf8'), before);
});

test('the staging proxy sends the public Host and Origin and never an identity header', () => {
  const h = forwardHeaders({ host: 'localhost:4612', origin: 'http://localhost:4612', referer: 'http://localhost:4612/login?x=1', 'cf-access-authenticated-user-email': 'a@b.c',
    'x-pulse-session': 's', 'x-forwarded-for': '1.2.3.4', cookie: 'pulse_session=t' }, 'https://pulse-staging.estateautopilots.com');
  assert.equal(h.host, 'pulse-staging.estateautopilots.com');
  assert.equal(h.origin, 'https://pulse-staging.estateautopilots.com');
  assert.equal(h.referer, 'https://pulse-staging.estateautopilots.com/login?x=1');
  assert.equal(h.cookie, 'pulse_session=t');
  for (const k of ['cf-access-authenticated-user-email', 'x-pulse-session', 'x-forwarded-for']) assert.equal(h[k], undefined);
  assert.equal(backHeaders({ location: 'https://pulse-staging.estateautopilots.com/welcome' }, 'https://pulse-staging.estateautopilots.com', 'http://localhost:4612').location, 'http://localhost:4612/welcome');
  assert.equal(backHeaders({ location: 'https://accounts.google.com/x' }, 'https://pulse-staging.estateautopilots.com', 'http://localhost:4612').location, 'https://accounts.google.com/x');
});
