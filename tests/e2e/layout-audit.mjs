// LAYOUT-SWEEP (owner, 11 Oct 2026): "nothing hidden, nothing clipped". The rules every route must pass at the five
// window sizes below, shared by the sweep (layout-sweep.mjs), the Playwright gate (layout.spec.ts) and the page
// matrix (services/api/test/page-matrix-runner.mjs).
//
//   covered      something sits on top of text or a control (cards, bars, the island or a header blocking it)
//   overlap      two boxes laid out over each other (siblings that intersect)
//   spill        content drawn outside its card, over whatever comes next
//   clipped      content cut off by an overflow: hidden box (no way to see it short of browser zoom)
//   unreachable  content outside the window that no scroll area can bring into view
//   sideways     the page itself is wider than the window
//   cramped      a scroll area too small to use
//   end          the end of a scroll area stays under something (a bottom bar) or out of the window
//
// `[data-layout-ok]` exempts a subtree (say why beside it). Hidden pages of a Pager, closed <details> and inactive
// Deck views are display: none and never measured.

export const SIZES = Object.freeze([[1366, 768], [1440, 900], [1920, 1080], [768, 1024], [390, 844]]);
/** Rules that fail the gate; the rest are reported as warnings. */
export const BLOCKING = Object.freeze(["covered", "overlap", "spill", "clipped", "unreachable", "sideways", "cramped", "end"]);

/** Waits for fonts, finite animations and two frames, so measurements see the settled page. */
export async function settle(page, ms = 250) {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    // A transition can start late (a page that switches to its phone layout after hydrating), so wait again while
    // new ones appear, a few rounds at most.
    for (let round = 0; round < 4; round++) {
      const running = document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity);
      if (round && !running.length) break;
      await Promise.all(running.map((a) => a.finished.catch(() => {})));
      await new Promise((r) => setTimeout(r, round ? 120 : 0));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
  });
  if (ms) await page.waitForTimeout(ms);
}

/** Runs the audit in the page. Returns { findings: [{ rule, where, detail, box }] }. Serializable: no outer scope. */
export function auditLayout(options = {}) {
  const max = options.max ?? 60;
  const W = innerWidth, H = innerHeight;
  const findings = [];
  const seen = new Set();
  const short = (el) => {
    if (!el || el.nodeType !== 1) return String(el);
    const cls = [...el.classList].map((c) => c.replace(/^.*__/, "").replace(/_[a-zA-Z0-9]{5}$/, "")).filter(Boolean).slice(0, 2).join(".");
    const label = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    const text = (label || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48);
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${text ? ` «${text}»` : ""}`;
  };
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const add = (rule, el, detail, other) => {
    const key = `${rule}|${short(el).slice(0, 40)}|${other ? short(other).slice(0, 30) : ""}`;
    if (seen.has(key) || findings.length >= max) return;
    seen.add(key);
    findings.push({ rule, where: short(el), detail: detail ?? "", ...(other ? { other: short(other) } : {}), box: box(el) });
  };
  const style = (el) => getComputedStyle(el);
  const exempt = (el) => !!el.closest("[data-layout-ok]");
  // Opacity multiplies down the tree: text inside a faded-out popover is not on screen.
  const faded = (el) => { for (let a = el; a && a.nodeType === 1; a = a.parentElement) if (Number(style(a).opacity) < 0.05) return true; return false; };
  // Hidden on purpose by an ancestor: clipped to nothing (screen-reader text, a chart's data table) or a 1–2 px box.
  const srHidden = (el) => {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const c = style(a);
      if ((c.position === "absolute" || c.position === "fixed") && ((c.clip && c.clip !== "auto") || c.clipPath.startsWith("inset(50%"))) return true;
      if (c.overflow !== "visible") { const r = a.getBoundingClientRect(); if (r.width <= 2 || r.height <= 2) return true; }
    }
    return false;
  };
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    // Closed <details>, content-visibility: hidden, visibility and opacity, as the browser itself decides.
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    if (srHidden(el)) return false;
    const c = style(el);
    if (c.visibility === "hidden" || c.visibility === "collapse" || faded(el)) return false;
    if (el.closest("[hidden], [inert], [aria-hidden='true'], [data-page-hidden]")) return false;
    return true;
  };
  const srOnly = (el) => { const r = el.getBoundingClientRect(); const c = style(el); return (r.width <= 2 && r.height <= 2) || c.clip === "rect(0px, 0px, 0px, 0px)" || c.clipPath === "inset(50%)"; };
  // Leaves: text that belongs to the element itself, and every control.
  const CONTROL = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=link], [role=menuitem], [role=option]";
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const leaves = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (leaves.length > 4000) break;
    if (el.closest("svg, canvas, .maplibregl-map, script, style, noscript, template")) continue;
    if (!(el.matches(CONTROL) || ownText(el))) continue;
    if (!shown(el) || srOnly(el) || exempt(el)) continue;
    // Pip's island while it shows a notice: it springs open over the bar for a few seconds by design (the covered rule
    // below skips it too), and for its first 560 ms its own pill still cuts its × (RELEASE-6: a notice arriving during
    // the audit failed the train's skills check). At rest its content is hidden, so nothing of it is measured then.
    if (el.closest("[data-island][data-open]")) continue;
    // A control inside another control is measured once, as its outer control.
    if (!el.matches(CONTROL) && el.closest(CONTROL) && el.closest(CONTROL) !== el) continue;
    leaves.push(el);
  }

  // Overflow: which axes of an element clip, and which can be scrolled by a person (overflow auto/scroll).
  const clips = (c, axis) => { const v = axis === "x" ? c.overflowX : c.overflowY; return v !== "visible"; };
  const scrolls = (c, axis) => { const v = axis === "x" ? c.overflowX : c.overflowY; return v === "auto" || v === "scroll"; };
  const inner = (el) => { const r = el.getBoundingClientRect(); return { l: r.left + el.clientLeft, t: r.top + el.clientTop, r: r.left + el.clientLeft + el.clientWidth, b: r.top + el.clientTop + el.clientHeight }; };
  const docEl = document.scrollingElement || document.documentElement;
  const docScrolls = (axis) => {
    const h = style(document.documentElement), b = style(document.body);
    const hidden = (c) => (axis === "x" ? c.overflowX : c.overflowY) === "hidden" || (axis === "x" ? c.overflowX : c.overflowY) === "clip";
    if (hidden(h) || hidden(b)) return false;
    return axis === "x" ? docEl.scrollWidth > W + 1 : docEl.scrollHeight > H + 1;
  };

  // Reach: can a person bring this rectangle into view? Walks the clipping ancestors: a scroll area brings it inside
  // itself (then the scroll area must be reachable); a hidden overflow cuts it; the window scrolls only if the document
  // does. Returns null when fine, or { rule, by } when not.
  const reach = (el) => {
    let r = el.getBoundingClientRect();
    let rect = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    if (rect.r - rect.l < 1 || rect.b - rect.t < 1) return null;
    let fixed = false;
    // An absolutely positioned box escapes the overflow of every ancestor below its containing block (the nearest
    // positioned or transformed ancestor); a fixed one escapes all of them.
    const own = style(el); let escaping = own.position === "absolute" ? "absolute" : own.position === "fixed" ? "fixed" : null;
    if (escaping === "fixed") fixed = true;
    const block = (c) => c.position !== "static" || c.transform !== "none" || c.filter !== "none" || /paint|layout|strict|content/.test(c.contain);
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const c = style(a);
      if (escaping) {
        const isBlock = escaping === "absolute" ? block(c) : (c.transform !== "none" || c.filter !== "none");
        if (!isBlock) continue;
        escaping = null; if (c.position === "fixed") fixed = true;
        // The containing block itself clips if its overflow does: fall through.
      } else if (c.position === "absolute") { escaping = "absolute"; }
      else if (c.position === "fixed") { fixed = true; escaping = "fixed"; }
      if (!clips(c, "x") && !clips(c, "y") && !/paint|content|strict/.test(c.contain)) { continue; }
      const k = inner(a);
      // A screen-reader-only box (clipped to a pixel) hides its content on purpose.
      if (k.r - k.l <= 2 || k.b - k.t <= 2) return null;
      for (const axis of ["x", "y"]) {
        const lo = axis === "x" ? "l" : "t", hi = axis === "x" ? "r" : "b";
        const size = rect[hi] - rect[lo], room = k[hi] - k[lo];
        const out = rect[lo] < k[lo] - 2 || rect[hi] > k[hi] + 2;
        if (!out) continue;
        if (!clips(c, axis) && !/paint|content|strict/.test(c.contain)) continue;
        if (scrolls(c, axis) && (axis === "x" ? a.scrollWidth > a.clientWidth : a.scrollHeight > a.clientHeight)) {
          // Scrolled into this area: from here on it sits inside the area's box (at most the area's size).
          const s = Math.min(size, room);
          rect = { ...rect, [lo]: k[lo], [hi]: k[lo] + s };
        } else {
          // Visible part smaller than the element by more than a hair: cut off.
          const visible = Math.max(0, Math.min(rect[hi], k[hi]) - Math.max(rect[lo], k[lo]));
          // Entirely outside on purpose (a skip link waiting for focus, an off-canvas panel) is not cut-off content.
          if (visible === 0 && (own.position === "absolute" || own.position === "fixed")) return null;
          if (size - visible > Math.max(3, size * 0.15)) return { rule: "clipped", by: a };
        }
      }
      if (c.position === "fixed") fixed = true;
    }
    // The window. A box placed entirely off screen on purpose (a skip link) is not missing content.
    if ((own.position === "absolute" || own.position === "fixed") && (rect.b <= 0 || rect.t >= H || rect.r <= 0 || rect.l >= W)) return null;
    for (const axis of ["x", "y"]) {
      const lo = axis === "x" ? "l" : "t", hi = axis === "x" ? "r" : "b", end = axis === "x" ? W : H;
      const out = rect[lo] < -2 || rect[hi] > end + 2;
      if (!out) continue;
      if (!fixed && docScrolls(axis) && rect[lo] >= -2) continue;
      if (!fixed && docScrolls(axis) && rect[lo] < -2 && (axis === "x" ? docEl.scrollLeft : docEl.scrollTop) > 0) continue;
      return { rule: "unreachable", by: null };
    }
    return null;
  };

  // The ancestors whose overflow really clips an element: an absolutely positioned box escapes those below its
  // containing block, a fixed one all of them (unless a transform makes an ancestor its containing block).
  const clippers = (el) => {
    const out = []; const own = style(el);
    let escaping = own.position === "absolute" ? "absolute" : own.position === "fixed" ? "fixed" : null;
    const block = (c) => c.position !== "static" || c.transform !== "none" || c.filter !== "none" || /paint|layout|strict|content/.test(c.contain);
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const c = style(a);
      if (escaping) {
        if (!(escaping === "absolute" ? block(c) : (c.transform !== "none" || c.filter !== "none"))) continue;
        escaping = null;
      }
      if (clips(c, "x") || clips(c, "y") || /paint|content|strict/.test(c.contain)) out.push([a, c]);
      if (c.position === "absolute") escaping = "absolute"; else if (c.position === "fixed") escaping = "fixed";
    }
    return out;
  };
  // Visible part of an element after every clipping ancestor and the window.
  const visibleRect = (el) => {
    const r = el.getBoundingClientRect();
    let v = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    for (const [a, c] of clippers(el)) {
      const k = inner(a);
      if (clips(c, "x") || /paint|content|strict/.test(c.contain)) { v.l = Math.max(v.l, k.l); v.r = Math.min(v.r, k.r); }
      if (clips(c, "y") || /paint|content|strict/.test(c.contain)) { v.t = Math.max(v.t, k.t); v.b = Math.min(v.b, k.b); }
    }
    v = { l: Math.max(v.l, 0), t: Math.max(v.t, 0), r: Math.min(v.r, W), b: Math.min(v.b, H) };
    // A sliver (a row scrolled almost out of its list) is not sampled: hit testing snaps to whole device pixels, so the
    // points of a 2-3 px strip at a scroll area's edge land on whatever sits just past that edge ("covered" by the next
    // element when nothing covers it).
    return v.r - v.l >= 4 && v.b - v.t >= 4 ? v : null;
  };

  const boxed = (el) => {
    const c = style(el);
    const alpha = (v) => { const m = v.match(/rgba?\(([^)]+)\)/); if (!m) return v === "transparent" ? 0 : 1; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? Number(p[3]) : 1; };
    return (parseFloat(c.borderTopWidth) > 0 && alpha(c.borderTopColor) > 0) || alpha(c.backgroundColor) > 0 || c.boxShadow !== "none";
  };
  const fixedIn = (el) => { for (let a = el; a && a !== document.body; a = a.parentElement) if (style(a).position === "fixed") return true; return false; };
  const pinRoot = (el) => { for (let a = el; a && a !== document.body; a = a.parentElement) { const p = style(a).position; if (p === "fixed" || p === "sticky") return a; } return null; };
  const pinned = (el) => { for (let a = el; a && a !== document.body; a = a.parentElement) { const p = style(a).position; if (p === "fixed" || p === "sticky") return true; } return false; };
  // Covered: sample the visible part; the top-most element there must be the element, inside it, or one of its own
  // ancestors (pointer-events: none). Anything else lies on top of it.
  const coverer = (el, { pinnedToo = false } = {}) => {
    const v = visibleRect(el);
    if (!v) return null;
    const pts = [[0.5, 0.5], [0.2, 0.3], [0.8, 0.3], [0.2, 0.7], [0.8, 0.7]];
    let hits = 0, by = null, centre = false;
    for (const [fx, fy] of pts) {
      const x = v.l + (v.r - v.l) * fx, y = v.t + (v.b - v.t) * fy;
      const top = document.elementFromPoint(x, y);
      if (!top || top === el || el.contains(top) || top.contains(el)) continue;
      // Next's dev overlay, the audit's own marks, and Pip's island while it shows a notice (it opens over the bar for a
      // few seconds by design; at rest it must not cover anything).
      if (faded(top) || exempt(top) || top.closest("nextjs-portal, [data-layout-marks], [data-island][data-open]")) continue;
      // Chrome that stays put (a sticky bar, the phone's tab bar) lies over content that scrolls beneath it; that is
      // only a problem at the end of the scroll, which the end rule checks. Both inside such chrome: a real overlap.
      if (!pinnedToo && pinned(top) && !fixedIn(el) && pinRoot(top) !== pinRoot(el)) continue;
      // A card's own "stretched link": a transparent box laid over the card it belongs to, or a link whose ::after does
      // that (the point is outside the link's own box).
      if (style(top).position === "absolute" && top.parentElement?.contains(el) && !boxed(top)) continue;
      const tr = top.getBoundingClientRect();
      if (top.matches("a, button") && (x < tr.left || x > tr.right || y < tr.top || y > tr.bottom)) continue;
      // Labels and their own inputs (a hidden file input inside a label button) are one control.
      if (top.closest("label") && top.closest("label") === el.closest("label")) continue;
      hits++; by = by ?? top; if (fx === 0.5 && fy === 0.5) centre = true;
    }
    return centre || hits >= 2 ? by : null;
  };

  // --- sideways ---------------------------------------------------------------------------------------------------
  if (docEl.scrollWidth > W + 1) {
    const widest = [...document.body.querySelectorAll("main *")].filter((e) => shown(e) && e.getBoundingClientRect().right > W + 1)
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    add("sideways", widest ?? document.body, `page is ${docEl.scrollWidth}px wide in a ${W}px window`);
  }

  // --- covered, clipped, unreachable -------------------------------------------------------------------------------
  for (const el of leaves) {
    if (findings.length >= max) break;
    // Its own text cut by its own box (a fixed height with overflow: hidden), unless it is an ellipsis or a clamp.
    const own = style(el);
    if (ownText(el) && (clips(own, "y") || clips(own, "x")) && own.textOverflow !== "ellipsis" && (own.webkitLineClamp === "none" || !own.webkitLineClamp)
      && (el.scrollHeight > el.clientHeight + 3 && clips(own, "y") && el.clientHeight > 0 || el.scrollWidth > el.clientWidth + 3 && clips(own, "x") && own.whiteSpace !== "nowrap")) { add("clipped", el, "its own text is cut by its box"); continue; }
    const problem = reach(el);
    if (problem) { add(problem.rule, el, problem.by ? `cut by ${short(problem.by)}` : "outside the window, nothing scrolls to it", problem.by ?? undefined); continue; }
    const by = coverer(el);
    if (by) { add("covered", el, `under ${short(by)}`, by); continue; }
    // A control that takes no pointer (e.g. inside the bar, which lets the pointer through on a computer) cannot be
    // pressed, and elementFromPoint looks straight through it.
    if (el.matches(CONTROL) && !el.matches("input[type=range]") && !el.disabled && own.pointerEvents === "none" && !el.closest("[inert], [aria-hidden=true]")) add("covered", el, "takes no pointer (pointer-events: none)");
  }

  // --- overlap: in-flow siblings drawn over each other -------------------------------------------------------------
  const inflow = (el) => { const c = style(el); return c.position !== "absolute" && c.position !== "fixed" && !/^(contents|inline|none)$/.test(c.display) && c.float === "none"; };
  for (const parent of document.body.querySelectorAll("main, main *, header, nav")) {
    if (findings.length >= max) break;
    if (parent.children.length < 2 || parent.children.length > 80 || exempt(parent) || parent.closest("svg")) continue;
    const kids = [...parent.children].filter((k) => inflow(k) && shown(k) && !srOnly(k)).map((k) => [k, k.getBoundingClientRect()]).filter(([, r]) => r.width > 4 && r.height > 4);
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const [a, ra] = kids[i], [b, rb] = kids[j];
      const dx = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), dy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (dx > 3 && dy > 3) add("overlap", a, `over ${short(b)} by ${Math.round(dx)}×${Math.round(dy)}`, b);
    }
  }

  // --- spill: text drawn outside its card (a box with a border, a background or a shadow) ----------------------------

  for (const el of leaves) {
    if (findings.length >= max) break;
    if (!el.closest("main")) continue;
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a.tagName !== "MAIN"; a = a.parentElement) {
      const c = style(a);
      if (c.position === "absolute" || c.position === "fixed" || clips(c, "x") || clips(c, "y")) break;
      if (!/^(SECTION|ARTICLE|ASIDE|LI|DIV|FORM|FIELDSET|DETAILS|A)$/.test(a.tagName) || !boxed(a)) continue;
      const k = a.getBoundingClientRect();
      if (r.bottom > k.bottom + 4 || r.right > k.right + 4 || r.top < k.top - 4 || r.left < k.left - 4) add("spill", el, `outside ${short(a)}`, a);
      break;
    }
  }

  // --- cramped scroll areas ---------------------------------------------------------------------------------------
  const areas = [...document.body.querySelectorAll("*")].filter((el) => {
    if (!shown(el) || exempt(el)) return false;
    const c = style(el);
    return (scrolls(c, "y") && el.scrollHeight > el.clientHeight + 2) || (scrolls(c, "x") && el.scrollWidth > el.clientWidth + 2 && c.scrollbarWidth !== "none");
  });
  for (const el of areas) {
    const c = style(el);
    if (scrolls(c, "y") && el.scrollHeight > el.clientHeight + 2 && el.clientHeight < 72) add("cramped", el, `scrolls ${el.scrollHeight}px inside ${el.clientHeight}px`);
  }

  // --- end: the end of every vertical scroll area (and the page) comes fully into view, above any fixed bar ---------
  // Scrolled synchronously (layout and hit testing follow at once) and put back afterwards.
  const ends = areas.filter((el) => scrolls(style(el), "y") && el.scrollHeight > el.clientHeight + 2);
  if (docScrolls("y")) ends.push(docEl);
  for (const area of ends.slice(0, 16)) {
    if (findings.length >= max) break;
    const before = area.scrollTop;
    area.scrollTop = area.scrollHeight;
    const scope = area === docEl ? document.body : area;
    let last = null, bottom = -Infinity;
    for (const el of leaves) {
      if (el === area || !scope.contains(el) || (area === docEl && pinned(el))) continue;
      const b = el.getBoundingClientRect().bottom; if (b > bottom) { bottom = b; last = el; }
    }
    if (last) {
      const problem = reach(last);
      if (problem) add("end", last, `the end of ${short(area)} cannot be brought into view`, area);
      else { const by = coverer(last, { pinnedToo: true }); if (by) add("end", last, `the end of ${short(area)} stays under ${short(by)}`, by); }
    }
    area.scrollTop = before;
  }

  // --- warnings: small text, truncation without a tooltip ----------------------------------------------------------
  for (const el of leaves) {
    if (findings.length >= max) break;
    const c = style(el);
    if (ownText(el) && parseFloat(c.fontSize) < 11 && !el.closest("[data-tap-ok]")) add("small-text", el, `${c.fontSize}`);
    const tip = el.title || el.closest("[title]") || el.getAttribute("aria-label") || el.closest("[data-tooltip]");
    if (c.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1 && !tip) add("truncated", el, "ellipsis without a tooltip");
    else if (c.webkitLineClamp && c.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 2 && !tip) add("truncated", el, "clamped without a tooltip");
  }
  return { findings, areas: areas.filter((el) => style(el).overflowY !== "visible" && el.scrollHeight > el.clientHeight + 2).length };
}

/** Outlines each finding's box in the page (for screenshots); returns a remover. */
export function markFindings(findings) {
  const layer = document.createElement("div");
  layer.setAttribute("data-layout-marks", "");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const colour = { covered: "#e5484d", overlap: "#e5484d", spill: "#f76b15", clipped: "#ffb224", unreachable: "#8e4ec6", sideways: "#0090ff", cramped: "#12a594", end: "#d6409f" };
  for (const f of findings) {
    if (!f.box) continue;
    const d = document.createElement("div");
    d.style.cssText = `position:fixed;left:${f.box.x}px;top:${f.box.y}px;width:${Math.max(4, f.box.w)}px;height:${Math.max(4, f.box.h)}px;outline:2px solid ${colour[f.rule] ?? "#888"};outline-offset:1px;background:color-mix(in srgb, ${colour[f.rule] ?? "#888"} 12%, transparent)`;
    const t = document.createElement("span");
    t.textContent = f.rule;
    t.style.cssText = `position:absolute;left:0;top:-15px;font:600 10px/14px system-ui;color:#fff;background:${colour[f.rule] ?? "#888"};padding:0 4px;border-radius:3px`;
    d.append(t);
    layer.append(d);
  }
  document.body.append(layer);
}

// --- driving a browser ----------------------------------------------------------------------------------------------

/** A browser context signed in by the Access header, refusing every API write (sweeps of real data stay read-only). */
export async function openContext(browser, { base, email, width, height, theme = "light", session }) {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const origin = new URL(base).origin;
  if (session) await ctx.addCookies([{ name: "pulse_session", value: session, url: base, httpOnly: true, sameSite: "Lax" }]);
  await ctx.route("**/*", (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) return route.continue();
    if (url.pathname.startsWith("/api/") && req.method() !== "GET" && req.method() !== "HEAD") return route.fulfill({ status: 204, body: "" });
    return route.continue({ headers: email ? { ...req.headers(), "cf-access-authenticated-user-email": email } : req.headers() });
  });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); } catch {} }, theme);
  return ctx;
}

/** Opens a route and waits until the page has settled: main has text and nothing in it is still loading. */
export async function openRoute(ctx, url, { timeout = 90_000 } = {}) {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
  const response = await page.goto(url, { waitUntil: "load", timeout });
  if (response && response.status() >= 400) errors.push(`HTTP ${response.status()}`);
  await page.waitForFunction(() => { const m = document.querySelector("main"); return m && m.innerText.trim().length > 10 && !m.querySelector("[aria-busy='true']"); }, {}, { timeout: Math.min(timeout, 60_000) }).catch(() => errors.push("main did not settle"));
  await settle(page, 600);
  return { page, errors };
}

const fileName = (path) => path.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root";

/** Every route at every size. `log` gets one line per view; returns the records ({ path, width, height, findings }). */
export async function sweep(browser, { base, email, session, routes, sizes = SIZES, theme = "light", out, shots = false, allShots = false, discover = false, warn = false, log = console.log, onRecord, stop = () => false }) {
  const records = [];
  const list = [...routes];
  for (const [width, height] of sizes) {
    const ctx = await openContext(browser, { base, email, session, width, height, theme });
    const queue = [...list], done = new Set();
    while (queue.length && !stop()) {
      const path = queue.shift(); if (done.has(path)) continue; done.add(path);
      let page;
      try {
        const opened = await openRoute(ctx, base + path); page = opened.page;
        const { findings: all } = await page.evaluate(auditLayout, {});
        const bad = all.filter((f) => BLOCKING.includes(f.rule));
        const record = { path, width, height, theme, findings: all, errors: opened.errors };
        records.push(record); onRecord?.(record);
        const shown = warn ? all : bad;
        log(`${bad.length ? "✗" : "✓"} ${width}x${height} ${path}${shown.length || opened.errors.length ? `\n    ${[...shown.map((f) => `${f.rule}: ${f.where} — ${f.detail}`), ...opened.errors].join("\n    ")}` : ""}`);
        if (out && ((shots && bad.length) || allShots)) {
          await page.evaluate(markFindings, bad);
          await page.screenshot({ path: `${out}/${theme}-${width}-${fileName(path)}.png` });
        }
        if (discover && width === sizes[0][0]) {
          const more = await page.evaluate(() => [...document.querySelectorAll("main nav[aria-label='Sections'] a, main nav[aria-label='Views'] a")]
            .map((a) => a.getAttribute("href")).filter((h) => h && h.split("?")[0] === location.pathname));
          for (const href of more.slice(0, 14)) if (!done.has(href) && !queue.includes(href) && !list.includes(href)) { queue.push(href); list.push(href); }
        }
      } catch (e) {
        const record = { path, width, height, theme, findings: [], errors: [String(e.message ?? e).slice(0, 300)] };
        records.push(record); onRecord?.(record);
        log(`! ${width}x${height} ${path}: ${String(e.message ?? e).slice(0, 160)}`);
      } finally { await page?.close(); }
    }
    await ctx.close();
  }
  return records;
}

/** Every page and its main tabs (record pages are added by `recordRoutes`). */
export const ROUTES = Object.freeze(["/dashboard", "/dashboard?tab=research", "/tasks", "/tasks?view=week", "/tasks?view=projects", "/tasks?view=team", "/tasks/outcomes", "/my-week",
  "/chats", "/inbox", "/groups", "/communication", "/clients", "/clients?tab=renewals", "/projects", "/acquisition", "/contacts", "/contacts/identity", "/map",
  "/people", "/people?view=list", "/people?tab=tracking", "/activity", "/designers", "/me", "/me?tab=attendance", "/me?tab=leave", "/me?tab=performance",
  "/me?tab=requests", "/me?tab=policies", "/me?tab=accounts", "/me/approvals", "/me/work", "/hr", "/hr?tab=approvals", "/hr?tab=pods", "/hr?tab=attendance",
  "/hr?tab=leave", "/hr?tab=requests", "/hr?tab=payroll", "/hr?tab=policies", "/hr?tab=moves", "/hr/help", "/hr-history", "/shifts", "/leadership",
  "/leadership?tab=growth", "/leadership?tab=outcomes", "/leadership?tab=pipeline", "/finance", "/finance/desk", "/money", "/review-data", "/opshub", "/audit",
  "/settings", "/settings?tab=team", "/settings?tab=roles", "/settings?tab=connected", "/settings?tab=organisation", "/settings?tab=work-rules", "/brand",
  "/briefs", "/notifications", "/account", "/connect", "/delivery", "/welcome", "/insights-demo"]);

/** One of each record page (a client, a contact, a person and their tabs, a project, a task), read through the web app's API proxy. */
export async function recordRoutes(browser, { base, email, session }) {
  const ctx = await openContext(browser, { base, email, session, width: 1440, height: 900 });
  const read = async (path, key) => { try { const r = await ctx.request.get(`${base}/api/v0/${path}`, { headers: email ? { "cf-access-authenticated-user-email": email } : {} }); if (!r.ok()) return []; const d = await r.json(); return d[key] ?? []; } catch { return []; } };
  const [clients, contacts, people, projects, tasks] = await Promise.all([read("clients", "clients"), read("contacts", "contacts"), read("people", "people"), read("projects", "projects"), read("work/tasks", "tasks")]);
  await ctx.close();
  const person = people.find((p) => p.status === "active") ?? people[0];
  return [
    ...(clients[0] ? [`/clients/${clients[0].id}`] : []), ...(contacts[0] ? [`/contacts/${contacts[0].id}`] : []),
    ...(person ? ["", "?tab=work", "?tab=projects", "?tab=attendance", "?tab=hr", "?tab=documents"].map((q) => `/people/${person.id}${q}`).concat(`/tasks/people/${person.id}`) : []),
    ...(projects[0] ? [`/projects/${projects[0].projectId}`, `/stewardship/project/${projects[0].projectId}`] : []),
    ...(tasks[0]?.id ? [`/tasks/${tasks[0].id}`] : []),
  ];
}
