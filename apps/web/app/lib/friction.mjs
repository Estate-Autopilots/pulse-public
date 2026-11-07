// BUGKIT-TELEMETRY (owner, 6 Nov 2026: "find friction before users even report it"). The pure half of friction on the
// device, plus one watcher installed once by the bug reporter's host (reporter.tsx):
//   ui.rage         3 or more clicks in under a second on the same spot
//   ui.dead         a click on a button or link after which nothing changed for a second (no DOM change, no request, no
//                   new address, no focus move)
//   ui.form.start / ui.form.error / ui.form.abandon   a form begun, its errors appearing (aria-invalid), and left unsent
//   ui.stuck        more than 20 s without input on a form that shows errors
//   ui.toast.error  an error notice shown
//   nav.backloop    going back three times within 20 s
// Each goes to telemetry (when it is on) and, as a "signal", to the soft prompt ("Looks like something's off, want to
// tell us?"), which promptGate() rate-limits. Also the element picker's description of an element (a stable selector,
// the component's name when React exposes it, its box and a short label: never a typed value) and the screens whose
// text a session replay masks entirely (money and people's personal details).
import { describe, describeForm, safeLabel, scrub, screenOf } from "./telemetry.mjs";

/** (x, y, time ms) → true once when the third click lands within `windowMs` and `radius` px of the first. */
export function rageDetector({ clicks = 3, windowMs = 1000, radius = 30 } = {}) {
  let burst = [];
  let fired = false;
  return (x, y, t) => {
    burst = burst.filter((c) => t - c.t < windowMs && Math.hypot(c.x - x, c.y - y) <= radius);
    if (!burst.length) fired = false;
    burst.push({ x, y, t });
    if (burst.length >= clicks && !fired) { fired = true; return burst.length; }
    return 0;
  };
}

/** (time ms) → true when the `count`th back navigation lands within `windowMs`. */
export function backLoopDetector({ count = 3, windowMs = 20_000 } = {}) {
  let backs = [];
  return (t) => {
    backs = [...backs.filter((b) => t - b < windowMs), t];
    if (backs.length >= count) { backs = []; return true; }
    return false;
  };
}

/** The soft prompt's limits: at most one every 10 minutes and 3 a day, and none for 2 hours after "Not now". `store` is
 *  {get(key), set(key, value)} (localStorage on the device). */
export function promptGate(store, { gapMs = 10 * 60_000, perDay = 3, afterDismissMs = 2 * 3600_000 } = {}) {
  const KEY = "pulse.friction.prompt";
  const read = () => { try { const s = JSON.parse(store.get(KEY) ?? "null"); return s && typeof s === "object" ? s : { shown: [], dismissed: 0 }; } catch { return { shown: [], dismissed: 0 }; } };
  const write = (s) => { try { store.set(KEY, JSON.stringify(s)); } catch { /* private mode */ } };
  return {
    may(now) {
      const s = read();
      const today = (s.shown ?? []).filter((t) => now - t < 24 * 3600_000);
      if (today.length >= perDay) return false;
      if (today.length && now - Math.max(...today) < gapMs) return false;
      return !(s.dismissed && now - s.dismissed < afterDismissMs);
    },
    shown(now) { const s = read(); write({ ...s, shown: [...(s.shown ?? []).filter((t) => now - t < 24 * 3600_000), now] }); },
    dismissed(now) { const s = read(); write({ ...s, dismissed: now }); },
  };
}

// ------------------------------------------------------------------------------------------------ the element picker
const tagOf = (el) => String(el?.tagName ?? "").toLowerCase();
const attr = (el, name) => { try { return el?.getAttribute?.(name) ?? null; } catch { return null; } };
const cssEscape = (s) => String(s).replace(/["\\]/g, "\\$&");
const cleanClass = (c) => { const part = c.includes("__") ? c.split("__").pop() : c; return /^[A-Za-z][A-Za-z0-9-]{1,30}$/.test(part) && !/\d{3}/.test(part) ? part : null; };

/** A selector that finds this element again: anchored at the nearest test id, element id or aria-label, then one
 *  tag:nth-of-type step per level (with a readable class name), at most six levels. */
export function stableSelector(el) {
  const steps = [];
  for (let node = el, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
    const tag = tagOf(node);
    if (!tag || tag === "html" || tag === "body") break;
    const test = attr(node, "data-testid");
    if (test) { steps.unshift(`[data-testid="${cssEscape(test)}"]`); break; }
    const id = attr(node, "id");
    if (id && /^[A-Za-z][A-Za-z0-9_-]{1,40}$/.test(id) && !/\d{3}/.test(id) && !/^(radix|headlessui|react|r\d|:)/i.test(id)) { steps.unshift(`#${id}`); break; }
    const label = depth === 0 ? safeLabel(attr(node, "aria-label")) : null;
    const cls = String(attr(node, "class") ?? "").split(/\s+/).map(cleanClass).find(Boolean);
    let step = cls ? `${tag}.${cls}` : tag;
    if (label) step += `[aria-label="${cssEscape(label)}"]`;
    const parent = node.parentElement;
    if (parent && !label) {
      const same = Array.from(parent.children ?? []).filter((c) => tagOf(c) === tag);
      if (same.length > 1) step += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    steps.unshift(step);
  }
  return steps.join(" > ").slice(0, 300) || null;
}

/** The React component that rendered the element, when its name survived the build (development, or a displayName):
 *  the nearest named function or class above the element's own fiber. */
export function componentOf(el) {
  try {
    const key = Object.keys(el ?? {}).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? el[key] : null;
    for (let i = 0; fiber && i < 40; i++, fiber = fiber.return) {
      const t = fiber.type;
      const name = typeof t === "function" ? (t.displayName || t.name) : t && typeof t === "object" ? (t.displayName || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name) : null;
      if (name && /^[A-Z][A-Za-z0-9]{2,60}$/.test(name)) return name;
    }
  } catch { /* not React */ }
  const named = el?.closest?.("[data-component]");
  return named ? scrub(attr(named, "data-component"), 60) : null;
}

/** What a picked element is: its selector, component, box (in the viewport and the viewport's size) and a short label:
 *  the aria-label, a short button or heading text, a title or a field's NAME, never what was typed or private text. */
export function describeElement(el, win = globalThis.window) {
  const r = el.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
  const tag = tagOf(el);
  const field = ["input", "select", "textarea"].includes(tag);
  const priv = !!el.closest?.("[data-private],[data-redact]");
  const text = !field && !priv ? safeLabel(String(el.textContent ?? "").slice(0, 120)) : null;
  const label = safeLabel(attr(el, "aria-label")) || text || safeLabel(attr(el, "title")) || (field ? safeLabel(attr(el, "name") || attr(el, "placeholder")) : null)
    || describe(el, win?.location)?.name || tag;
  return {
    sel: stableSelector(el), component: componentOf(el), label: scrub(label, 80), tag, role: attr(el, "role") ?? undefined,
    box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    vw: Math.round(win?.innerWidth ?? 0), vh: Math.round(win?.innerHeight ?? 0), sy: Math.round(win?.scrollY ?? 0),
  };
}

// ------------------------------------------------------------------------------------------------ replay privacy
// Screens about money and people's personal details: a replay masks every word on them, not only fields.
const PRIVATE_SCREENS = [/^\/(finance|erp|billing|payroll|money|expenses|invoices|salary|payslips?|bank)(\/|$)/, /^\/hr\/people\/[^/]+/, /^\/people\/[^/]+/, /^\/me\/(pay|salary|bank|documents)/];
const PRIVATE_TABS = /^(pay|payroll|salary|bank|documents|personal|compensation|finance|money|invoices|expenses|kyc|identity)$/;
/** True for a screen whose words a replay hides entirely (money, pay, people's personal pages). */
export function privateScreen(href) {
  let u;
  try { u = new URL(href, "http://pulse.invalid"); } catch { return true; }
  if (PRIVATE_SCREENS.some((r) => r.test(u.pathname))) return true;
  const tab = u.searchParams.get("tab") ?? u.searchParams.get("view") ?? "";
  return PRIVATE_TABS.test(tab);
}

/** Text as a replay may show it: masked letter for letter on a private screen or inside data-private / data-redact,
 *  otherwise with e-mails, phone numbers, tokens and long numbers masked. */
export function replayText(text, { inPrivate = false, screenPrivate = false } = {}) {
  if (typeof text !== "string" || !text) return text;
  if (inPrivate || screenPrivate) return text.replace(/\S/g, "*");
  return text.replace(/[^\s@/?#:;,"'<>()]+@[^\s@/?#:;,"'<>()]+\.[a-z]{2,}/gi, (m) => "*".repeat(m.length))
    .replace(/\+?\d[\d\s-]{7,}\d/g, (m) => m.replace(/\d/g, "*"))
    .replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, (m) => "*".repeat(m.length))
    .replace(/(?:₹|rs\.?|inr|\$|€|£)\s?[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s?(?:₹|inr)/gi, (m) => m.replace(/\d/g, "*"));
}

// ------------------------------------------------------------------------------------------------ the watcher
const CLICKABLE = 'button,[role="button"],a[href],[role="tab"],[role="menuitem"],summary,[role="link"]';
const QUIET_MS = 1000;
const STUCK_MS = 20_000;

/** Installs the friction watcher once (browser only). `emit(kind, fields)` sends a telemetry event; `signal(trig, info)`
 *  tells the soft prompt; `notices` is {current(), subscribe(fn)} from the notice centre (optional). Returns a stop(). */
export function installFrictionWatch({ emit, signal, notices } = {}) {
  if (typeof window === "undefined") return () => {};
  const w = window, d = document;
  const stops = [];
  const on = (target, type, fn, opts) => { const h = (e) => { try { fn(e); } catch { /* never breaks the page */ } }; target.addEventListener(type, h, opts); stops.push(() => target.removeEventListener(type, h, opts)); };
  const send = (k, f) => { try { emit?.(k, f); } catch { /* telemetry off */ } };
  const tell = (trig, info) => { try { signal?.(trig, info); } catch { /* no prompt */ } };
  const frac = (v, of) => (of > 0 ? Math.round(Math.min(1, Math.max(0, v / of)) * 1000) / 1000 : undefined);
  let lastInput = Date.now();
  const ownUi = (el) => !!el?.closest?.("[data-bug-reporter],[data-bug-picker]");

  // Rage and dead clicks.
  const rage = rageDetector();
  let deadRecent = [];
  on(d, "click", (e) => {
    lastInput = Date.now();
    const target = e.target;
    if (ownUi(target)) return;
    const info = describe(target, w.location);
    const fx = frac(e.clientX, w.innerWidth), fy = frac(e.clientY, w.innerHeight);
    const n = rage(e.clientX, e.clientY, Date.now());
    if (n) {
      send("ui.rage", { n: info?.name ?? tagOf(target), x: { sel: info?.sel ?? undefined, fx, fy, clicks: n } });
      tell("rage", { name: info?.name });
      return;
    }
    const el = target?.closest?.(CLICKABLE);
    if (!el || el.disabled || attr(el, "aria-disabled") === "true" || attr(el, "target") || attr(el, "download")) return;
    const href = w.location.href, focus = d.activeElement, res = w.performance?.getEntriesByType?.("resource")?.length ?? 0;
    let changed = false;
    const mo = new MutationObserver(() => { changed = true; });
    mo.observe(d.body, { childList: true, subtree: true, attributes: true, characterData: true });
    setTimeout(() => {
      try {
        mo.disconnect();
        const moved = w.location.href !== href || (w.performance?.getEntriesByType?.("resource")?.length ?? 0) !== res || d.activeElement !== focus;
        if (changed || moved || d.visibilityState !== "visible") return;
        send("ui.dead", { n: info?.name ?? tagOf(el), x: { sel: info?.sel ?? undefined, fx, fy } });
        const now = Date.now();
        deadRecent = [...deadRecent.filter((t) => now - t < 30_000), now];
        if (deadRecent.length >= 2) { deadRecent = []; tell("dead", { name: info?.name }); }
      } catch { /* never breaks the page */ }
    }, QUIET_MS);
  }, { capture: true, passive: true });

  // Going back and forth.
  const back = backLoopDetector();
  on(w, "popstate", () => { if (back(Date.now())) { send("nav.backloop", { n: screenOf(w.location.href), x: { backs: 3 } }); tell("back", {}); } });

  // Forms: started, errors, abandoned, stuck.
  const forms = new Map();
  const formOf = (el) => el?.form ?? el?.closest?.('form,[role="form"],[role="dialog"]') ?? null;
  const nameOf = (form) => (tagOf(form) === "form" ? describeForm(form, w.location).name : safeLabel(attr(form, "aria-label")) || attr(form, "data-testid") || `${attr(form, "role") ?? "form"} ${screenOf(w.location.href)}`);
  const errorsIn = (form) => { try { return form.querySelectorAll('[aria-invalid="true"]').length; } catch { return 0; } };
  on(d, "focusin", (e) => {
    const el = e.target;
    if (!["input", "select", "textarea"].includes(tagOf(el)) || ownUi(el)) return;
    const form = formOf(el);
    if (!form || forms.has(form)) return;
    const name = scrub(nameOf(form), 120);
    forms.set(form, { name, touched: new Set(), errs: 0, sent: false, stuck: false, page: screenOf(w.location.href) });
    send("ui.form.start", { n: name });
  }, { capture: true, passive: true });
  const typed = (e) => {
    lastInput = Date.now();
    const f = forms.get(formOf(e.target));
    if (f) f.touched.add(attr(e.target, "name") || attr(e.target, "id") || f.touched.size);
  };
  on(d, "input", typed, { capture: true, passive: true });
  on(d, "change", typed, { capture: true, passive: true });
  on(d, "keydown", () => { lastInput = Date.now(); }, { capture: true, passive: true });
  on(d, "pointerdown", () => { lastInput = Date.now(); }, { capture: true, passive: true });
  on(d, "submit", (e) => { const f = forms.get(e.target); if (f) f.sent = true; }, { capture: true, passive: true });
  const leave = (all) => {
    for (const [form, f] of forms) {
      const gone = all || !form.isConnected || screenOf(w.location.href) !== f.page;
      if (!gone) continue;
      if (!f.sent && f.touched.size) send("ui.form.abandon", { n: f.name, p: f.page, x: { touched: f.touched.size, errs: f.errs } });
      forms.delete(form);
    }
  };
  const tick = setInterval(() => {
    try {
      leave(false);
      for (const [form, f] of forms) {
        const errs = errorsIn(form);
        if (errs > f.errs) send("ui.form.error", { n: f.name, x: { errs } });
        f.errs = errs;
        if (errs && !f.stuck && Date.now() - lastInput > STUCK_MS && d.visibilityState === "visible") {
          f.stuck = true;
          send("ui.stuck", { n: f.name, x: { errs } });
          tell("stuck", { name: f.name });
        }
      }
    } catch { /* never breaks the page */ }
  }, 2000);
  stops.push(() => clearInterval(tick));
  on(w, "pagehide", () => leave(true));

  // Error notices.
  if (notices?.subscribe) {
    const seen = new Set((notices.current?.() ?? []).map((n) => n.id));
    stops.push(notices.subscribe(() => {
      for (const n of notices.current?.() ?? []) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        if (n.tone !== "error" || String(n.id).startsWith("bug-")) continue;
        send("ui.toast.error", { n: safeLabel(n.title) ?? "error" });
        tell("error", { name: safeLabel(n.title) });
      }
    }));
  }
  return () => { for (const s of stops.splice(0)) s(); };
}
