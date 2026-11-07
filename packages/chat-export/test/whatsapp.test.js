// R47: reading WhatsApp text exports. Every file and name here is synthetic (the +44 7700 900xxx numbers are reserved
// for fiction); no real export is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  decodeExport, detectDateOrder, ExportError, importKeys, participantKey, parseWhatsAppExport, suggestPeople, zonedToUtc,
} from '../src/index.js';

const fixture = async (name) => decodeExport(new Uint8Array(await readFile(new URL(`fixtures/${name}`, import.meta.url))));
const KOLKATA = { timeZone: 'Asia/Kolkata' };

test('Android, 24-hour, day-first: notices, multiline text, media, deletions, edits and phone senders', async () => {
  const r = parseWhatsAppExport(await fixture('android-24h-dmy.txt'), KOLKATA);
  assert.equal(r.dateOrder, 'dmy');
  assert.equal(r.dateOrderCertain, true, '13/10 can only be day-first');
  assert.deepEqual(r.messages.map((m) => [m.line, m.kind, m.sender]), [
    [1, 'system', null], [2, 'system', null], [3, 'text', 'Mira Test'], [6, 'media', 'Kabir Sample'], [7, 'text', 'Kabir Sample'],
    [8, 'deleted', '+44 7700 900123'], [9, 'text', '+44 7700 900123'], [10, 'system', null], [11, 'text', 'Kabir Sample'],
    [12, 'text', 'Kabir Sample'], [13, 'media', 'Kabir Sample'],
  ]);
  const [, , sheet, photo, edited] = r.messages;
  assert.equal(sheet.body, 'Morning, call sheet for the synthetic shoot:\n1. Reach by 10\n2. Bring the test camera');
  assert.equal(sheet.local, '2026-10-12T09:02:00');
  assert.equal(sheet.at, '2026-10-12T03:32:00.000Z', 'Kolkata is UTC+05:30');
  assert.equal(photo.body, '', 'no file name is kept');
  assert.deepEqual([edited.body, edited.edited], ['Uploaded the synthetic cut', true]);
  assert.equal(r.messages[10].body, 'Caption for the synthetic still', 'a caption is the sender’s text; the file name is not');
  assert.deepEqual(r.stats, { lines: 14, messages: 11, text: 5, media: 2, deleted: 1, system: 3, multiline: 1, edited: 1, outOfOrder: 0, first: '2026-10-12T03:32:00.000Z', last: '2026-10-13T13:06:00.000Z' });
  const phone = r.participants.find((p) => p.phone);
  assert.deepEqual([phone.label, phone.display, phone.messages, phone.deleted], ['+44 7700 900123', 'Number ending 123', 2, 1]);
  assert.deepEqual(r.participants.map((p) => p.display), ['Kabir Sample', 'Number ending 123', 'Mira Test']);
  assert.deepEqual(r.warnings, [{ code: 'phone_senders', count: 1 }]);
});

test('iOS, 12-hour with narrow spaces, month-first: direction marks, seconds, 12 AM and group notices', async () => {
  const r = parseWhatsAppExport(await fixture('ios-12h-mdy.txt'), KOLKATA);
  assert.equal(r.dateOrder, 'mdy');
  assert.deepEqual(r.messages.map((m) => [m.kind, m.sender, m.local]), [
    ['system', 'Synthetic shoot crew', '2026-10-12T09:00:00'], ['system', 'Synthetic shoot crew', '2026-10-12T09:01:00'],
    ['text', 'Mira Test', '2026-10-12T09:02:10'], ['media', 'Kabir Sample', '2026-10-13T18:30:05'], ['media', 'Kabir Sample', '2026-10-13T18:30:40'],
    ['deleted', 'Kabir Sample', '2026-10-13T18:31:00'], ['text', 'Mira Test', '2026-10-13T18:32:00'], ['text', 'Mira Test', '2026-10-13T00:05:00'],
  ]);
  assert.equal(r.messages[6].body, 'Two lines\nsecond line');
  assert.equal(r.messages[7].body, 'After midnight? No: 12 AM is the start of the day', 'only the first “: ” ends the sender');
  assert.deepEqual(r.participants.map((p) => p.label).sort(), ['Kabir Sample', 'Mira Test'], 'the group’s own notices are not a participant');
  assert.deepEqual(r.warnings, [{ code: 'out_of_order', count: 1 }]);
});

test('date order: decided by a 13 or more; otherwise the order that keeps time moving forward, reported as a guess', () => {
  const s = (a, b, c = '2026') => ({ a, b, c });
  assert.deepEqual(detectDateOrder([s('13', '10'), s('01', '02')]), { order: 'dmy', certain: true });
  assert.deepEqual(detectDateOrder([s('10', '13')]), { order: 'mdy', certain: true });
  assert.deepEqual(detectDateOrder([{ a: '2026', b: '10', c: '12' }]), { order: 'ymd', certain: true });
  assert.deepEqual(detectDateOrder([s('13', '10'), s('10', '13')]), { order: null, certain: false });
  const text = '11/01/2026, 10:00 - Mira Test: a\n12/01/2026, 10:00 - Mira Test: b\n01/02/2026, 10:00 - Mira Test: c\n';
  const guess = parseWhatsAppExport(text, KOLKATA);
  assert.deepEqual([guess.dateOrder, guess.dateOrderCertain, guess.warnings[0]], ['dmy', false, { code: 'date_order_guess', order: 'dmy' }]);
  const chosen = parseWhatsAppExport(text, { ...KOLKATA, dateOrder: 'mdy' });
  assert.deepEqual([chosen.dateOrder, chosen.dateOrderCertain, chosen.stats.outOfOrder], ['mdy', true, 1]);
  assert.throws(() => parseWhatsAppExport('13/10/2026, 10:00 - A: x\n10/13/2026, 10:00 - A: y\n', KOLKATA), (e) => e instanceof ExportError && e.code === 'date_order');
  // An impossible date under the chosen order is not a new message: it stays text of the one before, and is reported.
  const odd = parseWhatsAppExport('12/10/2026, 10:00 - A: first\n31/02/2026, 10:00 - A: not a date\n', KOLKATA);
  assert.deepEqual([odd.messages.length, odd.messages[0].body], [1, 'first\n31/02/2026, 10:00 - A: not a date']);
  assert.deepEqual(odd.warnings, [{ code: 'bad_stamp', count: 1, line: 2 }]);
});

test('time zones: the exporting phone’s wall clock, with clock changes reported instead of guessed silently', () => {
  const text = '29/03/2026, 00:30 - Mira Test: before\n29/03/2026, 01:30 - Mira Test: skipped hour\n25/10/2026, 01:30 - Mira Test: twice\n25/10/2026, 03:00 - Mira Test: after\n';
  const r = parseWhatsAppExport(text, { timeZone: 'Europe/London' });
  assert.deepEqual(r.messages.map((m) => [m.at, m.time]), [
    ['2026-03-29T00:30:00.000Z', 'exact'], ['2026-03-29T01:30:00.000Z', 'missing'],
    ['2026-10-25T00:30:00.000Z', 'ambiguous'], ['2026-10-25T03:00:00.000Z', 'exact'],
  ]);
  assert.deepEqual(r.warnings, [{ code: 'time_ambiguous', count: 1, line: 2 }, { code: 'time_missing', count: 1, line: 2 }]);
  assert.equal(zonedToUtc(Date.UTC(2026, 6, 1, 12), 'America/New_York').ms, Date.UTC(2026, 6, 1, 16));
  assert.equal(parseWhatsAppExport('12/10/2026, 09:02 - A: x\n', { timeZone: 'UTC' }).messages[0].at, '2026-10-12T09:02:00.000Z');
  assert.throws(() => parseWhatsAppExport('12/10/2026, 09:02 - A: x\n', { timeZone: 'Mars/Olympus' }), (e) => e.code === 'zone');
});

test('stable import keys: the same export, or a longer one that overlaps it, gives the same keys', async () => {
  const text = await fixture('android-24h-dmy.txt');
  const a = parseWhatsAppExport(text, KOLKATA), again = parseWhatsAppExport(text.replace(/\n/g, '\r\n'), KOLKATA);
  const keys = await importKeys(a.messages);
  assert.deepEqual(await importKeys(again.messages), keys, 'line endings do not change keys');
  assert.equal(new Set(keys).size, keys.length, 'two identical “ok” in the same minute are two messages');
  const later = parseWhatsAppExport(text + '14/10/2026, 08:00 - Mira Test: Next synthetic day\n', KOLKATA);
  const laterKeys = await importKeys(later.messages);
  assert.deepEqual(laterKeys.slice(0, keys.length), keys);
  assert.equal(laterKeys.length, keys.length + 1);
  // Another time zone choice reads the same wall clock: keys follow what the export says, not the chosen zone.
  assert.deepEqual(await importKeys(parseWhatsAppExport(text, { timeZone: 'UTC' }).messages), keys);
  // A phone number is not in a key: another number with the same last digits writing the same thing keys the same.
  const other = parseWhatsAppExport(text.replaceAll('+44 7700 900123', '+44 7701 900123'), KOLKATA);
  assert.deepEqual(await importKeys(other.messages), keys);
  assert.notEqual(await participantKey('Mira Test'), await participantKey('Kabir Sample'));
  assert.match(await participantKey('+44 7700 900123'), /^[0-9a-f]{64}$/);
});

test('only a text export is read: a .zip, a binary file, an empty file or other text is refused in plain words', () => {
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'none'; };
  assert.equal(code(() => decodeExport(new Uint8Array([0x50, 0x4b, 3, 4]))), 'not_text');
  assert.equal(code(() => decodeExport(new Uint8Array([0xff, 0xfe, 0x00]))), 'not_utf8');
  assert.equal(code(() => decodeExport(new Uint8Array())), 'empty');
  assert.equal(code(() => decodeExport(new Uint8Array(8 * 1024 * 1024 + 1))), 'too_large');
  assert.equal(code(() => parseWhatsAppExport('Dear diary, nothing here.\n', KOLKATA)), 'not_whatsapp');
  assert.equal(decodeExport(new TextEncoder().encode('﻿12/10/2026, 09:02 - A: x')), '12/10/2026, 09:02 - A: x', 'a byte order mark is dropped');
  const lead = parseWhatsAppExport('Exported from a phone\n13/10/2026, 09:02 - A: x\n', KOLKATA);
  assert.deepEqual(lead.warnings, [{ code: 'leading_lines', count: 1 }]);
});

test('participant suggestions: one person with the same name only; several, first names and numbers are decided by a person', () => {
  const people = [
    { id: 'p1', name: 'Mira Test' }, { id: 'p2', name: 'Kabir Sample' }, { id: 'p3', name: 'Kabir Sample' }, { id: 'p4', name: 'Neel Example' },
  ];
  const s = suggestPeople([
    { label: 'mira  test', phone: false }, { label: 'Kabir Sample', phone: false }, { label: 'Neel', phone: false },
    { label: '+44 7700 900123', phone: true }, { label: 'Client Office', phone: false },
  ], people);
  assert.deepEqual(s, [
    { status: 'same_name', candidates: ['p1'] }, { status: 'several', candidates: ['p2', 'p3'] }, { status: 'first_name', candidates: ['p4'] },
    { status: 'phone', candidates: [] }, { status: 'none', candidates: [] },
  ]);
});
