import assert from 'node:assert/strict';
import test from 'node:test';
import { backupText, groupKey, otpDigits, passkeyName } from './two-step.mjs';

test('the setup key reads in groups of four', () => {
  assert.equal(groupKey('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ');
  assert.equal(groupKey(' ab cd ef '), 'abcd ef');
  assert.equal(groupKey(undefined), '');
});

test('a code counts as typed or pasted, and only with six digits', () => {
  assert.equal(otpDigits('123 456'), '123456');
  assert.equal(otpDigits(' 123-456 '), '123456');
  assert.equal(otpDigits('12345'), '');
  assert.equal(otpDigits('1234567'), '');
  assert.equal(otpDigits(null), '');
});

test('the backup file names the organisation and lists every code once', () => {
  const text = backupText(['aa11', 'bb22'], 'Northwind Studio', new Date('2026-10-30T12:00:00Z'));
  assert.match(text, /^Pulse backup codes for Northwind Studio\n/);
  assert.match(text, /Made 2026-10-30\./);
  assert.deepEqual(text.trim().split('\n').slice(-2), ['aa11', 'bb22']);
});

test('a passkey is named after the device it was made on', () => {
  assert.equal(passkeyName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130'), 'Windows computer');
  assert.equal(passkeyName('Mozilla/5.0 (Linux; Android 14; Redmi Note 13) Chrome/130 Mobile'), 'Android phone');
  assert.equal(passkeyName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iPhone');
  assert.equal(passkeyName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)'), 'Mac');
  assert.equal(passkeyName(undefined), 'Passkey');
});
