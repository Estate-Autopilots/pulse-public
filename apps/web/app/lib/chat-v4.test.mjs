// CHAT-V4: the link a message previews and the order "@" offers people in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewLink, rankMentions } from './chat-format.mjs';

test('a message previews its first public https link, not Pulse pages or Google files', () => {
  assert.equal(previewLink('See https://www.behance.net/gallery/1 and https://example.org/x'), 'https://www.behance.net/gallery/1');
  assert.equal(previewLink('Plain words'), null);
  assert.equal(previewLink('http://example.org/insecure'), null);
  assert.equal(previewLink('https://pulse-dev.estateautopilots.com/tasks/1'), null);
  assert.equal(previewLink('https://docs.google.com/document/d/abc then https://example.org/a.'), 'https://example.org/a');
  assert.equal(previewLink('https://app.example.test/x', 'https://app.example.test'), null);
});

// Synthetic names only: the public CI mirror rewrites real-looking ones (its leak gate), which changed the order.
test('"@" offers first names that start with the letters first, then other words, then the rest', () => {
  const people = [
    { id: 'me', name: 'Ada Example', username: 'ada' },
    { id: 'n', name: 'Nova Shorewell', username: 'nova' },
    { id: 's', name: 'Sable Shorewell', username: 'sable' },
    { id: 'a', name: 'Ashby Rook', username: 'ashby' },
    { id: 'x', name: 'Nobody Handle', username: null },
    { id: 'm', name: 'Mira', username: 'mira', agent: true },
  ];
  assert.deepEqual(rankMentions(people, 'sh', 'me').map((p) => p.id), ['n', 's', 'a']);
  assert.deepEqual(rankMentions(people, 's', 'me').map((p) => p.id), ['s', 'n', 'a']);
  assert.deepEqual(rankMentions(people, '', 'me').map((p) => p.id), ['a', 'm', 'n', 's']);
  assert.deepEqual(rankMentions(people, 'mi', 'me').map((p) => p.id), ['m']);
  assert.equal(rankMentions(people, 'zz', 'me').length, 0);
});
