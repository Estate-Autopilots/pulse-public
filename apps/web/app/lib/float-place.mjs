// FLOAT (21 Oct 2026): where a floating control may rest. Everything that floats over a page (Pip, the task
// companion, a notice banner) keeps clear of what the page itself needs: its header buttons and primary actions, the
// phone's tab bar, the builder's canvas controls, an open side sheet, and every other floating thing. A control that
// would land on one of them moves to the nearest free spot instead; the spot the person chose is kept, so it goes back
// there once the way is clear. Pure, so it is tested (float-place.test.mjs).

/** @typedef {{ left: number, top: number, right: number, bottom: number }} Rect */

const GAP = 8;

/** Do two rectangles overlap (by more than a pixel), with `gap` of air around the first? */
export function overlaps(a, b, gap = 0) {
  return a.left - gap < b.right - 1 && b.left < a.right + gap - 1 && a.top - gap < b.bottom - 1 && b.top < a.bottom + gap - 1;
}

const at = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h });
const clamp = (x, y, w, h, room) => ({ x: Math.max(room.left, Math.min(room.right - w, x)), y: Math.max(room.top, Math.min(room.bottom - h, y)) });

/**
 * The spot nearest to `want` (top-left corner of a `w`×`h` box) inside `room` where the box touches none of `avoid`.
 * Candidates are the wanted spot and the spots just beside each obstacle (above, below, left, right, and the corners
 * those make with every other obstacle), so the box slides along the shortest way out. With no free spot at all it
 * stays where it was wanted (inside the room).
 * @param {{ x: number, y: number }} want
 * @param {number} w @param {number} h
 * @param {Rect} room
 * @param {Rect[]} avoid
 * @returns {{ x: number, y: number, moved: boolean }}
 */
export function placeFloat(want, w, h, room, avoid) {
  const home = clamp(want.x, want.y, w, h, room);
  const clear = (p) => !avoid.some((o) => overlaps(at(p.x, p.y, w, h), o, GAP / 2));
  if (clear(home)) return { ...home, moved: false };
  // FLOAT-2: the room's own edges are candidates too (a phone's page has its free strip at the side).
  const xs = new Set([home.x, room.left, room.right - w]), ys = new Set([home.y, room.top, room.bottom - h]);
  for (const o of avoid) { xs.add(o.left - w - GAP); xs.add(o.right + GAP); ys.add(o.top - h - GAP); ys.add(o.bottom + GAP); }
  let best = null, dist = Infinity;
  for (const x0 of xs) for (const y0 of ys) {
    const p = clamp(x0, y0, w, h, room);
    if (!clear(p)) continue;
    // Moving up or sideways reads as stepping aside; a long jump across the window does not. Prefer the short way.
    const d = Math.hypot(p.x - home.x, p.y - home.y);
    if (d < dist - 0.5) { best = p; dist = d; }
  }
  return best ? { ...best, moved: true } : { ...home, moved: false };
}

/**
 * The room a floating control may use: inside the window by `edge`, under the top bar, above the phone's tab bar and
 * the safe areas. `bar` and `tabs` are the measured top bar and tab bar (or null when not shown).
 * @param {{ width: number, height: number, bar?: Rect | null, tabs?: Rect | null, edge?: number, safeBottom?: number }} o
 * @returns {Rect}
 */
export function floatRoom({ width, height, bar = null, tabs = null, edge = GAP, safeBottom = 0 }) {
  const top = bar && bar.bottom - bar.top > 2 && bar.top < 8 ? Math.max(edge, bar.bottom + edge) : edge;
  // FLOAT-2: a phone on its side shows the tabs as a rail at the left edge, not a bar at the bottom.
  const rail = !!tabs && tabs.left < 2 && tabs.bottom - tabs.top > height / 2 && tabs.right - tabs.left < width / 3;
  const floor = tabs && !rail && tabs.bottom - tabs.top > 2 && tabs.bottom >= height - 2 && tabs.top < height && tabs.top > height / 2 ? tabs.top : height - safeBottom;
  return { left: rail && tabs ? Math.max(edge, tabs.right + edge) : edge, top, right: width - edge, bottom: floor - edge };
}

/**
 * Which way a floating control's menu or message opens: towards the larger free side, so it never leaves the window.
 * @param {{ x: number, y: number }} p @param {number} size @param {Rect} room
 * @returns {{ side: "left" | "right", v: "top" | "bottom", above: number, below: number }}
 */
export function openSide(p, size, room) {
  const above = p.y - room.top, below = room.bottom - (p.y + size);
  return { side: p.x + size / 2 < (room.left + room.right) / 2 ? "left" : "right", v: below > above ? "top" : "bottom", above, below };
}

/** FLOAT-2: does a `w`×`h` box at `p` touch none of `avoid`? */
export function isClear(p, w, h, avoid) {
  return !avoid.some((o) => overlaps(at(p.x, p.y, w, h), o, GAP / 2));
}

/**
 * FLOAT-2 (device audit): a dropped control snaps to the nearer side edge of the room, so it never rests in the middle
 * of a page's content (Pip dropped on a KPI stayed there and carried that spot to every page).
 * @param {{ x: number, y: number }} p @param {number} w @param {number} h @param {Rect} room
 */
export function snapEdge(p, w, h, room) {
  const x = p.x + w / 2 < (room.left + room.right) / 2 ? room.left : room.right - w;
  return { x, y: Math.max(room.top, Math.min(room.bottom - h, p.y)) };
}

/**
 * FLOAT-2: the free spot nearest to `want` anywhere along the room's side edges (and `want`'s own column), in steps of
 * `step`, clear of every one of `avoid`; null when there is none. A phone's page fills its width, so the strip at the
 * side edge between two cards or beside short lines is where a floating control can rest without covering anything.
 * @param {{ x: number, y: number }} want @param {number} w @param {number} h @param {Rect} room @param {Rect[]} avoid
 * @returns {{ x: number, y: number } | null}
 */
export function scanFloat(want, w, h, room, avoid, step = 8) {
  const home = clamp(want.x, want.y, w, h, room);
  if (isClear(home, w, h, avoid)) return home;
  let best = null, dist = Infinity;
  for (const x of new Set([home.x, room.left, room.right - w])) {
    for (let y = room.top; y <= room.bottom - h; y += step) {
      const p = { x, y };
      if (!isClear(p, w, h, avoid)) continue;
      // Changing sides costs more than moving up or down the same edge.
      const d = Math.abs(y - home.y) + Math.abs(x - home.x) * 1.5;
      if (d < dist) { best = p; dist = d; }
    }
  }
  return best;
}

/**
 * FLOAT-2: when no spot is free of `soft`, the spot along the side edges clear of `hard` that covers the least of `soft`
 * (then the nearest): a page with controls everywhere still gets the corner of a card, never its search field.
 * @param {{ x: number, y: number }} want @param {number} w @param {number} h @param {Rect} room
 * @param {Rect[]} hard @param {Rect[]} soft @returns {{ x: number, y: number } | null}
 */
export function leastFloat(want, w, h, room, hard, soft, step = 8) {
  const home = clamp(want.x, want.y, w, h, room);
  const cover = (p) => soft.reduce((sum, o) => sum + Math.max(0, Math.min(p.x + w, o.right) - Math.max(p.x, o.left)) * Math.max(0, Math.min(p.y + h, o.bottom) - Math.max(p.y, o.top)), 0);
  let best = null, score = Infinity;
  for (const x of new Set([home.x, room.left, room.right - w])) {
    for (let y = room.top; y <= room.bottom - h; y += step) {
      const p = { x, y };
      if (!isClear(p, w, h, hard)) continue;
      const sc = cover(p) + (Math.abs(y - home.y) + Math.abs(x - home.x) * 1.5) * 2;
      if (sc < score) { best = p; score = sc; }
    }
  }
  return best;
}
