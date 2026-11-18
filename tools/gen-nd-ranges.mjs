#!/usr/bin/env node
// EST-1542 (EST-1913): the SQL bracket class of every Unicode decimal digit (\p{Nd}) as this Node knows it (.nvmrc pins
// the version, so CI and the server agree). pulse.chat_names_digits (0680) uses it to refuse phone numbers written in any
// script's digits. After a Node upgrade, run it and compare: services/api/test/chat-names.test.mjs fails whenever the
// class in the migration and this Node's \p{Nd} disagree on any code point (a new class then goes in a new migration).
//   node tools/gen-nd-ranges.mjs        prints the class (without the brackets)
const ranges = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  if (!/\p{Nd}/u.test(String.fromCodePoint(cp))) continue;
  const last = ranges.at(-1);
  if (last && last[1] === cp - 1) last[1] = cp; else ranges.push([cp, cp]);
}
process.stdout.write(ranges.map(([a, b]) => a === b ? String.fromCodePoint(a) : `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join(""));
