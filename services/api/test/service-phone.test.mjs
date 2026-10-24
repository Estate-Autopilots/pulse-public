import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { protectContact } from '../dist/acquisition-model.js';
import { lookupPhone, phoneAliases, phoneBudgetSpent } from '../dist/service-phone.js';

const env = { PULSE_ACQUISITION_IDENTITY_KEYS: JSON.stringify([{ version: 'v2', key: 'b'.repeat(64) }, { version: 'v1', key: 'a'.repeat(64) }]) };
const scope = { controller: 'synthetic-controller', path: 'sales' };

test('10-digit and E.164 forms normalise to the same number', () => {
  for (const raw of ['9812345678', '+919812345678', '+91 98123-45678', '(981) 234.5678']) assert.equal(lookupPhone(raw), '+919812345678');
  for (const raw of ['', '12345', '919812345678', '+0123456789', 'abc', undefined]) assert.equal(lookupPhone(raw), null);
});

test('aliases equal the stored acquisition aliases for every key version', () => {
  const stored = protectContact(scope.controller, scope.path, { phone: '+91 98123 45678' }, env).aliases;
  const lookup = phoneAliases(lookupPhone('9812345678'), [scope, { controller: 'other', path: 'sales' }], env);
  assert.equal(lookup.length, 4);
  for (const alias of stored) assert.ok(lookup.some(a => a.version === alias.version && a.key === alias.key), alias.version);
  assert.deepEqual(phoneAliases('+919812345678', [scope], {}), []);
});

test('30 lookups per minute per key, isolated by key', () => {
  const a = randomUUID(), b = randomUUID(), now = Date.now();
  for (let i = 0; i < 30; i++) assert.equal(phoneBudgetSpent(a, now), false);
  assert.equal(phoneBudgetSpent(a, now), true);
  assert.equal(phoneBudgetSpent(b, now), false);
  assert.equal(phoneBudgetSpent(a, now + 60_000), false);
});
