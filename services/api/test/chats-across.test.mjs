// CHAT-ALL: which of the account's seats the chat list's switch reads (current first, own companies, then guest seats;
// never an AI employee's seat; test and demo companies only when this tab is in one), and a company's unread totals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guestSeat, MAX_PER_SEAT, seatTotals, seatsToRead } from '../dist/chats-across.js';

const seat = (org, over = {}) => ({ org, person: `p-${org}`, name: `Synthetic ${org}`, handle: null, kind: 'staff', current: false, purpose: 'work', personal: false, ...over });

test('the current company first, my companies next, guest seats last; no AI seat, no test company unless I am in it now', () => {
  const read = seatsToRead([
    seat('guest', { kind: 'partner' }), seat('kite'), seat('lab', { purpose: 'test' }), seat('bot', { kind: 'agent' }),
    seat('lotus', { current: true }), seat('mine', { personal: true }),
  ]);
  assert.deepEqual(read.map((s) => s.org), ['lotus', 'kite', 'mine', 'guest']);
  assert.deepEqual(seatsToRead([seat('lab', { purpose: 'demo', current: true }), seat('kite')]).map((s) => s.org), ['lab', 'kite']);
  assert.equal(guestSeat({ kind: 'partner' }), true);
  assert.equal(guestSeat({ kind: 'client' }), false, "a client's seat is that company's own chat list");
});

test('at most twelve seats are read', () => {
  const many = Array.from({ length: 20 }, (_, i) => seat(`c${i}`, { current: i === 7 }));
  const read = seatsToRead(many);
  assert.equal(read.length, 12);
  assert.equal(read[0].org, 'c7');
});

test("a company's unread: chats with news or marked unread; muted and archived chats do not raise the badge", () => {
  const now = Date.parse('2026-11-18T10:00:00Z');
  const c = (over) => ({ unread: 0, mentions: 0, mutedUntil: null, archivedAt: null, markedUnread: null, ...over });
  assert.deepEqual(seatTotals([
    c({ unread: 3, mentions: 1 }), c({ markedUnread: '2026-11-18T09:00:00Z' }), c({ unread: 9, mutedUntil: '2026-11-19T00:00:00Z', mentions: 1 }),
    c({ unread: 5, mutedUntil: '2026-11-17T00:00:00Z' }), c({ unread: 4, archivedAt: '2026-11-01T00:00:00Z', mentions: 2 }), c({}),
  ], now), { unreadChats: 3, unreadMessages: 8, mentions: 2 });
  assert.ok(MAX_PER_SEAT >= 100);
});
