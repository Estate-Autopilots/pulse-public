import test from 'node:test';
import assert from 'node:assert/strict';
import { companionAttendanceEnabled } from '../dist/companion-attendance.js';
test('companion policy keeps explicit off, explicit on and missing policy distinct', async () => {
  for (const [rows, expected] of [[[{enabled: true}], true], [[{enabled: false}], false], [[], false]]) {
    assert.equal(await companionAttendanceEnabled({query: async () => ({rows})}), expected);
  }
});
