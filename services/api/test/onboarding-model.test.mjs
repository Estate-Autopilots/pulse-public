// PRESENCE-ONBOARD: ID masking, bank and detail checks, payroll cut-off and file sniffing. Synthetic numbers only:
// they satisfy the Verhoeff check but are made up for this test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkBank, cleanDetails, maskAadhaar, maskPan, missingLabel, payrollWindow, verhoeff } from '../dist/onboarding-model.js';
import { sniff } from '../dist/presence-onboard.js';

test('Aadhaar: only the masked form ever comes out', () => {
  assert.equal(verhoeff('234567890124'), true);
  assert.equal(verhoeff('234567890123'), false);
  assert.deepEqual(maskAadhaar('2345 6789 0124'), { ok: true, masked: 'XXXX XXXX 0124' });
  assert.deepEqual(maskAadhaar('2345-6789-0124'), { ok: true, masked: 'XXXX XXXX 0124' });
  assert.deepEqual(maskAadhaar('XXXX XXXX 0124'), { ok: true, masked: 'XXXX XXXX 0124' }, 'the masked Aadhaar PDF form is accepted as is');
  assert.equal(maskAadhaar('234567890123').ok, false, 'a wrong check digit is refused');
  assert.equal(maskAadhaar('134567890124').ok, false, 'Aadhaar numbers never start with 0 or 1');
  assert.equal(maskAadhaar('12345').ok, false);
  const out = JSON.stringify(maskAadhaar('876543210988'));
  assert.ok(!out.includes('87654321'), 'the first eight digits never appear in the result');
});

test('PAN: format checked, last four kept', () => {
  assert.deepEqual(maskPan('abcpe1234f'), { ok: true, masked: 'XXXXXX234F' });
  assert.deepEqual(maskPan('XXXXXX234F'), { ok: true, masked: 'XXXXXX234F' });
  assert.equal(maskPan('ABCDE1234').ok, false);
  assert.equal(maskPan('ABCZE1234F').ok, false, 'the fourth letter is the holder type');
});

test('bank details: IFSC, account digits, confirmation and the masked line', () => {
  const ok = checkBank({ holder: ' Synthetic  Person ', bank: 'Example Bank', ifsc: 'exmp0001234', account: '1234 5678 9012', confirm: '123456789012' });
  assert.equal(ok.ok, true);
  assert.equal(ok.masked, 'Example Bank ••••9012');
  assert.equal(ok.account.holder, 'Synthetic Person');
  assert.equal(checkBank({ holder: 'A B', ifsc: 'EXMP1001234', account: '123456789' }).ok, false, 'the fifth IFSC character is a zero');
  assert.equal(checkBank({ holder: 'A B', ifsc: 'EXMP0001234', account: '12345' }).ok, false);
  assert.equal(checkBank({ holder: 'A B', ifsc: 'EXMP0001234', account: '123456789', confirm: '123456780' }).error, 'The two account numbers are different');
});

test('personal details are bounded and checked', () => {
  const today = '2026-10-10';
  assert.deepEqual(cleanDetails({ dob: '1995-04-01', bloodGroup: 'o+', pincode: '411001', other: 'ignored' }, today), { ok: true, data: { dob: '1995-04-01', bloodGroup: 'O+', pincode: '411001' } });
  assert.equal(cleanDetails({ dob: '2020-01-01' }, today).ok, false, 'too young to be on staff');
  assert.equal(cleanDetails({ personalPhone: 'call me' }, today).ok, false);
  assert.equal(cleanDetails({ personalEmail: 'not-an-email' }, today).ok, false);
  assert.equal(cleanDetails({ address: 'x'.repeat(400) }, today).data.address.length, 300);
});

test('payroll cut-off: open until the day HR set, closed after; past months closed', () => {
  assert.deepEqual(payrollWindow('2026-10', '2026-10-10', 26), { cutoffDate: '2026-10-26', closed: false, daysLeft: 16 });
  assert.deepEqual(payrollWindow('2026-10', '2026-10-27', 26), { cutoffDate: '2026-10-26', closed: true, daysLeft: 0 });
  assert.deepEqual(payrollWindow('2026-09', '2026-10-10', null), { cutoffDate: null, closed: true, daysLeft: null });
  assert.equal(missingLabel('doc:pan', [{ kind: 'pan', label: 'PAN card' }]), 'PAN card');
  assert.equal(missingLabel('bank'), 'Bank details');
});

test('uploads must be what they say they are', () => {
  assert.equal(sniff(Buffer.from('%PDF-1.7 synthetic'), 'application/pdf'), true);
  assert.equal(sniff(Buffer.from('MZ executable'), 'application/pdf'), false);
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'), true);
  assert.equal(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'image/png'), true);
  assert.equal(sniff(Buffer.from('RIFF0000WEBPVP8 '), 'image/webp'), true);
  assert.equal(sniff(Buffer.from('<svg/>'), 'image/png'), false);
});
