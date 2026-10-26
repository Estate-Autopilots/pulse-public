import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { IMPORTANT_GROUPS, progress } from '../dist/chat-names.js';

// EST-1542: the matching screen's progress. Synthetic names only.
test('progress counts every name and the most important ones (5+ groups), by answers given', () => {
  const rows = [
    { id: 'a', label: 'A', messages: 100, groups: IMPORTANT_GROUPS, decision: 'colleague' },
    { id: 'b', label: 'B', messages: 50, groups: 9, decision: null },
    { id: 'c', label: 'C', messages: 10, groups: 1, decision: 'skip' },
    { id: 'd', label: 'D', messages: 5, groups: 4, decision: null },
  ];
  assert.deepEqual(progress(rows), { total: 4, done: 2, important: 2, importantDone: 1, messages: 165, messagesDone: 110 });
  assert.deepEqual(progress([]), { total: 0, done: 0, important: 0, importantDone: 0, messages: 0, messagesDone: 0 });
});

// EST-1913: the database counts digits with the class in 0680 (chat_names_digits); the browser and the API use Node's
// \p{Nd}. They must agree on every code point, or a phone number in some script would pass one check and not the other.
test("0680's digit class is exactly this Node's \\p{Nd}, code point by code point", () => {
  const sql = readFileSync(new URL('../../../db/migrations/0680_chat_names_loaders.sql', import.meta.url), 'utf8');
  const cls = /regexp_replace\(coalesce\(p, ''\), '\[\^([^\]]+)\]'/u.exec(sql)?.[1];
  assert.ok(cls, 'the class is in chat_names_digits');
  const inClass = new Set();
  for (const m of cls.matchAll(/(.)(?:-(.))?/gsu)) {
    const a = m[1].codePointAt(0), b = (m[2] ?? m[1]).codePointAt(0);
    for (let c = a; c <= b; c++) inClass.add(c);
  }
  const differ = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (/\p{Nd}/u.test(String.fromCodePoint(cp)) !== inClass.has(cp)) differ.push(`U+${cp.toString(16)}`);
  }
  assert.deepEqual(differ.slice(0, 12), [], `${differ.length} code points differ; run tools/gen-nd-ranges.mjs`);
});
