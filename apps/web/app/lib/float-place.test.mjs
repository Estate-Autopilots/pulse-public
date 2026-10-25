import assert from 'node:assert/strict';
import test from 'node:test';
import { floatRoom, isClear, openSide, overlaps, leastFloat, placeFloat, scanFloat, snapEdge } from './float-place.mjs';

const r = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h });
const room = { left: 8, top: 60, right: 1432, bottom: 892 };

test('a free spot is kept as it is', () => {
  assert.deepEqual(placeFloat({ x: 1300, y: 760 }, 60, 60, room, [r(100, 100, 80, 32)]), { x: 1300, y: 760, moved: false });
});

test('a spot on the page’s button steps aside the short way and touches nothing', () => {
  const save = r(1280, 780, 120, 40);
  const p = placeFloat({ x: 1300, y: 770 }, 60, 60, room, [save]);
  assert.equal(p.moved, true);
  assert.equal(overlaps(r(p.x, p.y, 60, 60), save), false);
  // Up (above the button) is closer than a jump to the other side of the window.
  assert.ok(p.y + 60 <= save.top && Math.abs(p.x - 1300) < 1, JSON.stringify(p));
});

test('several obstacles: the nearest spot clear of all of them', () => {
  const minimap = r(1220, 700, 200, 180), companion = r(1392, 380, 40, 120);
  const p = placeFloat({ x: 1360, y: 820 }, 60, 60, room, [minimap, companion]);
  assert.ok(![minimap, companion].some((o) => overlaps(r(p.x, p.y, 60, 60), o)), JSON.stringify(p));
  assert.ok(p.x >= room.left && p.y >= room.top && p.x + 60 <= room.right && p.y + 60 <= room.bottom);
});

test('the spot always stays inside the room', () => {
  assert.deepEqual(placeFloat({ x: 5000, y: -40 }, 60, 60, room, []), { x: 1372, y: 60, moved: false });
});

test('no free spot: it stays where it was wanted', () => {
  assert.deepEqual(placeFloat({ x: 100, y: 100 }, 60, 60, room, [r(0, 0, 1440, 900)]), { x: 100, y: 100, moved: false });
});

test('the room ends above the phone’s tab bar and below the top bar', () => {
  const phone = floatRoom({ width: 390, height: 844, bar: r(0, 0, 390, 52), tabs: r(0, 786, 390, 58) });
  assert.deepEqual(phone, { left: 8, top: 60, right: 382, bottom: 778 });
  const computer = floatRoom({ width: 1440, height: 900, bar: r(0, 0, 1440, 52), tabs: null });
  assert.equal(computer.bottom, 892);
  // A tab bar that is not at the bottom (hidden off screen) does not count.
  assert.equal(floatRoom({ width: 390, height: 844, tabs: r(0, 900, 390, 58) }).bottom, 836);
});

test('menus open towards the larger side', () => {
  assert.deepEqual(openSide({ x: 1300, y: 780 }, 60, room).v, 'bottom');
  assert.deepEqual(openSide({ x: 20, y: 80 }, 60, room), { side: 'left', v: 'top', above: 20, below: 752 });
});

test('FLOAT-2: a dropped control snaps to the nearer side edge, inside the room', () => {
  assert.deepEqual(snapEdge({ x: 500, y: 400 }, 56, 56, room), { x: 8, y: 400 });
  assert.deepEqual(snapEdge({ x: 900, y: 2000 }, 56, 56, room), { x: 1376, y: 836 });
});

test('FLOAT-2: a page full of content: the free strip at the room edge is found', () => {
  const phone = { left: 16, top: 60, right: 374, bottom: 770 };
  // Cards whose text ends 70 px short of the right edge, a KPI chip under the wanted spot.
  const text = [r(16, 600, 290, 40), r(16, 660, 290, 40), r(16, 710, 290, 40)], chip = r(300, 700, 74, 32);
  const p = placeFloat({ x: 318, y: 700 }, 56, 56, phone, [...text, chip]);
  assert.ok(isClear(p, 56, 56, [...text, chip]), JSON.stringify(p));
  assert.ok(p.x >= phone.left && p.x + 56 <= phone.right && p.y + 56 <= phone.bottom);
});

test('FLOAT-2: a phone on its side: the tabs are a rail at the left, the room starts right of it', () => {
  const side = floatRoom({ width: 844, height: 390, bar: r(0, 0, 844, 44), tabs: r(0, 44, 64, 346) });
  assert.deepEqual(side, { left: 72, top: 52, right: 836, bottom: 382 });
});

test('FLOAT-2: the scan finds the nearest free spot along the side edge, or says there is none', () => {
  const phone = { left: 16, top: 60, right: 374, bottom: 770 };
  const cards = [r(16, 60, 358, 300), r(16, 372, 358, 200), r(16, 650, 358, 120)];
  const p = scanFloat({ x: 318, y: 700 }, 56, 56, phone, cards);
  assert.ok(p && isClear(p, 56, 56, cards) && p.y >= 572 && p.y + 56 <= 650, JSON.stringify(p));
  assert.equal(scanFloat({ x: 318, y: 700 }, 56, 56, phone, [r(0, 0, 390, 844)]), null);
});

test('FLOAT-2: controls everywhere: the spot that covers the least of them, clear of what is marked', () => {
  const phone = { left: 16, top: 60, right: 374, bottom: 770 };
  const search = r(16, 680, 358, 44), cards = [r(16, 60, 358, 600)], marked = [r(300, 730, 74, 40)];
  const p = leastFloat({ x: 318, y: 690 }, 56, 56, phone, marked, [search, ...cards]);
  assert.ok(p && isClear(p, 56, 56, marked) && p.y >= phone.top && p.y + 56 <= phone.bottom, JSON.stringify(p));
});
