// UX-5A layout-shift gate (owner, 13 Oct 2026: "the layout jumps after clicks"). Nothing on a page may move by itself:
// not while it loads, and not after a click (a "Saved" line or an "Already requested" button appearing must not push
// the page down). Used by layout-shift.spec.ts (CI, production build) and ux5a-shots.mjs (screenshots).
//
//   await context.addInitScript(SHIFT_RECORDER);           // before the first navigation
//   const load = await page.evaluate(SHIFTS, { since: 0 }); // after the page settles: { score, shifts }
//   const t = await page.evaluate(() => performance.now()); await button.click(); …settle…
//   const after = await page.evaluate(SHIFTS, { since: t, all: true });
//
// `score` is the sum of the layout-shift values in the window (stricter than CLS's worst five-second session). Page
// loads leave out shifts within 500 ms of input (as CLS does); after a click `all` counts them too, because the click
// is exactly what must not move the page. Shifts of elements inside an open dialog, a popover, Pip's island or anything
// marked `data-shift-ok` are not counted: an opening drawer or menu is meant to appear.
export const LOAD_LIMIT = 0.05;
export const CLICK_LIMIT = 0.01;

export const SHIFT_RECORDER = () => {
  const describe = (n) => {
    const el = n && n.nodeType === 1 ? n : n?.parentElement; if (!el) return { where: "?", ok: false };
    const ok = !!el.closest("[role=dialog], [role=menu], [role=listbox], [popover], [data-shift-ok], [data-island], [aria-live]");
    const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return { where: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.getAttribute("class") ?? "").split(" ")[0]} «${name}»`, ok };
  };
  window.__pulseShifts = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const sources = (e.sources ?? []).map((s) => describe(s.node));
        window.__pulseShifts.push({ t: e.startTime, value: e.value, input: e.hadRecentInput, sources });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch { /* no layout-shift entries in this browser */ }
};

/** In the page: the shifts since `since` (ms on the performance clock), without the allowed ones. */
export const SHIFTS = ({ since = 0, all = false } = {}) => {
  const list = (window.__pulseShifts ?? []).filter((s) => s.t >= since && (all || !s.input) && !(s.sources.length && s.sources.every((x) => x.ok)));
  return { score: Math.round(list.reduce((n, s) => n + s.value, 0) * 10000) / 10000, shifts: list.map((s) => ({ value: Math.round(s.value * 10000) / 10000, at: Math.round(s.t), where: s.sources.filter((x) => !x.ok).map((x) => x.where).slice(0, 3) })) };
};

/** Waits until nothing has shifted for `quiet` ms (or `max` ms passed). */
export async function settleShifts(page, quiet = 700, max = 6000) {
  const start = Date.now(); let last = -1, stableSince = Date.now();
  while (Date.now() - start < max) {
    const n = await page.evaluate(() => (window.__pulseShifts ?? []).length).catch(() => 0);
    if (n !== last) { last = n; stableSince = Date.now(); } else if (Date.now() - stableSince >= quiet) return;
    await page.waitForTimeout(150);
  }
}
