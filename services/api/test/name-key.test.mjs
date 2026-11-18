// WL-QUOTE-LIVE: a misheard or other-script client name sounds like the client it is (the suite's voice notes).
// The public CI mirror renames real people and clients (Sigemo, Kireteso) to synthetic names everywhere, but not their
// misheard or Devanagari spellings, so a fixed pair such as "Shind Hospital" ~ "Sigemo Hospital" became
// "Shind Hospital" ~ another name there. So the misheard Latin form is made from the client's own name (its first word
// loses its last letter, as Whisper did), and each Devanagari spelling is checked against the sound key its Latin
// client has here (a key is not a name, so the mirror leaves it alone).
import test from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, nearName } from '../dist/name-key.js';

const misheard = (client) => client.replace(/^(\S+)\S(?=\s)/, '$1');

test('misheard and Devanagari names sound like the client', () => {
  assert.equal(nameKey('Desai Dairy'), 'dsdr');
  assert.equal(nameKey('Desideri'), 'dsdr');
  assert.equal(nameKey('देसाई डेयरी'), 'dsdr');
  // Whisper's spellings: शिंदे हॉस्पिटल is Sigemo Hospital, कुलकर्णी एग्रो is Kireteso Agro, देसाई डेअरी is Desai Dairy.
  assert.equal(nameKey('शिंदे हॉस्पिटल'), 'sndsptl');
  assert.equal(nameKey('कुलकर्णी एग्रो'), 'klkrngr');
  assert.equal(nameKey('देसाई डेअरी'), 'dsdr');
  assert.equal(misheard('Sigemo Hospital').length, 'Sigemo Hospital'.length - 1);
  for (const [heard, client] of [['Desideri', 'Desai Dairy'], [misheard('Sigemo Hospital'), 'Sigemo Hospital'], ['देसाई डेअरी', 'Desai Dairy'],
    ['M/s Kireteso Agro Pvt Ltd', 'Kireteso Agro']]) assert.ok(nearName(heard, client), `${heard} ~ ${client}`);
});
test('different clients stay different', () => {
  for (const [a, b] of [['Mifos Traders', 'Desai Dairy'], ['Sigemo Traders', 'Sigemo Hospital'], ['Jivop Bakery', 'Kireteso Agro'], ['Putig Traders', 'Pesub Hotels'], ['A1', 'B2'], ['', 'Desai Dairy']])
    assert.ok(!nearName(a, b), `${a} !~ ${b}`);
});
