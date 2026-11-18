// DOREVE-2 (decision 3, 17 Nov 2026): session replay is kept for a window around the moments people struggle, plus 10% of
// sessions in full. The device knows the moment as it happens: the same signals the leadership view's detector reads
// (services/api/src/struggle-model.ts): a refused action, an early click on a page not ready, the same thing clicked
// again and again, a dead click, a stuck form or one left unsent, a script error, a freeze of a second or more, a wait
// of 3 s or more. Pure, so it is tested on its own (replay-window.test.mjs).

/** About a minute before the moment (the buffer: two or three 30-s segments, each from a full snapshot) and a minute after. */
export const WINDOW_MS = 60_000;
export const SEGMENTS = 3;

/** Whether a telemetry event (kind, fields as lib/telemetry.mjs emits them) is a struggle moment. */
export function isStruggle(kind, f = {}) {
  const x = f && typeof f.x === "object" && f.x ? f.x : {};
  switch (kind) {
    case "ui.rage": case "ui.dead": case "ui.stuck": case "ui.early": case "ui.form.abandon":
    case "error.js": case "error.promise": case "error.boundary":
      return true;
    case "perf.longtask": return Number(f.d ?? 0) >= 1000;
    case "ui.click": case "ui.submit": return !!(x.fail || x.failed) || Number(f.d ?? 0) >= 3000;
    default: return false;
  }
}

/** The window after a moment at `now` (a later moment extends it). */
export const windowUntil = (now, until = 0) => Math.max(until, now + WINDOW_MS);
