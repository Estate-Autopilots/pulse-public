// TELEMETRY (owner, 24 Oct 2026): "every single movement in the app must be tracked, so we can improve response times".
// One collector for the web app and the phone app's WebView (the same pages), mounted once by telemetry-host.tsx. It is
// automatic, never placed per button:
//   nav.load / nav.route   a page load or route change (also ?tab=/?view=), timed from the click (or navigation start) to the
//                          screen settling: no DOM change for a moment, no request in flight, nothing aria-busy
//   ui.click / ui.submit / ui.key   every click or tap on an interactive element, form submit (field NAMES only) and
//                          shortcut (Ctrl/⌘/Alt + key, Escape; never a plain key: that is typing), with the time to the next
//                          paint and to the settled screen
//   ui.dialog.open/close, ui.panel.open/close, ui.tab, ui.scroll (depth per page view), nav.leave (time on the page)
//   api                    every same-origin /api/ call: method and route template, status, time to the answer, sizes, and
//                          the x-pulse-request-id the API's own timing row carries (joined on the dashboard)
//   vital.lcp/fcp/ttfb/cls/inp, perf.longtask   from PerformanceObserver
//   perf.stream            a live stream (EventSource) opening: the time until it connected; error.stream when it gives up
//   perf.edge              once a session: which Cloudflare location answers this person and its round trip alone
//                          (/cdn-cgi/trace never reaches Pulse's server), so an API call's wait splits into the person's
//                          network to the edge, the edge to the server, and the server itself (PERF, R072)
//   app.start              the phone app's first screen after a cold start: the native start before the page (when the
//                          shell can say) plus the time until the screen settled (PERF)
// PERF: a page load carries the document's request id (Server-Timing "pulse", set by proxy.ts), the id the API calls of
// its server render carry, so the dashboard shows what a page's first byte waited on. Background polls (no action in
// flight) are sampled after their first few calls: one in POLL_SAMPLE kept, marked x.sample; errors always kept.
//   error.js/promise/boundary/resource, app.online/offline/background/foreground/resume/pause, app.session
// Privacy: no typed text, input values, message bodies, file contents, passwords or tokens are ever read. Labels come
// from data-testid, link targets (as templates) and short UI words; ids, e-mails, numbers and likely names are removed.
// Cost: listeners are passive and do a few attribute reads; everything else (JSON, sending) runs on timers. Batches go
// every 10 s and when the page hides (keepalive fetch, else sendBeacon), with a small offline queue in localStorage.

export const ENDPOINT = "/api/v0/telemetry";
export const REQUEST_HEADER = "x-pulse-request-id";
const POLL_FREE = 3, POLL_SAMPLE = 5;
const QUIET_MS = 200, CAP_MS = 10_000, FLUSH_MS = 10_000, MAX_QUEUE = 1000, BATCH = 200, KEEPALIVE_MAX = 60_000;
const STORE_QUEUE = "pulse.telemetry.queue", STORE_SESSION = "pulse.telemetry.session";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[^\s@/?#:;,"'<>()]+@[^\s@/?#:;,"'<>()]+\.[a-z]{2,}/gi;
const TOKEN = /(?<![A-Za-z0-9_-])(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;
const PHONE = /\+?\d[\d\s-]{7,}\d/g;

/** Text with ids, e-mail addresses, tokens, phone numbers and long numbers replaced; trimmed to `max`. */
export function scrub(text, max = 120) {
  if (typeof text !== "string") return null;
  const s = text.replace(UUID, ":id").replace(EMAIL, ":email").replace(TOKEN, ":token").replace(PHONE, ":n").replace(/\d{4,}/g, ":n")
    .replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

// Product and UI words that are capitalised in labels without being anyone's name.
const UI_WORDS = new Set(("Pulse Pip Dashboard Settings Chats Chat Work Clients Client Contacts Processes Runs Team Leadership Finance Billing Audit Telemetry " +
  "Google Drive WhatsApp Gmail Search Go Open New Add Save Cancel Close Edit Delete Remove Back Next Previous More Home Money People Map Network Updates " +
  "Inbox Calls Call Review Data Desk My Done All Today Tomorrow Yesterday Week Month Year Day Tasks Task Projects Project Leave Attendance Check In Out " +
  "Profile Account Security Notifications Help Sign Theme Dark Light Mode Filter Sort Export Import Download Upload Share Copy Link Send Reply Approve " +
  "Reject Submit Confirm Assign Status Priority Due Date Details Overview Summary Reports Report Ops Hub Studio Offer Quote Invoice Invoices Expenses " +
  "Payroll Policies Holidays Shifts Forms Workflows Boards Steps Kit Brand Companies Features Insights Intelligence Activity Designers Creative Strategy " +
  "Sales X-Ray Acquisition Relationships Stewardship Organisation Organization Roles Members Groups Devices Connections Connect Apps Developers Pages " +
  "Sections Menu Navigation Main Notes Files File Photo Photos Video Videos Comments Comment Calendar Schedule Time Timer Start Stop Pause Resume").split(" "));

/** A short UI label, or null when it looks like content: more than six words, or a capitalised word after the first that
 *  is not a product or UI word (likely a person's or a client's name: "Chat with Ruvin"). Acronyms (HR, AI) stay. */
export function safeLabel(text, max = 60) {
  const s = scrub(text, 200);
  if (!s) return null;
  const words = s.split(" ");
  if (words.length > 6 || s.length > max) return null;
  if (words.some((w, i) => i > 0 && /^[A-Z][a-z]/.test(w) && !UI_WORDS.has(w.replace(/[^A-Za-z-]/g, "")))) return null;
  return s;
}

/** "/people/3f2a…/files?q=x" → "/people/:id/files?q": ids become :id, the query keeps its keys only. */
export function pathTemplate(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const [path, query = ""] = raw.split("#")[0].split("?");
  const parts = path.split("/").map((seg) => {
    if (!seg) return seg;
    let d = seg;
    try { d = decodeURIComponent(seg); } catch { /* keep it */ }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d)) return ":id";
    if (/^\d+$/.test(d)) return ":n";
    if (d.includes("@")) return ":email";
    if ((/\d/.test(d) && d.length >= 6) || d.length > 40 || /[^A-Za-z0-9._~-]/.test(d)) return ":id";
    return d;
  });
  const keys = [...new Set(query.split("&").map((p) => p.split("=")[0]).filter((k) => /^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(k)))].sort();
  return (parts.join("/") + (keys.length ? `?${keys.join("&")}` : "")).slice(0, 200);
}

/** The screen a URL shows: its path template plus the tab and view it is on ("/hr?tab=leave"). */
export function screenOf(href) {
  let u;
  try { u = new URL(href, "http://pulse.invalid"); } catch { return null; }
  const path = pathTemplate(u.pathname) ?? "/";
  const keep = ["tab", "view", "section"].map((k) => [k, u.searchParams.get(k)]).filter(([, v]) => v && /^[a-z][a-z0-9-]{0,30}$/.test(v));
  return keep.length ? `${path}?${keep.map(([k, v]) => `${k}=${v}`).join("&")}` : path;
}

/** web / android / ios / desktop and the phone app's shell version, from the user agent and the page's globals. */
export function platformOf(ua, globals = {}) {
  const shell = /\bPulseShell\/(\d{1,4}(?:\.\d{1,4}){0,3})/.exec(ua ?? "");
  if (shell) return { plat: /iPhone|iPad|iOS/.test(ua) ? "ios" : "android", shell: shell[1] };
  if (globals.__TAURI__ || globals.__TAURI_INTERNALS__ || /\bPulseDesktop\//.test(ua ?? "")) return { plat: "desktop", shell: null };
  return { plat: "web", shell: null };
}

/** phone / tablet / desktop from the user agent, the narrow side of the screen and a coarse pointer. */
export function deviceClass(ua, shortSide, coarse) {
  if (/iPad|Tablet/.test(ua ?? "") || (coarse && shortSide >= 600 && !/Mobile/.test(ua ?? ""))) return "tablet";
  if (/iPhone|iPod|Android.+Mobile|PulseShell/.test(ua ?? "") || (coarse && shortSide < 600)) return "phone";
  return "desktop";
}

const INTERACTIVE = 'a[href],button,[role="button"],[role="tab"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="treeitem"],[role="gridcell"],summary,label,input,select,textarea,[data-testid],[tabindex]:not([tabindex="-1"])';
// Inside these, an element's own words are likely content (a person in a list, a message, a client's row).
const REPEATING = 'li,tr,[role="row"],[role="listitem"],[role="gridcell"],[role="option"],[role="article"],article,[contenteditable="true"],[data-private]';

const attr = (el, name) => { try { return el.getAttribute?.(name) ?? null; } catch { return null; } };
const tagOf = (el) => String(el?.tagName ?? "").toLowerCase();
/** CSS-module class names lose their hash ("ui-module__a1B2c__btn" → "btn"). */
const cleanClass = (c) => { const part = c.includes("__") ? c.split("__").pop() : c; return /^[A-Za-z][A-Za-z0-9-]{1,30}$/.test(part) && !/\d{3}/.test(part) ? part : null; };

/** A short structural path for an element: up to four levels of tag, test id and first clean class name. */
export function selectorOf(el) {
  const out = [];
  for (let node = el, depth = 0; node && depth < 4 && tagOf(node) && tagOf(node) !== "body" && tagOf(node) !== "html"; node = node.parentElement, depth++) {
    const test = attr(node, "data-testid");
    if (test) { out.unshift(`[data-testid=${scrub(test, 40)}]`); break; }
    const id = attr(node, "id");
    if (id && /^[A-Za-z][A-Za-z0-9_-]{1,40}$/.test(id) && !/\d{3}/.test(id) && !/^(radix|headlessui|react|r\d|:)/i.test(id)) { out.unshift(`${tagOf(node)}#${id}`); break; }
    const cls = String(attr(node, "class") ?? "").split(/\s+/).map(cleanClass).find(Boolean);
    out.unshift(cls ? `${tagOf(node)}.${cls}` : tagOf(node));
  }
  return out.join(">").slice(0, 160) || null;
}

/** What a click or tap was on: a stable name (test id, link target, short label, or role and tag), a structural
 *  selector, the tag and the role. Null when nothing interactive was hit. Never reads an input's value. */
export function describe(target, location = { href: "http://pulse.invalid/" }) {
  const el = target?.closest?.(INTERACTIVE);
  if (!el) return null;
  const tag = tagOf(el), role = attr(el, "role");
  const kind = role || (tag === "a" ? "link" : tag);
  let name = attr(el, "data-telemetry") || attr(el, "data-testid");
  let nav = false;
  if (!name && tag === "a") {
    const href = attr(el, "href") ?? "";
    let u = null;
    try { u = new URL(href, location.href); } catch { /* not a URL */ }
    if (u && u.origin === new URL(location.href).origin) {
      name = `link ${screenOf(u.href)}`;
      nav = screenOf(u.href) !== screenOf(location.href) && !attr(el, "target") && !attr(el, "download");
    } else if (u) name = `link ${u.protocol === "mailto:" || u.protocol === "tel:" ? u.protocol : u.hostname}`;
  }
  if (!name) {
    const label = safeLabel(attr(el, "aria-label")) || (["input", "select", "textarea"].includes(tag) ? safeLabel(attr(el, "name") || attr(el, "placeholder")) : null);
    if (label) name = `${kind} ${label}`;
  }
  if (!name && !["input", "select", "textarea"].includes(tag) && !el.closest?.(REPEATING) && (el.childElementCount ?? 0) <= 4) {
    const text = safeLabel(String(el.textContent ?? "").slice(0, 120));
    if (text) name = `${kind} ${text}`;
  }
  if (!name) { const t = attr(el, "title"); const label = t && !el.closest?.(REPEATING) ? safeLabel(t) : null; name = label ? `${kind} ${label}` : kind; }
  const out = { name: scrub(name, 120), sel: selectorOf(el), tag, role: role ?? undefined, nav };
  const expanded = attr(el, "aria-expanded");
  if (expanded !== null) out.expanded = expanded === "true";
  if (tag === "input") out.type = attr(el, "type") ?? "text";
  return out;
}

/** A form's name (test id, label, id or name) and the names of its fields: never their values. */
export function describeForm(form, location) {
  const name = attr(form, "data-telemetry") || attr(form, "data-testid") || safeLabel(attr(form, "aria-label")) || (/^[A-Za-z][A-Za-z0-9_-]{1,40}$/.test(attr(form, "id") ?? "") ? attr(form, "id") : null)
    || safeLabel(attr(form, "name")) || `form ${screenOf(new URL(attr(form, "action") || location.href, location.href).href)}`;
  const fields = [];
  for (const el of Array.from(form?.elements ?? [])) {
    const field = attr(el, "name") || attr(el, "id");
    if (field && fields.length < 30 && !fields.includes(field) && attr(el, "type") !== "hidden") fields.push(scrub(field, 40));
  }
  return { name: scrub(name, 120), fields: fields.filter(Boolean) };
}

/** PERF: whether to keep a background API call, and its sample weight. The first POLL_FREE calls of a route are kept,
 *  then one in POLL_SAMPLE (weight POLL_SAMPLE); a call during an action, a failure or a slow call (≥ 1 s) is always kept. */
export function pollSampler(free = POLL_FREE, every = POLL_SAMPLE) {
  const seen = new Map();
  const keep = (key, { during, status, ms }) => {
    if (during || !(status >= 200 && status < 400) || ms >= 1000) return { keep: true };
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (seen.size > 200) seen.delete(seen.keys().next().value);
    if (n <= free) return { keep: true };
    return (n - free) % every === 0 ? { keep: true, sample: every } : { keep: false };
  };
  /** A route seen more than `free` times with no action in flight: a background poll. */
  keep.isPoll = (key) => (seen.get(key) ?? 0) > free;
  return keep;
}

/** PERF: the document's request id from its Server-Timing entries ("pulse;desc=<id>"), when it has one. */
export function renderId(entries) {
  const e = Array.isArray(entries) ? entries.find((x) => x?.name === "pulse") : null;
  return e && /^[A-Za-z0-9_-]{8,64}$/.test(e.description ?? "") ? e.description : undefined;
}

/** PERF: the Cloudflare location and protocol from /cdn-cgi/trace ("colo=BOM", "http=http/3"), or null. */
export function edgeOf(text) {
  const colo = /^colo=([A-Z]{3})$/m.exec(String(text ?? ""))?.[1];
  if (!colo) return null;
  const http = /^http=(http\/[0-9.]{1,3})$/m.exec(String(text))?.[1];
  return { colo, ...(http ? { http } : {}) };
}

/** A random URL-safe id. */
export function randomId(bytes = 12) {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The batching queue: push events and flush every interval through `send(body)`, which answers {ok, status}:
 *  401/403/404/405 switch the collector off for this page, 0 (network), 429 and 5xx wait and try again, anything else
 *  (400, 413) drops the batch. The final flush (the page hiding or going away) hands one batch to `sendFinal(body)`, which
 *  queues it synchronously (keepalive fetch or beacon) and answers whether it could; its answer is never awaited, since a
 *  page that is going away may never see it (waiting for it re-sent delivered batches). What could not be handed over,
 *  the rest, or everything while `offline()`, is stored through `store` for the next page. */
export function createQueue({ send, sendFinal, context, store, offline, now = () => Date.now(), max = MAX_QUEUE, batch = BATCH }) {
  let queue = [], sending = false, off = false, waitUntil = 0, dropped = 0;
  const state = () => ({ size: queue.length, off, dropped, sending });
  function push(ev) {
    if (off) return;
    queue.push(ev);
    if (queue.length > max) { dropped += queue.length - max; queue.splice(0, queue.length - max); }
  }
  async function flush(final = false) {
    if (off || !queue.length || (sending && !final) || (!final && now() < waitUntil)) return false;
    if (final) {
      if (offline?.()) { store?.(queue.splice(0)); return false; }
      const events = queue.splice(0, batch);
      let handed = false;
      try { handed = !!sendFinal?.(JSON.stringify({ v: 1, ...context(), sentAt: now(), ev: events })); } catch { handed = false; }
      // One batch goes with the page; the rest (and a batch the browser would not take) waits for the next page.
      const rest = [...(handed ? [] : events), ...queue.splice(0)];
      if (rest.length) store?.(rest);
      return handed;
    }
    const events = queue.splice(0, batch);
    const body = JSON.stringify({ v: 1, ...context(), sentAt: now(), ev: events });
    sending = true;
    let result;
    try { result = await send(body); } catch { result = { ok: false, status: 0 }; }
    sending = false;
    if (result.ok) return true;
    if ([401, 403, 404, 405].includes(result.status)) { off = true; queue = []; return false; }
    if (result.status === 0 || result.status === 429 || result.status >= 500) {
      queue = [...events, ...queue].slice(-max);
      waitUntil = now() + (result.status === 429 ? 60_000 : 15_000);
    }
    return false;
  }
  return { push, flush, state, restore: (events) => { if (Array.isArray(events)) queue = [...events.slice(-max), ...queue].slice(-max); } };
}

// --------------------------------------------------------------------------------------------- the browser collector
let current = null;

/** Starts the collector once per page (later calls only update the release). Returns it, or null on the server, when
 *  switched off, or outside the sample. */
export function startTelemetry({ release = "dev", sample = 1, enabled = true } = {}) {
  if (typeof window === "undefined" || !enabled) return null;
  if (current) { current.release = release; return current; }
  try { current = collector(release, sample); } catch { current = null; }
  return current;
}

const STEPS = [];
function remember(ev) { STEPS.push(ev); if (STEPS.length > 60) STEPS.splice(0, STEPS.length - 60); }
/** BUG-REPORT (27 Oct 2026): the last `n` events this page recorded (kind, short name, screen, time, duration, status),
 *  oldest first, for a bug report the person chooses to send. Empty when telemetry is off or outside the sample. */
export function recentSteps(n = 50) {
  return STEPS.slice(-n).map((e) => ({ at: new Date(e.t).toISOString(), kind: e.k, ...(e.n ? { name: e.n } : {}), ...(e.p ? { page: e.p } : {}),
    ...(e.d !== undefined ? { ms: e.d } : {}), ...(e.s !== undefined ? { status: e.s } : {}) }));
}

/** The React shell calls this after every committed route (usePathname); an interaction in flight measures it itself. */
export function telemetryRoute() { try { current?.route(); } catch { /* never breaks the page */ } }

/** CALLS-V2: an event a feature measured itself (kind app.* / perf.* / error.*; n a short name, d a duration in ms,
 *  x a few numbers or short codes). Nothing when telemetry is off or outside the sample. */
export function telemetryEvent(kind, fields = {}) { try { current?.emit?.(kind, fields); } catch { /* never breaks the page */ } }

/** app/error.tsx: an error a React error boundary caught. */
export function reportError(error, source = "boundary") { try { current?.error(source, error); } catch { /* never breaks the page */ } }

function collector(release, sample) {
  const w = window, d = document, perf = w.performance;
  const origin = perf.timeOrigin;
  const session = (() => {
    try {
      const saved = JSON.parse(w.sessionStorage.getItem(STORE_SESSION) ?? "null");
      if (saved && Date.now() - saved.at < 30 * 60_000) { saved.at = Date.now(); w.sessionStorage.setItem(STORE_SESSION, JSON.stringify(saved)); return { ...saved, fresh: false }; }
    } catch { /* storage off */ }
    const s = { id: randomId(16), on: Math.random() < sample, at: Date.now() };
    try { w.sessionStorage.setItem(STORE_SESSION, JSON.stringify(s)); } catch { /* storage off */ }
    return { ...s, fresh: true };
  })();
  if (!session.on) return { route() {}, error() {}, release };
  const ua = w.navigator.userAgent;
  const { plat, shell } = platformOf(ua, w);
  const coarse = (() => { try { return w.matchMedia("(pointer: coarse)").matches; } catch { return false; } })();
  const dev = deviceClass(ua, Math.min(w.screen?.width ?? w.innerWidth, w.screen?.height ?? w.innerHeight), coarse);
  const me = { release, route, error };
  const originalFetch = w.fetch.bind(w);
  const queue = createQueue({
    context: () => ({ sid: session.id, app: { rel: me.release, plat, shell, dev } }),
    store: (events) => { try { w.localStorage.setItem(STORE_QUEUE, JSON.stringify(events.slice(-300))); } catch { /* storage off */ } },
    offline: () => w.navigator.onLine === false,
    send: async (body) => {
      const r = await originalFetch(ENDPOINT, { method: "POST", body, keepalive: body.length < KEEPALIVE_MAX, credentials: "same-origin", headers: { "content-type": "application/json" } });
      return { ok: r.ok, status: r.status };
    },
    // The page is going away: a keepalive request outlives it (and carries the Origin the web server checks); a beacon
    // when keepalive will not take the body. Queued synchronously; the answer is not awaited.
    sendFinal: (body) => {
      if (body.length < KEEPALIVE_MAX) {
        try { void originalFetch(ENDPOINT, { method: "POST", body, keepalive: true, credentials: "same-origin", headers: { "content-type": "application/json" } }).catch(() => {}); return true; } catch { /* over the keepalive quota */ }
      }
      return !!w.navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "application/json" }));
    },
  });
  // BUG-REPORT: the last events stay in memory for a bug report's "recent steps" (recentSteps()).
  const pushed = queue.push;
  queue.push = (ev) => { remember(ev); pushed(ev); };
  try { const saved = JSON.parse(w.localStorage.getItem(STORE_QUEUE) ?? "null"); w.localStorage.removeItem(STORE_QUEUE); queue.restore(saved); } catch { /* storage off */ }

  const at = (perfTime) => Math.round(origin + perfTime);
  const ms = (x) => (Number.isFinite(x) ? Math.max(0, Math.round(x)) : undefined);
  const emit = (k, f = {}) => queue.push({ k, t: f.t ?? Date.now(), ...(f.n ? { n: f.n } : {}), p: f.p ?? view.screen, ...(f.d !== undefined ? { d: f.d } : {}),
    ...(f.v !== undefined ? { v: f.v } : {}), ...(f.s !== undefined ? { s: f.s } : {}), ...(f.r ? { r: f.r } : {}), ...(f.x ? { x: f.x } : {}) });
  const safe = (fn) => function handler(...args) { try { return fn.apply(this, args); } catch { /* never breaks the page */ } };
  const busy = () => !!d.querySelector('[aria-busy="true"]');

  // ------------------------------------------------------------------ page views
  const loadScreen = screenOf(w.location.href);
  const view = { screen: loadScreen, href: w.location.href, start: 0, scroll: 0, cls: 0, clsWindow: 0, clsLast: 0, clsFirst: 0, inp: 0, long: 0, longMs: 0 };
  function endView(now = perf.now()) {
    const x = { lt: view.long, ltms: Math.round(view.longMs) };
    if (view.scroll > 0) emit("ui.scroll", { v: Math.round(view.scroll * 100) });
    emit("vital.cls", { n: view.screen, v: Math.round(view.cls * 1000) / 1000 });
    if (view.inp > 0) emit("vital.inp", { n: view.screen, d: ms(view.inp) });
    emit("nav.leave", { n: view.screen, d: ms(now - view.start), x });
  }
  function startView(href, now = perf.now()) {
    Object.assign(view, { screen: screenOf(href), href, start: now, scroll: 0, cls: 0, clsWindow: 0, clsLast: 0, clsFirst: 0, inp: 0, long: 0, longMs: 0 });
  }

  // ------------------------------------------------------------------ the phone app's cold start (PERF)
  // The shell's info() says how long its process ran before it was asked (newer shells); the page started at timeOrigin.
  const asked = perf.now();
  const native = shell ? Promise.race([
    Promise.resolve(w.Capacitor?.Plugins?.PulseShell?.info?.()).then((i) => (Number.isFinite(i?.processAgeMs) ? Math.max(0, i.processAgeMs - asked) : null), () => null),
    new Promise((done) => setTimeout(() => done(null), 3000)),
  ]) : Promise.resolve(null);
  function appStart(ready, x) {
    void native.then(safe((before) => emit("app.start", { t: at(0), n: loadScreen, p: loadScreen, d: ms((before ?? 0) + ready),
      x: { ...(before !== null ? { native: ms(before) } : {}), ready: ms(ready), ttfb: x.ttfb, dcl: x.dcl, shell } })));
  }

  // ------------------------------------------------------------------ interactions: action → next paint → settled
  let active = null, observer = null;
  function watchDom() {
    if (observer || typeof MutationObserver === "undefined") return;
    observer = new MutationObserver(() => { if (active) active.changed = perf.now(); });
    observer.observe(d.body ?? d.documentElement, { childList: true, subtree: true, characterData: true });
  }
  function begin(kind, info, t0) {
    if (active) finish(active, "interrupted");
    const it = { kind, info, t0, href: w.location.href, screen: screenOf(w.location.href), changed: t0, inflight: 0, api: 0, paint: undefined, pending: new Set() };
    active = it;
    watchDom();
    w.requestAnimationFrame(() => setTimeout(() => { it.paint = perf.now(); }, 0));
    const check = safe(() => {
      if (active !== it) return;
      const now = perf.now();
      if (now - it.t0 > CAP_MS) return finish(it, "timeout");
      const moved = w.location.href !== it.href;
      const quiet = it.paint !== undefined && it.inflight <= 0 && now - Math.max(it.changed, it.paint) >= QUIET_MS && !busy();
      // A link to another screen settles only once the address changed (Next fetches the page before committing it).
      if (quiet && (!it.info?.nav || moved)) return finish(it, null);
      setTimeout(check, 100);
    });
    setTimeout(check, 100);
  }
  const TRIGGER = { "ui.click": "click", "ui.submit": "submit", "ui.key": "key" };
  function finish(it, cut) {
    if (active === it) active = null;
    if (!active && observer) { observer.disconnect(); observer = null; }
    const end = Math.max(it.changed, it.paint ?? it.t0);
    // What was still pending when an action was cut short: requests, an aria-busy region, the DOM, or the address.
    const wait = cut ? [it.inflight > 0 && "fetch", busy() && "busy", perf.now() - it.changed < QUIET_MS && "dom", it.info?.nav && w.location.href === it.href && "nav"].filter(Boolean).join(",") : "";
    const pending = cut && it.pending.size ? it.pending.values().next().value : undefined;
    const x = { ...(it.info?.x ?? {}), paint: ms((it.paint ?? end) - it.t0), api: it.api, ...(cut ? { cut } : {}), ...(wait ? { wait } : {}), ...(pending ? { pending } : {}) };
    if (it.kind === "load") {
      const nav = perf.getEntriesByType?.("navigation")?.[0];
      Object.assign(x, { ttfb: ms(nav?.responseStart), dcl: ms(nav?.domContentLoadedEventEnd), load: ms(nav?.loadEventEnd) || undefined, bytes: nav?.transferSize, type: nav?.type,
        vw: w.innerWidth, vh: w.innerHeight });
      const r = renderId(nav?.serverTiming);
      emit("nav.load", { t: at(0), n: loadScreen, p: loadScreen, d: ms(end), r, x });
      if (nav?.responseStart) emit("vital.ttfb", { t: at(0), n: loadScreen, p: loadScreen, d: ms(nav.responseStart), r });
      if (session.fresh && shell) appStart(end, x);
    } else if (it.kind !== "nav.route") {
      emit(it.kind, { t: at(it.t0), n: it.info?.name, p: it.screen, d: ms(end - it.t0), x });
      if (it.info?.tab) emit("ui.tab", { t: at(it.t0), n: it.info.name, p: it.screen });
    }
    if (w.location.href !== view.href) routeChanged(it.kind === "nav.route" ? it.info?.trigger ?? "nav" : TRIGGER[it.kind] ?? "load", it.t0, end, cut);
    dialogs();
  }
  /** The address changed: close the old page view and open the new one, timed from the action that caused it. */
  function routeChanged(trigger, t0, end, cut) {
    const from = view.screen;
    endView(t0);
    startView(w.location.href, t0);
    emit("nav.route", { t: at(t0), n: view.screen, p: view.screen, d: ms(end - t0), x: { from, trig: trigger, ...(cut ? { cut } : {}) } });
  }
  function route() {
    if (w.location.href === view.href || active) return;
    // A route change nobody clicked (a redirect, a router.push after a save): timed from now until it settles.
    begin("nav.route", { trigger: "nav" }, perf.now());
  }

  d.addEventListener("click", safe((e) => {
    const info = describe(e.target, w.location);
    if (!info) return;
    const { name, nav, ...x } = info;
    begin("ui.click", { name, nav: nav && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0, tab: info.role === "tab" || !!e.target?.closest?.('[role="tablist"]'), x }, e.timeStamp || perf.now());
  }), { capture: true, passive: true });
  d.addEventListener("submit", safe((e) => {
    const form = describeForm(e.target, w.location);
    const t = e.timeStamp || perf.now();
    // The click on the submit button started this: the same action, now named as the form's submit.
    if (active?.kind === "ui.click" && t - active.t0 < 150) { active.kind = "ui.submit"; active.info = { name: form.name, x: { fields: form.fields, via: active.info?.name } }; return; }
    begin("ui.submit", { name: form.name, x: { fields: form.fields } }, t);
  }), { capture: true, passive: true });
  d.addEventListener("keydown", safe((e) => {
    // Never a plain key (that is typing): shortcuts with Ctrl, ⌘ or Alt, and Escape.
    const combo = e.key === "Escape" ? "Escape" : (e.ctrlKey || e.metaKey || e.altKey) && /^[a-z0-9]$/i.test(e.key ?? "")
      ? `${e.ctrlKey ? "Ctrl+" : ""}${e.metaKey ? "Meta+" : ""}${e.altKey ? "Alt+" : ""}${e.key.toUpperCase()}` : null;
    if (combo) begin("ui.key", { name: combo }, e.timeStamp || perf.now());
  }), { capture: true, passive: true });
  w.addEventListener("popstate", safe((e) => begin("nav.route", { trigger: "back" }, e.timeStamp || perf.now())));
  d.addEventListener("toggle", safe((e) => {
    const el = e.target;
    if (tagOf(el) !== "details" && !attr(el, "popover")) return;
    const open = tagOf(el) === "details" ? !!el.open : e.newState === "open";
    emit(open ? "ui.panel.open" : "ui.panel.close", { n: describe(el.querySelector?.("summary") ?? el, w.location)?.name ?? tagOf(el) });
  }), { capture: true, passive: true });

  // ------------------------------------------------------------------ dialogs (checked every 2 s and after each action)
  const openDialogs = new Map();
  const dialogs = safe(() => {
    const seen = new Set();
    for (const el of d.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')) {
      seen.add(el);
      if (openDialogs.has(el)) continue;
      const name = attr(el, "data-testid") || safeLabel(attr(el, "aria-label")) || safeLabel(d.getElementById(attr(el, "aria-labelledby") ?? "")?.textContent?.slice(0, 80) ?? "") || "dialog";
      openDialogs.set(el, { name, at: perf.now() });
      emit("ui.dialog.open", { n: scrub(name, 80) });
    }
    for (const [el, info] of openDialogs) if (!seen.has(el)) { openDialogs.delete(el); emit("ui.dialog.close", { n: scrub(info.name, 80), d: ms(perf.now() - info.at) }); }
  });

  // ------------------------------------------------------------------ scroll depth of the page's main scroller
  let scrollTarget = null, scrollTimer = 0;
  d.addEventListener("scroll", (e) => {
    scrollTarget = e.target;
    if (!scrollTimer) scrollTimer = setTimeout(safe(() => {
      scrollTimer = 0;
      const el = scrollTarget === d ? d.scrollingElement : scrollTarget;
      if (!el || el.scrollHeight <= el.clientHeight + 40 || el.clientHeight < w.innerHeight * 0.4) return;
      view.scroll = Math.max(view.scroll, Math.min(1, (el.scrollTop + el.clientHeight) / el.scrollHeight));
    }), 250);
  }, { capture: true, passive: true });

  // ------------------------------------------------------------------ API calls (and in-flight work during an action)
  const pendingSizes = new Map();
  const sampler = pollSampler();
  const pulseFetch = function pulseFetch(input, init) {
    let u = null, method = "GET";
    try {
      u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "", w.location.href);
      method = String(init?.method || (input && typeof input === "object" ? input.method : "") || "GET").toUpperCase();
    } catch { /* not ours to measure */ }
    if (!u || u.origin !== w.location.origin || u.pathname.startsWith(ENDPOINT)) return originalFetch(input, init);
    const action = active;
    const api = u.pathname.startsWith("/api/");
    if (!api) {
      const it = action;
      // Next fetching a page during an action: the screen is not settled until it arrives.
      if (!it) return originalFetch(input, init);
      it.inflight++;
      const key = `${method} ${screenOf(u.href)}${u.pathname.startsWith("/_next/") ? "" : u.searchParams.has("_rsc") ? " (page)" : ""}`;
      it.pending.add(key);
      const p = originalFetch(input, init);
      const done = () => { it.inflight--; it.pending.delete(key); it.changed = perf.now(); };
      p.then(done, done);
      return p;
    }
    const id = randomId(12);
    let next = init;
    if (typeof input === "string" || input instanceof URL) {
      try { const h = new Headers(init?.headers); if (!h.has(REQUEST_HEADER)) h.set(REQUEST_HEADER, id); next = { ...init, headers: h }; } catch { next = init; }
    }
    const start = perf.now(), screen = view.screen, key = `${method} ${pathTemplate(u.pathname)}`;
    // PERF: a background poll that happens to start during an action is not the action's work (a click "waited" for
    // the 2.5-second notification poll); a route seen polling on its own is left out of the action's wait.
    const it = action && !sampler.isPoll(key) ? action : null;
    if (it) { it.inflight++; it.api++; it.pending.add(key); }
    const sent = typeof init?.body === "string" ? init.body.length : undefined;
    const p = originalFetch(input, next);
    const record = safe((status, response, err) => {
      if (it) { it.inflight--; it.pending.delete(key); it.changed = perf.now(); }
      const len = Number(response?.headers?.get?.("content-length"));
      const ev = { t: at(start), n: `${method} ${pathTemplate(u.pathname + u.search)}`, p: screen, d: ms(perf.now() - start), r: next === init ? undefined : id,
        x: { ...(sent !== undefined ? { sent } : {}), ...(Number.isFinite(len) && len > 0 ? { bytes: len } : {}), ...(err ? { err } : {}), ...(it ? { during: it.kind } : {}) } };
      if (status !== null) ev.s = status;
      const keep = sampler(key, { during: !!it, status, ms: ev.d ?? 0 });
      if (!keep.keep) return;
      if (keep.sample) ev.x.sample = keep.sample;
      emit("api", ev);
      if (!ev.x.bytes) { pendingSizes.set(u.href, ev.x); if (pendingSizes.size > 50) pendingSizes.delete(pendingSizes.keys().next().value); }
    });
    p.then((r) => record(r.status, r, null), (e) => record(e?.name === "AbortError" ? null : 0, null, e?.name === "AbortError" ? "abort" : "network"));
    return p;
  };
  w.fetch = pulseFetch;

  // ------------------------------------------------------------------ live streams (PERF)
  const NativeSource = w.EventSource;
  if (typeof NativeSource === "function") {
    const PulseSource = function EventSource(url, init) {
      const es = new NativeSource(url, init);
      try {
        const start = perf.now(), n = `SSE ${pathTemplate(new URL(String(url), w.location.href).pathname)}`;
        es.addEventListener("open", safe(() => emit("perf.stream", { n, d: ms(perf.now() - start) })), { once: true });
        es.addEventListener("error", safe(() => { if (es.readyState === 2) emit("error.stream", { n }); }));
      } catch { /* not ours to measure */ }
      return es;
    };
    PulseSource.prototype = NativeSource.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSED"]) PulseSource[k] = NativeSource[k];
    w.EventSource = PulseSource;
  }

  // ------------------------------------------------------------------ web vitals and long tasks
  const observe = (type, fn, extra = {}) => { try { new PerformanceObserver(safe((list) => list.getEntries().forEach(fn))).observe({ type, buffered: true, ...extra }); } catch { /* unsupported */ } };
  let lcp = 0, lcpSent = false;
  const sendLcp = () => { if (!lcpSent && lcp > 0) { lcpSent = true; emit("vital.lcp", { t: at(0), n: loadScreen, p: loadScreen, d: ms(lcp) }); } };
  observe("largest-contentful-paint", (e) => { lcp = e.startTime; });
  observe("paint", (e) => { if (e.name === "first-contentful-paint") emit("vital.fcp", { t: at(0), n: loadScreen, p: loadScreen, d: ms(e.startTime) }); });
  observe("layout-shift", (e) => {
    if (e.hadRecentInput) return;
    if (view.clsWindow && e.startTime - view.clsLast < 1000 && e.startTime - view.clsFirst < 5000) view.clsWindow += e.value;
    else { view.clsWindow = e.value; view.clsFirst = e.startTime; }
    view.clsLast = e.startTime;
    view.cls = Math.max(view.cls, view.clsWindow);
  });
  observe("event", (e) => { if (e.interactionId) view.inp = Math.max(view.inp, e.duration); }, { durationThreshold: 40 });
  observe("longtask", (e) => {
    view.long++; view.longMs += e.duration;
    if (e.duration >= 150) emit("perf.longtask", { t: at(e.startTime), d: ms(e.duration), x: { busy: active ? active.kind : "idle" } });
  });
  observe("resource", (e) => {
    const x = pendingSizes.get(e.name);
    if (x && (e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest")) { pendingSizes.delete(e.name); if (e.encodedBodySize) x.bytes = e.encodedBodySize; x.full = ms(e.duration); }
  });
  for (const type of ["pointerdown", "keydown"]) d.addEventListener(type, () => sendLcp(), { capture: true, passive: true, once: true });

  // ------------------------------------------------------------------ errors
  let errors = 0;
  const recent = new Map();
  function error(source, err) {
    const msg = scrub(String(err?.message ?? err ?? "unknown").replace(/(["'`])[^"'`]{16,}\1/g, "$1…$1"), 160) ?? "unknown";
    const key = `${source}:${msg}`;
    if (errors >= 30 || Date.now() - (recent.get(key) ?? 0) < 10_000) return;
    errors++; recent.set(key, Date.now());
    const x = {};
    if (err?.digest) x.digest = scrub(String(err.digest), 40);
    emit(`error.${source}`, { n: msg, x: Object.keys(x).length ? x : undefined });
  }
  w.addEventListener("error", safe((e) => {
    if (e instanceof ErrorEvent || e.error || e.message) {
      error("js", e.error ?? e);
      return;
    }
    const el = e.target;
    const src = attr(el, "src") || attr(el, "href");
    if (src) emit("error.resource", { n: `${tagOf(el)} ${screenOf(src) ?? "?"}` });
  }), true);
  w.addEventListener("unhandledrejection", safe((e) => error("promise", e.reason)));

  // ------------------------------------------------------------------ connectivity, background, the phone app
  let offlineAt = 0, hiddenAt = 0;
  w.addEventListener("offline", safe(() => { offlineAt = perf.now(); emit("app.offline"); }));
  w.addEventListener("online", safe(() => { emit("app.online", { d: offlineAt ? ms(perf.now() - offlineAt) : undefined }); offlineAt = 0; void queue.flush(); }));
  const hide = safe(() => {
    if (hiddenAt) return;
    hiddenAt = perf.now();
    sendLcp();
    if (active) finish(active, "hidden");
    emit("app.background");
    endView();
    startView(w.location.href);
    void queue.flush(true);
  });
  d.addEventListener("visibilitychange", safe(() => {
    if (d.visibilityState === "hidden") hide();
    else if (hiddenAt) { emit("app.foreground", { d: ms(perf.now() - hiddenAt) }); hiddenAt = 0; startView(w.location.href); }
  }));
  w.addEventListener("pagehide", hide);
  try {
    const app = w.Capacitor?.isNativePlatform?.() ? w.Capacitor?.Plugins?.App : null;
    // appStateChange only: a backButton listener would switch off Android's own back navigation.
    void app?.addListener?.("appStateChange", safe((s) => emit(s?.isActive ? "app.resume" : "app.pause")))?.catch?.(() => {});
  } catch { /* no shell */ }

  // ------------------------------------------------------------------ the first page view, then the timers
  if (session.fresh) emit("app.session", { t: at(0), x: { vw: w.innerWidth, vh: w.innerHeight, dpr: w.devicePixelRatio, conn: w.navigator.connection?.effectiveType,
    mem: w.navigator.deviceMemory, cpu: w.navigator.hardwareConcurrency, lang: scrub(w.navigator.language, 12), tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })() } });
  begin("load", null, 0);
  // PERF: the edge round trip, once a session, after the first page has settled.
  if (session.fresh) setTimeout(safe(() => {
    const t0 = perf.now();
    originalFetch("/cdn-cgi/trace", { cache: "no-store", credentials: "omit" }).then((r) => (r.ok ? r.text() : ""))
      .then(safe((text) => { const edge = edgeOf(text); if (edge) emit("perf.edge", { n: edge.colo, d: ms(perf.now() - t0), x: edge.http ? { http: edge.http } : undefined }); }), () => {});
  }), 4000);
  setInterval(safe(() => { if (d.visibilityState === "visible") dialogs(); }), 2000);
  setInterval(safe(() => {
    const go = () => void queue.flush();
    if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 2000 }); else go();
  }), FLUSH_MS);
  me.queue = queue;
  // CALLS-V2: features that measure themselves (a call's setup time, why it failed) add their own events.
  me.emit = emit;
  return me;
}
