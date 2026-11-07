// R51: the API counts days in the company's own time zone. No API source names a zone or an India offset (the database
// side is tests/core/test_org_time_zone.py), and the helpers turn a company's wall clock into instants and back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { ORG_TZ, zoneDay, zoneTime } from '../dist/org-time.js';

test('no API source counts days in a fixed zone', async () => {
  const dir = new URL('../src/', import.meta.url);
  const found = [];
  for (const name of (await readdir(dir)).filter((f) => f.endsWith('.ts'))) {
    const lines = (await readFile(new URL(name, dir), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (/Asia\/Kolkata|[+]05:?30\b|330\s*\*\s*60|5\.5\s*\*\s*36e5|\bIST\b/.test(line)) found.push(`${name}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, [], 'use ORG_TZ in SQL and orgZone/zoneDay/zoneTime in code (services/api/src/org-time.ts)');
});

test('the SQL fragment reads the company zone once per statement', () => {
  assert.equal(ORG_TZ, '(select pulse.org_time_zone())');
});

test('a day and its start in India, London (summer and winter) and Pago Pago', () => {
  const at = Date.parse('2026-10-20T20:00:00Z');
  assert.equal(zoneDay('Asia/Kolkata', at), '2026-10-21');      // 01:30 the next day in India
  assert.equal(zoneDay('Europe/London', at), '2026-10-20');     // 21:00 BST
  assert.equal(zoneDay('Pacific/Pago_Pago', at), '2026-10-20'); // 09:00
  assert.equal(zoneDay('UTC', new Date(at)), '2026-10-20');
  assert.equal(zoneTime('2026-10-20', 'Asia/Kolkata').toISOString(), '2026-10-19T18:30:00.000Z');
  assert.equal(zoneTime('2026-10-20', 'Asia/Kolkata', '18:00').toISOString(), '2026-10-20T12:30:00.000Z');
  assert.equal(zoneTime('2026-10-20', 'Europe/London').toISOString(), '2026-10-19T23:00:00.000Z');
  assert.equal(zoneTime('2026-12-20', 'Europe/London').toISOString(), '2026-12-20T00:00:00.000Z');
  assert.equal(zoneTime('2026-10-20', 'Pacific/Pago_Pago', '18:00').toISOString(), '2026-10-21T05:00:00.000Z');
  // Across a clock change: London's 25 October 2026 starts at 00:00 BST and its next day at 00:00 GMT.
  assert.equal(zoneTime('2026-10-25', 'Europe/London').toISOString(), '2026-10-24T23:00:00.000Z');
  assert.equal(zoneTime('2026-10-26', 'Europe/London').toISOString(), '2026-10-26T00:00:00.000Z');
  for (const zone of ['Asia/Kolkata', 'Europe/London', 'America/New_York', 'Pacific/Kiritimati']) {
    for (const day of ['2026-03-08', '2026-03-29', '2026-10-20', '2026-11-01']) assert.equal(zoneDay(zone, zoneTime(day, zone)), day, `${zone} ${day}`);
  }
});
